// 真机端到端：用一个假的 agent 事件跑真实钩子 → 真服务抽取 → 真 recall 能查到 → 清理。
//
// 这一步证明的是「会话收尾快照」这条路是通的，不需要重启 DSH：
// 钩子写进去的东西，下一场会话注入时就能被 recall 捞到。
import assert from 'node:assert/strict'
import { DEFAULTS, resolveSettings } from '../lib/config.js'
import { createHooks, documentIdFor } from '../lib/hooks.js'
import { bankIdFor } from '../lib/bank.js'
import * as api from '../lib/api.js'

const settings = { ...resolveSettings(DEFAULTS), enabled: true, retainOnIdle: true, handoffSnapshot: true }
const cwd = process.cwd()
const bankId = bankIdFor(settings, cwd)
const marker = `HANDOFF-CHECK-${Date.now().toString(36)}`
const sessionId = `check-${Date.now().toString(36)}`
const log = { debug: (line) => console.log('  ·', line), info() {}, warn() {} }

const events = [
  {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `验证收尾快照链路（${marker}），下一步是更新 README` }] }
  },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: `快照链路验证已启动（${marker}），结论稍后回查` }] } }
  }
]
const agent = { session: { header: { id: sessionId, cwd, origin: 'user' }, snapshotEvents: () => events, events } }

const health = await api.health(settings)
assert.ok(health.ok, `本地服务没起来：${health.error ?? health.status}`)
console.log(`服务 ${settings.apiUrl} · bank ${bankId} · 会话 ${sessionId}`)

const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log })
await hooks.turnStopping({ agent })
await hooks.disposed({ agent })
console.log('钩子已写入，等待服务端抽取…')

const deadline = Date.now() + 150000
let found = null
while (Date.now() < deadline) {
  const docs = await api.documents(settings, bankId)
  const list = docs?.items ?? (Array.isArray(docs) ? docs : [])
  found = list.find((doc) => String(doc.id ?? doc.document_id ?? '').includes(sessionId))
  if (found) break
  await new Promise((resolve) => setTimeout(resolve, 5000))
  process.stdout.write('.')
}
console.log('')
assert.ok(found, `150 秒内没有出现 document ${documentIdFor(sessionId)}`)
console.log(`document 已落库：${found.id}（${found.memory_unit_count ?? '?'} 条记忆单元）`)

const hits = await api.recall(settings, bankId, `收尾快照 ${marker} 下一步`, { maxTokens: 900 })
const texts = (hits?.results ?? []).map((hit) => String(hit.text ?? ''))
const relevant = texts.filter((text) => text.includes(marker) || text.includes('收尾快照'))
console.log(`recall 返回 ${texts.length} 条，其中与本次检查相关 ${relevant.length} 条：`)
for (const text of relevant.slice(0, 3)) console.log(`  - ${text.replace(/\s+/g, ' ').slice(0, 120)}`)
assert.ok(relevant.length > 0, 'recall 没查回刚写进去的快照')

await api.deleteDocument(settings, bankId, found.id ?? found.document_id)
console.log('已删除本次检查写入的 document（不留测试数据）')
