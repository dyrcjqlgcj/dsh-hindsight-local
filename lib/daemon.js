// 本地 Hindsight 服务的生命周期：找可执行文件、探测 /health、需要时拉起、停掉、读日志。
//
// 不调用 `uvx hindsight-embed daemon start`：那层包装的就绪窗口固定 180 秒，
// 而首次启动要装依赖 + 加载 bge-small 嵌入与 cross-encoder 重排模型，常常 3-5 分钟，
// 于是命令误报超时、进程其实还在初始化。这里直接拉起 uv 缓存里的 server，自己轮询。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function uvCacheRoot() {
  const base = process.env.LOCALAPPDATA || join(process.env.HOME || process.env.USERPROFILE || '', 'AppData', 'Local')
  return join(base, 'uv', 'cache', 'archive-v0')
}

/** 可能放着 server 的 uv 缓存目录（配置的 dataDir 优先，其次系统默认）。 */
function uvCacheRoots(settings) {
  const roots = []
  if (settings?.uvCacheDir) roots.push(join(settings.uvCacheDir, 'archive-v0'))
  roots.push(uvCacheRoot())
  return [...new Set(roots)]
}

/**
 * 在 uv 缓存里挑一个最新的 server 可执行文件。
 * 同一个包可能被解析进多个 archive-v0 目录，按 mtime 取新；同时要求同目录里
 * 真的有 hindsight_api 包，避免把半截安装当成可用的。
 */
export function findServerExe(settings) {
  const roots = []
  if (settings.isWindows) {
    roots.push({ exe: ['Scripts', 'hindsight-api.exe'], pkg: ['Lib', 'site-packages', 'hindsight_api', 'main.py'] })
  } else {
    roots.push({ exe: ['bin', 'hindsight-api'], pkg: ['lib', 'python3', 'site-packages', 'hindsight_api', 'main.py'] })
    roots.push({ exe: ['bin', 'hindsight-api'], pkg: ['Lib', 'site-packages', 'hindsight_api', 'main.py'] })
  }
  const candidates = []
  for (const cacheRoot of uvCacheRoots(settings)) {
    if (!existsSync(cacheRoot)) continue
    for (const entry of readdirSync(cacheRoot)) {
      for (const shape of roots) {
        const exe = join(cacheRoot, entry, ...shape.exe)
        if (!existsSync(exe)) continue
        // POSIX 的 site-packages 可能带 pythonX.Y，用一级通配兜住
        const pkgDir = join(cacheRoot, entry, ...shape.pkg.slice(0, -1))
        const ok = shape.pkg[0] === 'lib'
          ? existsSync(pkgDir) || existsSync(join(cacheRoot, entry, shape.pkg[0]))
          : existsSync(join(cacheRoot, entry, ...shape.pkg))
        if (ok) candidates.push({ exe, mtime: safeMtime(exe) })
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0]?.exe ?? null
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export async function probeHealth(settings, timeoutMs = 4000) {
  try {
    const res = await fetch(`${settings.apiUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, status: res.status }
    return { ok: true, body: await res.json().catch(() => ({})) }
  } catch (error) {
    return { ok: false, error: error?.name ?? 'Error' }
  }
}

/** 启动子进程用的环境：profile 里的变量 + 首次启动必需的三类兜底。 */
export function buildServerEnv(settings) {
  const env = { ...process.env, ...settings.profileEnv }
  // 中文启动横幅在 GBK 控制台会 UnicodeEncodeError
  env.PYTHONUTF8 = '1'
  env.PYTHONIOENCODING = 'utf-8'
  // certifi 不认本机证书链，用导出的 Windows 根证书（用户导过一次就一直有效）
  if (existsSync(settings.caBundle)) {
    env.SSL_CERT_FILE = settings.caBundle
    env.REQUESTS_CA_BUNDLE = settings.caBundle
    env.CURL_CA_BUNDLE = settings.caBundle
  }
  if (settings.apiKey) env.HINDSIGHT_API_LLM_API_KEY = settings.apiKey
  env.HINDSIGHT_API_LLM_PROVIDER = settings.llmProvider || env.HINDSIGHT_API_LLM_PROVIDER
  if (settings.llmModel) env.HINDSIGHT_API_LLM_MODEL = settings.llmModel
  if (settings.llmBaseUrl) env.HINDSIGHT_API_LLM_BASE_URL = settings.llmBaseUrl
  // dataDir 配置后：uv 缓存与模型缓存都落到这个目录，服务就不会再往 C: 写
  if (settings.uvCacheDir) env.UV_CACHE_DIR = settings.uvCacheDir
  if (settings.hfHome) {
    env.HF_HOME = settings.hfHome
    env.HUGGINGFACE_HUB_CACHE = join(settings.hfHome, 'hub')
    env.SENTENCE_TRANSFORMERS_HOME = join(settings.hfHome, 'sentence-transformers')
  }
  // 模型已经在本地时不要去 HEAD 校验：网络抖动会让启动多等好几分钟，甚至一直 10060 超时
  if (settings.offlineModels) {
    env.HF_HUB_OFFLINE = '1'
    env.TRANSFORMERS_OFFLINE = '1'
  }
  env.HINDSIGHT_API_HOST = env.HINDSIGHT_API_HOST || '127.0.0.1'
  env.HINDSIGHT_API_PORT = String(settings.port)
  env.HINDSIGHT_API_MODEL_INIT_TIMEOUT = env.HINDSIGHT_API_MODEL_INIT_TIMEOUT || '1800'
  return env
}

/**
 * 确保服务可用。返回 {ok, started, detail}：
 * - 已经在跑 → 立刻返回
 * - autoStart 关闭或找不到可执行文件 → ok:false 并带回可复制的安装提示
 * - 否则拉起并轮询，最多 waitMs
 */
export async function ensureServer(settings, { waitMs = settings.readyTimeoutMs, onProgress } = {}) {
  const already = await probeHealth(settings)
  if (already.ok) return { ok: true, started: false, detail: already.body }

  if (!settings.autoStart) return { ok: false, started: false, detail: 'autoStart 已关闭，且服务没有运行。' }

  const exe = findServerExe(settings)
  if (!exe) return { ok: false, started: false, detail: 'no-server', missingExe: true }

  if (!settings.apiKey) {
    // 没有 key 时服务起得来但抽取必然 500，不如提前说清楚
    return { ok: false, started: false, detail: 'no-key', missingKey: true }
  }

  const startedAt = Date.now()
  let logFd
  try {
    logFd = openSync(settings.logFile, 'a')
    const child = spawn(exe, ['--host', '127.0.0.1', '--port', String(settings.port), '--no-access-log'], {
      env: buildServerEnv(settings),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    })
    child.unref()
    closeSync(logFd)
    logFd = undefined
  } catch (error) {
    if (logFd !== undefined) {
      try {
        closeSync(logFd)
      } catch {
        /* 已经关了 */
      }
    }
    return { ok: false, started: false, detail: `spawn-failed: ${error?.message ?? error}` }
  }

  while (Date.now() - startedAt < waitMs) {
    await sleep(2500)
    const probe = await probeHealth(settings)
    if (probe.ok) return { ok: true, started: true, detail: probe.body, elapsedMs: Date.now() - startedAt }
    onProgress?.(Math.round((Date.now() - startedAt) / 1000))
  }
  return { ok: false, started: true, detail: `timeout after ${Math.round(waitMs / 1000)}s`, elapsedMs: Date.now() - startedAt }
}

/** 端口上监听的 PID（Windows 没有 lsof，POSIX 用 lsof/ss）。 */
export function pidOnPort(settings) {
  if (settings.isWindows) {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout || ''
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 5 && cols[3] === 'LISTENING' && cols[1].endsWith(`:${settings.port}`)) return Number(cols[4])
    }
    return null
  }
  const out = spawnSync('lsof', ['-ti', `tcp:${settings.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || ''
  const pid = Number(out.trim().split(/\s+/)[0])
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export function stopServer(settings) {
  const pid = pidOnPort(settings)
  if (!pid) return { stopped: false, detail: `端口 ${settings.port} 上没有监听进程` }
  try {
    if (settings.isWindows) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    } else {
      process.kill(pid, 'SIGTERM')
    }
    return { stopped: true, detail: `已停止 pid=${pid}` }
  } catch (error) {
    return { stopped: false, detail: `停止失败：${error?.message ?? error}` }
  }
}

export function tailLog(settings, lines = 40) {
  if (!existsSync(settings.logFile)) return `没有日志文件 ${settings.logFile}`
  try {
    const all = readFileSync(settings.logFile, 'utf8').split(/\r?\n/)
    return all.slice(-lines).join('\n')
  } catch (error) {
    return `读日志失败：${error?.message ?? error}`
  }
}
