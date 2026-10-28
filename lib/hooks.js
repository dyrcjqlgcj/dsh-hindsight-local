// 会话钩子：启动时确保服务、首步注入「知识页索引 + 上次进度」、一轮结束回写、
// 会话结束时写一份收尾快照。
//
// 为什么要有「收尾快照」：交接文档（整段会话导出）里真正不可替代的东西不是过程，
// 而是「上次停在哪、下一步做什么」。知识页记的是项目长期结论，记不住这个；
// 所以每个会话结束写一条快照进同一个 document，下次开新会话时按「上次进度」注入。
//
// 四个原则：
// 1. 钩子永远不能把会话卡死——所有远程调用都有超时，失败只记日志。
// 2. 子会话（subagent）不注入也不回写，否则一次任务会把记忆灌成几十份。
// 3. 注入只做一次（每个会话），内容是「有哪些页 + 怎么查 + 上次进度」，不是页全文。
//    DSH 自己的 compaction 已经会压缩历史，再塞全文只会互相挤占。
// 4. 同一个会话的所有写入共用一个 document_id，服务端按 document 归组，
//    这样「这场会话」在记忆里是一份完整文档，而不是散落的几十条碎片。
import { randomUUID } from 'node:crypto'
import * as defaultApi from './api.js'
import { ensureServer } from './daemon.js'
import { bankIdFor } from './bank.js'

const INJECT_TIMEOUT_MS = 7000
const RETAIN_MAX_CHARS = 6000
const RETAIN_TIMEOUT_MS = 180000
/** 注入里「上次进度」最多带几条事实、每条截多长。 */
const PROGRESS_FACTS = 3
const PROGRESS_FACT_CHARS = 220

export function pluginSource(name) {
  return `plugin:${name}`
}

export function injectionMessage(text, name) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: pluginSource(name), form: 'recall' }
  }
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function sessionEvents(session) {
  return session.snapshotEvents?.() ?? session.events ?? []
}

/** 从会话事件里取最后多少条像样的对话（跳过工具噪音与注入消息）。 */
function recentTurns(session, limit = 6) {
  const turns = []
  for (const event of sessionEvents(session)) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      const message = event.data
      if (message?.source?.kind !== 'user') continue
      const text = textOf(message)
      if (text) turns.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message)
      if (text) turns.push({ role: 'assistant', text })
    }
  }
  return turns.slice(-limit)
}

/** 整场会话的骨架：第一条诉求 + 全部用户诉求 + 最后一条结论。 */
function sessionSkeleton(session, maxRequests = 8) {
  const requests = []
  let lastAssistant = ''
  for (const event of sessionEvents(session)) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const text = textOf(event.data)
      if (text) requests.push(text)
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message)
      if (text) lastAssistant = text
    }
  }
  return { requests: requests.slice(-maxRequests), lastAssistant }
}

function clip(text, max) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}\n…（截断）` : value
}

function transcriptText(turns) {
  const body = turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n')
  return clip(body, RETAIN_MAX_CHARS)
}

/** 同一个会话共用一个 document，服务端按它归组。 */
export function documentIdFor(sessionId) {
  return `dsh-session:${sessionId}`
}

export function snapshotText({ sessionId, cwd, requests, lastAssistant, at = new Date(), maxChars = 1500 }) {
  const lines = [
    `会话收尾快照（${at.toISOString()}）`,
    `项目：${cwd ?? '(未知)'}`,
    `会话：${sessionId}`,
    '',
    '本次诉求：'
  ]
  if (requests?.length) for (const item of requests) lines.push(`- ${clip(item, 400)}`)
  else lines.push('- （本次没有记录到用户消息）')
  lines.push('', '最后结论：')
  lines.push(lastAssistant ? clip(lastAssistant, 800) : '（会话结束时没有留下结论文本）')
  return clip(lines.join('\n'), maxChars)
}

export function createHooks({ name, getSettings, log, api = defaultApi, now = () => new Date() }) {
  const injected = new Map()
  const warming = new Map()

  /** 同一进程里多个会话同时启动时，只拉一次服务。 */
  function warmUp(settings, sessionId) {
    if (warming.has(sessionId)) return warming.get(sessionId)
    const task = withTimeout(ensureServer(settings, { waitMs: 20000 }), 25000)
      .then((result) => {
        if (!result?.ok) log.debug(`本地服务未就绪：${result?.detail ?? 'timeout'}`)
        return result
      })
      .catch((error) => log.debug(`本地服务启动失败：${error?.message ?? error}`))
    warming.set(sessionId, task)
    return task
  }

  /** 「上次停在哪」：查收尾快照抽出来的事实，注入时放在知识页索引下面。 */
  async function recentProgress(settings, bankId) {
    const hits = await withTimeout(
      api.recall(settings, bankId, '上次会话做到哪一步，下一步要做什么', { maxTokens: 700 }),
      INJECT_TIMEOUT_MS
    )
    const results = hits?.results ?? []
    const seen = new Set()
    const facts = []
    for (const hit of results) {
      const text = String(hit?.text ?? '').trim()
      if (!text || seen.has(text)) continue
      seen.add(text)
      facts.push(clip(text.replace(/\s+/g, ' '), PROGRESS_FACT_CHARS))
      if (facts.length >= PROGRESS_FACTS) break
    }
    return facts
  }

  async function buildInjection(settings, cwd, prompt) {
    const bankId = bankIdFor(settings, cwd)
    let pages
    try {
      pages = await api.tree(settings, bankId)
    } catch (error) {
      // 新 repo 的 bank 还不存在：没什么可注入的，安静跳过
      if (api.isEmptyBank(error)) return null
      throw error
    }
    if (!pages.length) return null

    const lines = [
      '<hindsight-local-memory>',
      '本机 Hindsight 记忆服务里存了这个项目的长期知识页（由 git 历史与会话沉淀而成）。',
      '需要判断「为什么这样写」或找历史决策时，先用工具查，再下结论：',
      '  hindsight_local_search { query } → 命中页 id',
      '  hindsight_local_read { page_id } → 读全文',
      ...pages.slice(0, 8).map((page) => `  - ${page.id}  ${page.name}`)
    ]

    // 上次会话停在哪：这是交接文档里最不可替代的那部分，用快照顶上
    try {
      const facts = await recentProgress(settings, bankId)
      if (facts.length) {
        lines.push('', '上次停下的地方（来自上一场会话的收尾快照，先当背景，需要时再核对）：')
        for (const fact of facts) lines.push(`  - ${fact}`)
      }
    } catch (error) {
      log.debug(`读取上次进度失败：${error?.message ?? error}`)
    }

    if (prompt) {
      const hits = await withTimeout(api.recall(settings, bankId, prompt, settings.recallLimit), INJECT_TIMEOUT_MS)
      const facts = (hits?.results ?? []).slice(0, settings.recallLimit)
      if (facts.length) {
        lines.push('', '这次的问题可能相关的历史事实：')
        for (const fact of facts) lines.push(`  - ${String(fact.text ?? '').trim()}`)
      }
    }
    lines.push('</hindsight-local-memory>')
    const text = lines.join('\n')
    return text.length > settings.injectMaxChars ? `${text.slice(0, settings.injectMaxChars)}\n…（已截断）` : text
  }

  async function retainSafe(settings, bankId, content, extra) {
    try {
      await withTimeout(api.retain(settings, bankId, content, { timeoutMs: RETAIN_TIMEOUT_MS, ...extra }), RETAIN_TIMEOUT_MS)
      return true
    } catch (error) {
      log.debug(`回写失败：${error?.message ?? error}`)
      return false
    }
  }

  return {
    sessionStart({ agent }) {
      const header = agent?.session?.header
      if (!header || header.origin === 'subagent') return
      const settings = getSettings(header.cwd)
      if (!settings.enabled) return
      void warmUp(settings, header.id)
    },

    async preStep({ agent, signal }, next) {
      const decision = await next()
      if (decision?.kind !== 'enter' || signal?.aborted) return decision

      const header = agent?.session?.header
      if (!header || header.origin === 'subagent') return decision
      const settings = getSettings(header.cwd)
      if (!settings.enabled || !settings.injectPages) return decision

      const prompt = (decision.messages ?? [])
        .filter((message) => message?.source?.kind === 'user')
        .map(textOf)
        .join('\n')
        .trim()
        .slice(0, 500)

      const key = `${header.id}`
      const text = await withTimeout(buildInjection(settings, header.cwd, prompt), INJECT_TIMEOUT_MS).catch((error) => {
        log.debug(`注入失败：${error?.message ?? error}`)
        return null
      })
      if (!text || injected.get(key) === text) return decision
      injected.set(key, text)
      log.debug(`注入知识页索引与上次进度（${text.length} 字符）`)
      return { kind: 'enter', messages: [...decision.messages, injectionMessage(text, name)] }
    },

    /** 一轮结束：把最近几条对话追加进本会话的 document。 */
    async turnStopping({ agent }) {
      const header = agent?.session?.header
      if (!header || header.origin === 'subagent') return
      const settings = getSettings(header.cwd)
      if (!settings.enabled || !settings.retainOnIdle) return

      const turns = recentTurns(agent.session)
      if (turns.length < 2) return
      const content = `会话片段（${header.cwd}）：\n\n${transcriptText(turns)}`
      const ok = await retainSafe(settings, bankIdFor(settings, header.cwd), content, {
        documentId: documentIdFor(header.id),
        tags: ['dsh-session', 'dsh-session-turn']
      })
      if (ok) log.debug(`回写 ${turns.length} 条对话`)
    },

    /**
     * 会话结束：写一份收尾快照（诉求 + 最后结论）。
     * 这份快照就是「交接文档」的替代物：下次开新会话，注入里会带「上次停下的地方」。
     */
    async disposed({ agent }) {
      const header = agent?.session?.header
      const id = header?.id
      if (!id) return
      try {
        if (header.origin !== 'subagent') {
          const settings = getSettings(header.cwd)
          if (settings.enabled && settings.retainOnIdle && settings.handoffSnapshot) {
            const { requests, lastAssistant } = sessionSkeleton(agent.session)
            const content = snapshotText({
              sessionId: id,
              cwd: header.cwd,
              requests,
              lastAssistant,
              at: now(),
              maxChars: settings.snapshotMaxChars
            })
            const ok = await retainSafe(settings, bankIdFor(settings, header.cwd), content, {
              documentId: documentIdFor(id),
              tags: ['dsh-session', 'dsh-session-handoff']
            })
            if (ok) log.debug(`写入会话收尾快照（${content.length} 字符）`)
          }
        }
      } catch (error) {
        log.debug(`写收尾快照失败：${error?.message ?? error}`)
      } finally {
        injected.delete(id)
        warming.delete(id)
      }
    }
  }
}
