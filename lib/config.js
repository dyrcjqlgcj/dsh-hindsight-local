// 配置解析：cordis config → 环境变量 → ~/.hindsight/profiles/<profile>.env → 内置默认值
//
// 设计原则：插件不往 ~/.hindsight 里写"自己的"配置文件，也不改厂商插件的
// coding-agent.json。它读已有的东西，缺什么就在提示里告诉用户怎么补。
import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'

/** 所有可调项都在这里，schema 与它一一对应（见 index.js 的 Config）。 */
export const DEFAULTS = {
  enabled: true,
  apiUrl: 'http://127.0.0.1:9077',
  autoStart: true,
  profile: 'coding-agent',
  apiKey: '',
  llmProvider: '',
  llmModel: '',
  llmBaseUrl: '',
  bankId: '',
  bankTemplate: 'coding-agent::{project}',
  injectPages: true,
  recallLimit: 5,
  injectMaxChars: 4000,
  retainOnIdle: true,
  handoffSnapshot: true,
  snapshotMaxChars: 1500,
  dataDir: '',
  offlineModels: true,
  readyTimeoutMs: 240000,
  requestTimeoutMs: 20000
}

const PROVIDER_DEFAULTS = {
  deepseek: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { model: 'claude-3-5-haiku-latest', baseUrl: 'https://api.anthropic.com/v1' },
  ollama: { model: 'llama3.1', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { model: 'local-model', baseUrl: 'http://127.0.0.1:1234/v1' }
}

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

export function hindsightHome() {
  return process.env.HINDSIGHT_HOME || join(homeDir(), '.hindsight')
}

/** 展开 ~ 前缀，返回绝对路径；空字符串原样返回（表示"用服务自己的默认位置"）。 */
export function expandPath(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return ''
  if (raw === '~') return homeDir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(homeDir(), raw.slice(2)))
  return resolve(raw)
}

/**
 * 服务默认把三样东西放在用户目录下：
 *   ~/.pg0                         嵌入式 PostgreSQL（安装 + 数据）
 *   ~/.cache/huggingface           嵌入/重排模型
 *   %LOCALAPPDATA%/uv/cache        uv 缓存（server 可执行文件就在里面）
 * 配置了 dataDir 后，后两个改走配置目录；pg0 由 pg0.exe 自己决定位置，
 * 只能用目录联接（junction）搬走 —— 见 scripts/relocate.mjs。
 */
export function defaultDataDirs() {
  const localAppData = process.env.LOCALAPPDATA || join(homeDir(), 'AppData', 'Local')
  return {
    // 三个都能用环境变量覆盖：位置非标准的人（或脚本自测）不必改代码
    pg0: expandPath(process.env.HINDSIGHT_PG0_DIR || join(homeDir(), '.pg0')),
    huggingface: expandPath(process.env.HINDSIGHT_HF_DIR || join(homeDir(), '.cache', 'huggingface')),
    uvCache: expandPath(process.env.HINDSIGHT_UV_DIR || join(localAppData, 'uv', 'cache'))
  }
}

/** 读 KEY=VALUE 形式的 profile 文件，忽略注释与空行（与 hindsight-embed 同格式）。 */
export function readProfileEnv(profile) {
  const file = join(hindsightHome(), 'profiles', `${profile}.env`)
  const env = {}
  if (!existsSync(file)) return env
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) env[m[1]] = m[2]
    }
  } catch {
    // 读不到就当没有：缺的键会退回默认值，并在 status 工具里说明。
  }
  return env
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

function inferProvider(key, baseUrl) {
  if (baseUrl.includes('deepseek')) return 'deepseek'
  if (baseUrl.includes('anthropic')) return 'anthropic'
  if (baseUrl.includes('openai')) return 'openai'
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('sk-')) return 'deepseek'
  return 'deepseek'
}

function portOf(apiUrl) {
  try {
    const port = Number(new URL(apiUrl).port)
    return Number.isFinite(port) && port > 0 ? port : 9077
  } catch {
    return 9077
  }
}

/**
 * 把原始 config 解析成运行时设置。pure function（除了读 profile env 文件），
 * 便于测试与在 status 工具里重复调用。
 */
export function resolveSettings(raw = {}) {
  const cfg = { ...DEFAULTS, ...stripUndefined(raw) }
  const profileEnv = readProfileEnv(cfg.profile)

  const apiKey = firstNonEmpty(
    cfg.apiKey,
    process.env.HINDSIGHT_API_LLM_API_KEY,
    profileEnv.HINDSIGHT_API_LLM_API_KEY,
    process.env.DEEPSEEK_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY
  )

  const baseUrlGuess = firstNonEmpty(
    cfg.llmBaseUrl,
    process.env.HINDSIGHT_API_LLM_BASE_URL,
    profileEnv.HINDSIGHT_API_LLM_BASE_URL
  )

  const llmProvider = firstNonEmpty(
    cfg.llmProvider,
    process.env.HINDSIGHT_API_LLM_PROVIDER,
    profileEnv.HINDSIGHT_API_LLM_PROVIDER
  ) || inferProvider(apiKey, baseUrlGuess)

  const providerDefaults = PROVIDER_DEFAULTS[llmProvider] ?? PROVIDER_DEFAULTS.deepseek
  const llmModel = firstNonEmpty(
    cfg.llmModel,
    process.env.HINDSIGHT_API_LLM_MODEL,
    profileEnv.HINDSIGHT_API_LLM_MODEL,
    providerDefaults.model
  )
  const llmBaseUrl = firstNonEmpty(baseUrlGuess, providerDefaults.baseUrl)

  const apiUrl = firstNonEmpty(cfg.apiUrl, `http://127.0.0.1:${portOf(cfg.apiUrl)}`).replace(/\/+$/, '')

  // dataDir 为空表示沿用服务自己的默认位置（~/.pg0、~/.cache/huggingface、uv 缓存）
  const dataRoot = expandPath(cfg.dataDir)

  return {
    ...cfg,
    apiUrl,
    port: portOf(apiUrl),
    apiKey,
    llmProvider,
    llmModel,
    llmBaseUrl,
    profileEnv,
    dataRoot,
    uvCacheDir: dataRoot ? join(dataRoot, 'uv-cache') : '',
    hfHome: dataRoot ? join(dataRoot, 'huggingface') : '',
    caBundle: join(hindsightHome(), 'winroot.pem'),
    logFile: join(hindsightHome(), `daemon-${cfg.profile}.log`),
    profileEnvFile: join(hindsightHome(), 'profiles', `${cfg.profile}.env`),
    isWindows: platform() === 'win32'
  }
}

function stripUndefined(raw) {
  const out = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** 服务缺失时给用户看的、可以整段复制去跑的命令。 */
export function installHint(settings) {
  const env = `HINDSIGHT_API_LLM_PROVIDER=${settings.llmProvider}`
  return [
    '本地 Hindsight 服务没有在运行，而 autoStart 找不到可以启动的程序。',
    '',
    '一次性准备（需要 uv：https://docs.astral.sh/uv/）：',
    '  uvx --from hindsight-embed@latest hindsight-embed profile create ' + settings.profile + ' \\',
    `    --port ${settings.port} --env ${env} \\`,
    `    --env HINDSIGHT_API_LLM_MODEL=${settings.llmModel} \\`,
    `    --env HINDSIGHT_API_LLM_BASE_URL=${settings.llmBaseUrl}`,
    '',
    '把 API key 写进 profile（或直接设成环境变量 HINDSIGHT_API_LLM_API_KEY）：',
    `  ${join(hindsightHome(), 'profiles', `${settings.profile}.env`)}`,
    '  HINDSIGHT_API_LLM_API_KEY=sk-...',
    '',
    '也可以完全跳过插件，手动起服务：',
    '  uvx --from hindsight-embed@latest hindsight-embed -p ' + settings.profile + ' daemon start'
  ].join('\n')
}
