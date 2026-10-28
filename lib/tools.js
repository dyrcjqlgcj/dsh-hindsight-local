// 暴露给模型的工具。名字统一带 `hindsight_local_` 前缀，避免和云端版厂商插件撞名
// （两个都装时，模型能看出自己在跟哪一代打交道）。
import * as api from './api.js'
import { ensureServer, findServerExe, pidOnPort, probeHealth, stopServer, tailLog } from './daemon.js'
import { installHint } from './config.js'
import { bankIdFor } from './bank.js'

const output = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }]
}

const LIMIT = {
  type: 'integer',
  description: '最多返回多少条（默认 5）。',
  minimum: 1,
  maximum: 50
}

/** bank 在第一次 retain 之前并不存在，服务端会 404；对使用者来说这只是「还没有记忆」。 */
function friendly(error) {
  if (api.isEmptyBank(error)) return '这个 bank 还没有任何记忆（第一次写入后会自动建）。'
  return error?.message ?? String(error)
}

function settingsFor(exec, getSettings) {
  const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
  return { ...getSettings(cwd), cwd }
}

/**
 * 同上，但丢掉 cwd：给那些只需要连服务的工具用（start/stop/logs/status）。
 * 注意不能用 process.cwd()——DSH 进程的 cwd 是安装目录，算出来的 bank 会是 coding-agent::desktop。
 */
function settingsAt(exec, getSettings) {
  const { cwd, ...settings } = settingsFor(exec, getSettings)
  return settings
}

/** 服务没起来时，工具不该抛异常给用户看栈，而是给一段能照做的说明。 */
function offlineHint(settings, result) {
  const lines = [`本地 Hindsight 未就绪：${result.detail ?? 'unknown'}`]
  if (result.missingExe) lines.push('', installHint(settings))
  else if (result.missingKey) {
    lines.push(
      '',
      '没有找到 LLM API key（抽取记忆要用它）。三选一：',
      '  1. 插件配置里写 apiKey',
      '  2. 设环境变量 HINDSIGHT_API_LLM_API_KEY=sk-...',
      '  3. 写进 ' + settings.profileEnvFile
    )
  } else if (result.started) {
    lines.push('', `服务还在初始化，看日志：${settings.logFile}`)
  }
  return lines.join('\n')
}

async function withServer(settings, { waitMs } = {}) {
  const result = await ensureServer(settings, { waitMs })
  if (!result.ok) {
    const error = new Error(offlineHint(settings, result))
    error.offline = result
    throw error
  }
  return result
}

function formatRecall(body) {
  const results = body?.results ?? []
  if (!results.length) return '没有命中任何记忆。'
  const total = body?.total ?? results.length
  const lines = [total > results.length ? `命中 ${total} 条，显示前 ${results.length} 条：` : `命中 ${results.length} 条：`]
  for (const [index, item] of results.entries()) {
    const score = item.scores ? `  (final ${item.scores.final?.toFixed(3)})` : ''
    lines.push(`${index + 1}. [${item.type ?? 'fact'}] ${String(item.text ?? '').trim()}${score}`)
  }
  return lines.join('\n')
}

function formatPages(roots) {
  if (!roots.length) return '还没有知识页。'
  const lines = [`知识页 ${roots.length} 张：`]
  for (const page of roots) {
    const desc = page.description ? ` — ${String(page.description).slice(0, 120)}` : ''
    lines.push(`- ${page.id}  ${page.name}${desc}`)
  }
  return lines.join('\n')
}

export function registerTools(toolCtx, getSettings) {
  const register = (spec) => toolCtx.tools.register(spec)

  register({
    name: 'hindsight_local_status',
    description:
      '本机 Hindsight 记忆服务的状态：进程是否在跑、端口、bank、知识页数量、统计。排障时先看这个。',
    parameters: { type: 'object', properties: {} },
    output,
    async execute(_args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd()
      const settings = { ...getSettings(cwd), cwd }
      const bankId = bankIdFor(settings, cwd)
      const health = await probeHealth(settings)
      const exe = findServerExe(settings)
      const lines = [
        `服务：${health.ok ? 'UP' : 'DOWN'}  ${settings.apiUrl}`,
        `bank：${bankId}`,
        `可执行文件：${exe ?? '未找到（需要先按 README 准备 uv 缓存）'}`,
        `apiKey：${settings.apiKey ? '已配置' : '缺失'}`,
        `LLM：${settings.llmProvider} / ${settings.llmModel}${settings.llmBaseUrl ? ` @ ${settings.llmBaseUrl}` : ''}`,
        `profile：${settings.profile}（${settings.profileEnvFile}）`,
        `日志：${settings.logFile}`
      ]
      if (health.ok) {
        try {
          const [pages, bank] = await Promise.all([api.tree(settings, bankId), api.stats(settings, bankId)])
          lines.push(`知识页：${pages.length} 张`)
          if (bank && typeof bank === 'object') {
            const knobs = ['total_nodes', 'total_documents', 'pending_operations', 'failed_operations']
              .filter((key) => bank[key] !== undefined)
              .map((key) => `${key}=${bank[key]}`)
            if (knobs.length) lines.push(`统计：${knobs.join('  ')}`)
          }
        } catch (error) {
          lines.push(api.isEmptyBank(error) ? '知识页：0 张（bank 还没有建立，写入一次记忆后会出现）' : `读取知识页/统计失败：${error?.message ?? error}`)
        }
      }
      return lines.join('\n')
    }
  })

  register({
    name: 'hindsight_local_start',
    description: '确保本机 Hindsight 服务在运行；没在跑就用缓存里的 server 拉起来（可能要等 1-3 分钟）。',
    parameters: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'integer', description: '最多等多久就绪，默认 240。', minimum: 10, maximum: 900 }
      }
    },
    output,
    async execute(args, exec) {
      const settings = settingsAt(exec, getSettings)
      const waitMs = Number(args?.wait_seconds ?? 0) > 0 ? Number(args.wait_seconds) * 1000 : settings.readyTimeoutMs
      const result = await ensureServer(settings, { waitMs })
      if (!result.ok) return offlineHint(settings, result)
      return `服务就绪 ${settings.apiUrl}（${result.started ? `本次启动，用时 ${Math.round((result.elapsedMs ?? 0) / 1000)}s` : '原本就在跑'}）`
    }
  })

  register({
    name: 'hindsight_local_stop',
    description: '停掉本机 Hindsight 服务（按端口找监听进程后结束）。',
    parameters: { type: 'object', properties: {} },
    output,
    async execute(_args, exec) {
      const settings = settingsAt(exec, getSettings)
      const pid = pidOnPort(settings)
      const result = stopServer(settings)
      return result.stopped ? `${result.detail}（端口 ${settings.port}）` : result.detail
    }
  })

  register({
    name: 'hindsight_local_logs',
    description: '看服务日志尾部。启动慢、抽取失败、LLM 报错都写在这里。',
    parameters: {
      type: 'object',
      properties: { lines: { type: 'integer', description: '看最后多少行，默认 40。', minimum: 5, maximum: 400 } }
    },
    output,
    async execute(args, exec) {
      const settings = settingsAt(exec, getSettings)
      return tailLog(settings, Number(args?.lines ?? 0) > 0 ? Number(args.lines) : 40)
    }
  })

  register({
    name: 'hindsight_local_search',
    description: '搜本项目的知识页（架构、约定、关键决策那几张长期文档）。问「这个模块为什么这样」先用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，自然语言即可。' },
        limit: LIMIT
      },
      required: ['query']
    },
    output,
    async execute(args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        const bankId = bankIdFor(settings, cwd)
        const hits = await api.searchPages(settings, bankId, String(args.query), Number(args.limit ?? 5))
        if (!hits.length) return '没有命中知识页。'
        const lines = [`命中 ${hits.length} 张页：`]
        for (const hit of hits) {
          lines.push(`- ${hit.id}  ${hit.name ?? hit.title ?? ''}`)
          if (hit.snippet || hit.summary || hit.description) {
            lines.push(`  ${String(hit.snippet ?? hit.summary ?? hit.description).slice(0, 300).replace(/\s+/g, ' ')}`)
          }
        }
        lines.push('', '用 hindsight_local_read 读全文。')
        return lines.join('\n')
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })

  register({
    name: 'hindsight_local_read',
    description: '读一张知识页的全文。page_id 从 hindsight_local_search / hindsight_local_status 拿。',
    parameters: {
      type: 'object',
      properties: { page_id: { type: 'string', description: '知识页 id，形如 kp-xxxx。' } },
      required: ['page_id']
    },
    output,
    async execute(args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        const page = await api.readPage(settings, bankIdFor(settings, cwd), String(args.page_id))
        const title = page?.name ?? page?.title ?? args.page_id
        const body = page?.body ?? page?.markdown ?? page?.content ?? ''
        return `# ${title}\n\n${body || '（这张页是空的）'}`
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })

  register({
    name: 'hindsight_local_recall',
    description: '按问题检索原始记忆事实（每次会话自动抽取进去的那些）。比知识页更细、更贴近具体事件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找什么。' },
        limit: LIMIT
      },
      required: ['query']
    },
    output,
    async execute(args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        const body = await api.recall(settings, bankIdFor(settings, cwd), String(args.query), Number(args.limit ?? 5))
        return formatRecall(body)
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })

  register({
    name: 'hindsight_local_remember',
    description: '把一段事实写进本项目记忆（会由 LLM 抽取成结构化事实，几秒后可用 recall 查到）。',
    parameters: {
      type: 'object',
      properties: { content: { type: 'string', description: '要记住的事实，写清楚实体与结论。' } },
      required: ['content']
    },
    output,
    async execute(args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        const body = await api.retain(settings, bankIdFor(settings, cwd), String(args.content))
        const usage = body?.usage ?? {}
        return `已写入（items=${body?.items_count ?? '?'}，tokens=${usage.total_tokens ?? '?'}）。`
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })

  register({
    name: 'hindsight_local_reflect',
    description: '让记忆服务就一个「为什么」做多步推理，返回综合结论。比 recall 慢，但能跨多条事实回答。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '要推理的问题。' } },
      required: ['query']
    },
    output,
    async execute(args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        const body = await api.reflect(settings, bankIdFor(settings, cwd), String(args.query))
        return body?.answer ?? body?.response ?? body?.text ?? JSON.stringify(body).slice(0, 4000)
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })

  register({
    name: 'hindsight_local_pages',
    description: '列出本项目的全部知识页（id + 名字 + 一句描述）。',
    parameters: { type: 'object', properties: {} },
    output,
    async execute(_args, exec) {
      const { cwd, ...settings } = settingsFor(exec, getSettings)
      try {
        await withServer(settings)
        return formatPages(await api.tree(settings, bankIdFor(settings, cwd)))
      } catch (error) {
        return error?.message ?? String(error)
      }
    }
  })
}
