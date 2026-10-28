// 会话钩子：启动时确保服务、首步注入知识页索引、空闲时回写这一轮的对话。
//
// 三个原则：
// 1. 钩子永远不能把会话卡死——所有远程调用都有超时，失败只记日志。
// 2. 子会话（subagent）不注入也不回写，否则一次任务会把记忆灌成几十份。
// 3. 注入只做一次（每个会话），内容是「有哪些页 + 怎么查」，不是页全文。
//    DSH 自己的 compaction 已经会压缩历史，再塞全文只会互相挤占。
import { randomUUID } from 'node:crypto'
import * as api from './api.js'
import { ensureServer } from './daemon.js'
import { bankIdFor } from './bank.js'

const INJECT_TIMEOUT_MS = 7000
const RETAIN_MAX_CHARS = 6000

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

function transcriptText(turns) {
  const body = turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n')
  return body.length > RETAIN_MAX_CHARS ? `${body.slice(0, RETAIN_MAX_CHARS)}\n…（截断）` : body
}

export function createHooks({ name, getSettings, log }) {
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
      log.debug(`注入知识页索引（${text.length} 字符）`)
      return { kind: 'enter', messages: [...decision.messages, injectionMessage(text, name)] }
    },

    async turnStopping({ agent }) {
      const header = agent?.session?.header
      if (!header || header.origin === 'subagent') return
      const settings = getSettings(header.cwd)
      if (!settings.enabled || !settings.retainOnIdle) return

      const turns = recentTurns(agent.session)
      if (turns.length < 2) return
      const content = `会话片段（${header.cwd}）：\n\n${transcriptText(turns)}`
      try {
        await withTimeout(api.retain(settings, bankIdFor(settings, header.cwd), content), 180000)
        log.debug(`回写 ${turns.length} 条对话`)
      } catch (error) {
        log.debug(`回写失败：${error?.message ?? error}`)
      }
    },

    disposed({ agent }) {
      const id = agent?.session?.header?.id
      if (!id) return
      injected.delete(id)
      warming.delete(id)
    }
  }
}
