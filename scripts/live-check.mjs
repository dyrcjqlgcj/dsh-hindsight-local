// 真实调用检查：把插件注册的工具真的跑一遍（读路径不写记忆），确认输出是人能看懂的样子。
// 需要本机服务在跑；不在跑就直接说明怎么起。
//   node scripts/live-check.mjs [bank 所在目录]
import * as plugin from '../index.js'
import { resolveSettings } from '../lib/config.js'
import { probeHealth } from '../lib/daemon.js'

const cwd = process.argv[2] ? process.argv[2] : process.cwd()
const settings = resolveSettings({ profile: 'coding-agent' })
const health = await probeHealth(settings)
if (!health.ok) {
  console.log(`本地 Hindsight 没在跑（${settings.apiUrl}）。先执行：node scripts/hindsight-daemon.mjs start`)
  process.exit(0)
}

const specs = new Map()
plugin.apply(
  {
    on() {},
    inject(_deps, factory) {
      factory({ tools: { register: (spec) => specs.set(spec.name, spec) } })
    },
    logger: () => {}
  },
  {}
)

const exec = { agent: { session: { header: { id: 'live-check', cwd, origin: 'user' } } } }

async function run(name, args) {
  const spec = specs.get(name)
  if (!spec) throw new Error(`工具不存在：${name}`)
  const started = Date.now()
  const text = await spec.execute(args, exec)
  console.log(`\n=== ${name} (${Date.now() - started}ms) ===`)
  console.log(String(text).slice(0, 1200))
}

await run('hindsight_local_status')
await run('hindsight_local_pages')
await run('hindsight_local_search', { query: '插件 hindsight 本地', limit: 3 })
console.log('\n（下面这条应该能拿到 page_id 后读到正文）')

const pages = specs.get('hindsight_local_pages')
const listing = await pages.execute({}, exec)
const firstId = /- (kp-[0-9a-f]+)/.exec(listing)?.[1]
if (firstId) await run('hindsight_local_read', { page_id: firstId })
await run('hindsight_local_recall', { query: '本地 daemon 9077', limit: 3 })
