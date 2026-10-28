import { resolveSettings, DEFAULTS } from './lib/config.js'
import { registerTools } from './lib/tools.js'
import { createHooks } from './lib/hooks.js'

/**
 * 本地 Hindsight：把「记忆服务」这一层从云端搬到本机。
 *
 * 它做三件事：
 * - 起/停本机 Hindsight 服务（uv 缓存里已有 server，插件只负责拉起与探活）
 * - 注册一套 `hindsight_local_*` 工具，让模型能查知识页、检索事实、写入记忆
 * - 会话开始时注入「有哪些知识页」，会话空闲时把这一轮对话回写进 bank
 *
 * 刻意不做的事：不往 ~/.hindsight 里写自己的配置（读 profile env 就够了），
 * 不自动 uvx 装包（安装是一次性的重操作，交给用户复制命令），不改厂商插件的行为。
 */
export const name = 'hindsight-local'
/** 只用 agents 服务：工具与钩子都挂在它下面。 */
export const inject = ['agents']

const FIELDS = {
  enabled: { type: 'boolean', meta: { default: true, description: '启用本地 Hindsight 记忆（关掉等于不加载这个插件）' } },
  apiUrl: { type: 'string', meta: { default: DEFAULTS.apiUrl, description: '本地服务地址；端口要和 profile 里的 HINDSIGHT_API_PORT 一致' } },
  autoStart: { type: 'boolean', meta: { default: true, description: '服务没在跑时自动拉起（用 uv 缓存里的 server）' } },
  profile: { type: 'string', meta: { default: 'coding-agent', description: 'hindsight-embed 的 profile 名，决定读哪个 .env 与日志文件' } },
  apiKey: { type: 'string', meta: { default: '', description: '抽取记忆用的 LLM key；留空则读环境变量或 profile env' } },
  llmProvider: { type: 'string', meta: { default: '', description: 'deepseek / openai / anthropic / ollama…；留空按 key 与 baseUrl 推断' } },
  llmModel: { type: 'string', meta: { default: '', description: '抽取模型；留空用 provider 的默认值' } },
  llmBaseUrl: { type: 'string', meta: { default: '', description: '自建或代理网关时填；留空用 provider 默认' } },
  bankId: { type: 'string', meta: { default: '', description: '固定 bank id；留空按 bankTemplate 生成' } },
  bankTemplate: { type: 'string', meta: { default: DEFAULTS.bankTemplate, description: 'bank 命名模板，{project} 会替换成工作目录名' } },
  injectPages: { type: 'boolean', meta: { default: true, description: '会话首步注入知识页索引（关掉则只在需要时用工具查）' } },
  recallLimit: { type: 'integer', meta: { default: 5, description: '注入/检索时最多带几条事实' } },
  injectMaxChars: { type: 'integer', meta: { default: 4000, description: '注入内容的最大字符数' } },
  retainOnIdle: { type: 'boolean', meta: { default: true, description: '一轮结束时把对话回写进记忆（会消耗一次 LLM 抽取）' } },
  readyTimeoutMs: { type: 'integer', meta: { default: 240000, description: '等本机服务就绪的最长时间（毫秒）' } },
  requestTimeoutMs: { type: 'integer', meta: { default: 20000, description: '普通 HTTP 请求超时（毫秒）' } }
}

/**
 * 配置校验：任何读不懂的值都退回默认值而不是抛错。
 * 启动期抛错会被桌面端当成致命错误，宁可少一个功能也不能让 app 起不来。
 */
export const Config = {
  type: 'object', // ui-copy-ignore
  dict: FIELDS, // ui-copy-ignore
  meta: { default: {} }, // ui-copy-ignore
  '~standard': {
    version: 1, // ui-copy-ignore
    vendor: 'hindsight-local', // ui-copy-ignore
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      return { value: normalize(source) }
    }
  }
}

function normalize(source) {
  const out = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    const raw = source[key]
    const fallback = field.meta.default
    if (raw === undefined || raw === null || raw === '') {
      out[key] = fallback
      continue
    }
    if (field.type === 'boolean') {
      out[key] = raw === true || raw === 'true'
      continue
    }
    if (field.type === 'integer') {
      const num = Number(raw)
      out[key] = Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback
      continue
    }
    out[key] = String(raw).trim() || fallback
  }
  return out
}

export function apply(ctx, config) {
  const resolved = normalize(config ?? {})
  if (!resolved.enabled) return

  const logger = ctx.logger ?? console
  const log = {
    debug: (line) => safeLog(logger, 'debug', line),
    info: (line) => safeLog(logger, 'info', line),
    warn: (line) => safeLog(logger, 'warn', line)
  }

  // 解析结果按工作目录缓存：一个进程里可能同时开着几个不同 repo 的会话
  const cache = new Map()
  const getSettings = (cwd) => {
    const key = cwd || process.cwd()
    if (!cache.has(key)) {
      try {
        cache.set(key, resolveSettings(resolved))
      } catch (error) {
        log.warn(`读取 Hindsight 配置失败，用默认值：${error?.message ?? error}`)
        cache.set(key, resolveSettings({ ...resolved, apiKey: resolved.apiKey }))
      }
    }
    return cache.get(key)
  }

  try {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        registerTools(toolCtx, getSettings)
      } catch (error) {
        log.warn(`注册工具失败：${error?.message ?? error}`)
      }
    })
  } catch (error) {
    log.warn(`注入 tools 服务失败：${error?.message ?? error}`)
  }

  const hooks = createHooks({ name, getSettings, log })
  ctx.on('agent/session-start', hooks.sessionStart)
  ctx.on('agent/pre-step', hooks.preStep, { prepend: true })
  ctx.on('agent/turn-stopping', hooks.turnStopping)
  ctx.on('agent/disposed', hooks.disposed)

  const settings = getSettings(process.cwd())
  log.info(`本地 Hindsight 已加载：${settings.apiUrl}（bank ${settings.bankTemplate}）`)
}

function safeLog(logger, level, line) {
  try {
    const fn = logger?.[level] ?? logger?.info ?? logger?.log
    if (typeof fn === 'function') fn.call(logger, `[hindsight-local] ${line}`)
  } catch {
    // 日志失败绝不能影响调用方
  }
}
