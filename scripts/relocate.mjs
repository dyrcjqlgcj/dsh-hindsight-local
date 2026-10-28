#!/usr/bin/env node
// 把本地 Hindsight 的数据搬到别的盘（例如 C: 太满 → 搬到 D:）。
//
// 为什么要 junction：uv 缓存与模型缓存可以用环境变量指走（UV_CACHE_DIR / HF_HOME），
// 但嵌入式 PostgreSQL（pg0）的位置写死在 pg0.exe 里（默认 ~/.pg0），Hindsight 也不转发
// data-dir 参数。所以在原路径留一个目录联接（junction）指向新位置，所有程序都无感。
//
// 用法：
//   node scripts/relocate.mjs --to D:/hindsight-data              # 搬过去并重启服务
//   node scripts/relocate.mjs --to D:/hindsight-data --dry-run    # 只看会做什么
//   node scripts/relocate.mjs --to D:/hindsight-data --no-restart # 搬完不自动起服务
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultDataDirs, expandPath, resolveSettings } from '../lib/config.js'
import { ensureServer, probeHealth, stopServer } from '../lib/daemon.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const dryRun = flag('--dry-run')
const noRestart = flag('--no-restart')
const target = expandPath(valueOf('--to') || '')

if (!target) {
  console.error('用法：node scripts/relocate.mjs --to <目标目录> [--dry-run] [--no-restart]')
  process.exit(2)
}

const settings = resolveSettings({ dataDir: target })
const dirs = defaultDataDirs()

/** 三个要搬的东西：默认位置 → 目标子目录。 */
const PLAN = [
  { key: 'pg0', from: dirs.pg0, to: join(target, 'pg0'), note: '嵌入式 PostgreSQL（安装 + 数据库）' },
  { key: 'huggingface', from: dirs.huggingface, to: join(target, 'huggingface'), note: '嵌入/重排模型缓存' },
  { key: 'uvCache', from: dirs.uvCache, to: join(target, 'uv-cache'), note: 'uv 缓存（server 可执行文件在这里）' }
]

function log(msg) {
  console.log(msg)
}

/** 目录项是否存在（联接断了也算存在，因为要把它删掉重建）。 */
function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function isJunction(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function junctionTarget(path) {
  if (!isJunction(path)) return null
  try {
    return resolve(readlinkSync(path))
  } catch {
    return null
  }
}

/** 找到 pg0 的 pg_ctl，用来优雅停库（直接 kill 有丢数据的风险）。 */
function findPgCtl(pg0Dir) {
  const installation = join(pg0Dir, 'installation')
  if (!existsSync(installation)) return null
  for (const version of readdirSync(installation)) {
    const exe = join(installation, version, 'bin', process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl')
    if (existsSync(exe)) return exe
  }
  return null
}

function stopPostgres(pg0Dir) {
  const data = join(pg0Dir, 'instances', 'hindsight', 'data')
  const pgCtl = findPgCtl(pg0Dir)
  if (!pgCtl || !existsSync(data)) return { stopped: false, detail: '没有找到 pg_ctl 或数据目录' }
  if (dryRun) return { stopped: false, detail: `会执行：${pgCtl} stop -D ${data} -m fast` }
  const out = spawnSync(pgCtl, ['stop', '-D', data, '-m', 'fast'], { encoding: 'utf8' })
  return { stopped: out.status === 0, detail: (out.stdout || out.stderr || '').trim().split('\n').pop() }
}

/** 用 robocopy 整目录搬（Windows）；失败即中止，不做半截搬迁。 */
function moveDir(from, to) {
  if (dryRun) return { ok: true, detail: `会搬：${from} → ${to}` }
  mkdirSync(to, { recursive: true })
  if (process.platform === 'win32') {
    const out = spawnSync('robocopy', [from, to, '/E', '/MOVE', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1', '/MT:8'], {
      encoding: 'utf8'
    })
    // robocopy 的退出码：0-7 正常，>=8 出错
    const code = out.status ?? 16
    return { ok: code < 8, detail: `robocopy rc=${code}` }
  }
  const out = spawnSync('mv', [from, to.replace(/\/?$/, '/')], { encoding: 'utf8' })
  return { ok: out.status === 0, detail: `mv rc=${out.status ?? '?'}` }
}

function makeJunction(from, to) {
  if (dryRun) return { ok: true, detail: `会建联接：${from} → ${to}` }
  try {
    if (lexists(from)) rmdirSync(from) // 只删空目录/联接，不会碰目标内容
    symlinkSync(to, from, 'junction')
    return { ok: true, detail: '已建联接' }
  } catch (error) {
    return { ok: false, detail: `建联接失败：${error?.message ?? error}` }
  }
}

log(`目标目录：${target}${dryRun ? '（dry-run，只演示）' : ''}`)
log(`服务：${settings.apiUrl}`)

// 1. 先停服务与数据库，否则文件被占用搬不动
log('\n[1/4] 停服务')
if (dryRun) {
  log('  dry-run：不实际停服务')
} else {
  log('  ' + stopServer(settings).detail)
  log('  postgres：' + stopPostgres(dirs.pg0).detail)
}

// 2. 逐个搬
log('\n[2/4] 搬数据')
let failed = false
for (const item of PLAN) {
  const source = isJunction(item.from) ? junctionTarget(item.from) || item.from : item.from
  if (source !== item.from && resolve(source) === resolve(item.to)) {
    log(`  ${item.key}：已经在 ${item.to}，跳过`)
    continue
  }
  if (!existsSync(source)) {
    log(`  ${item.key}：源目录不存在（${source}），跳过`)
    continue
  }
  const moved = moveDir(source, item.to)
  log(`  ${item.key}：${item.note} → ${item.to}（${moved.detail}）`)
  if (!moved.ok) {
    failed = true
    break
  }
}

// 3. 在原路径建联接
log('\n[3/4] 建联接')
if (failed) {
  log('  上一步没搬成功，跳过联接（原目录内容保持不动）')
} else {
  for (const item of PLAN) {
    if (!existsSync(item.to)) {
      log(`  ${item.key}：目标不存在，跳过`)
      continue
    }
    if (isJunction(item.from)) {
      log(`  ${item.key}：已是联接（${item.from}）`)
      continue
    }
    log(`  ${item.key}：${makeJunction(item.from, item.to).detail}`)
  }
}

// 4. 起服务并确认数据还在
log('\n[4/4] 起服务')
if (dryRun) {
  log('  dry-run：跳过')
} else if (noRestart) {
  log('  按参数跳过；稍后用 hindsight_local_start 或 node scripts/… 手动起')
} else if (failed) {
  log('  搬移失败，未起服务')
} else {
  const result = await ensureServer(settings, { waitMs: settings.readyTimeoutMs })
  if (result.ok) {
    const health = await probeHealth(settings)
    log(`  已就绪（${Math.round((result.elapsedMs ?? 0) / 1000)}s）：${JSON.stringify(health.body ?? {})}`)
  } else {
    log(`  起服务失败：${result.detail}`)
  }
}

log('\n完成。记得把插件配置里的 dataDir 改成这个目录：')
log(`  ${target}`)
process.exit(failed ? 1 : 0)
