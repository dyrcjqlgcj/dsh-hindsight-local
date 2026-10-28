// 钩子离线测试：不连服务、不起 DSH，用假的 api 与假的 agent 事件跑一遍。
//
// 覆盖的正是「用知识库顶替交接文档」这件事的关键路径：
// - 首步注入只发生一次，且带「上次停下的地方」
// - 一轮结束把对话追加进本会话的 document
// - 会话结束写收尾快照（诉求 + 最后结论），并和同一轮共用一个 document_id
// - 子会话既不注入也不回写
// - 关掉 handoffSnapshot 就不写快照
// - 回写失败不能把会话带崩
import assert from 'node:assert/strict'
import { DEFAULTS, resolveSettings } from '../lib/config.js'
import { createHooks, documentIdFor, snapshotText } from '../lib/hooks.js'

const results = []
async function step(name, fn) {
  try {
    results.push(['ok', name, await fn()])
  } catch (error) {
    results.push(['FAIL', name, error?.message ?? String(error)])
  }
}

const settings = { ...resolveSettings(DEFAULTS), enabled: true, injectPages: true, retainOnIdle: true, handoffSnapshot: true }
const log = { debug() {}, info() {}, warn() {} }

const events = [
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把交接文档换成知识库' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '开始改 hooks' }] } } },
  { type: 'tool/call', data: { name: 'ops_bash', arguments: { command: 'ls' } } },
  { type: 'user/message', data: { source: { kind: 'plugin:hindsight-local' }, content: [{ type: 'text', text: '这是注入块，不该被当成用户诉求' }] } },
  { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '要写测试' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已写好快照逻辑' }] } } }
]

function fakeAgent({ id = 'sess-1', cwd = 'D:\\demo', origin = 'user', sessionEvents = events } = {}) {
  return { session: { header: { id, cwd, origin }, snapshotEvents: () => sessionEvents, events: sessionEvents } }
}

function fakeApi(retains, { failRetain = false } = {}) {
  return {
    isEmptyBank: () => false,
    tree: async () => [
      { id: 'kp-aaa', name: 'Component map' },
      { id: 'kp-bbb', name: 'Key decisions and rationale' }
    ],
    recall: async (_settings, _bank, query) => {
      if (String(query).includes('上次会话')) {
        return {
          results: [
            { text: '上次在改 hooks.js 的收尾快照' },
            { text: '上次在改 hooks.js 的收尾快照' }, // 重复项，注入里必须去重
            { text: '下一步：跑离线测试' }
          ]
        }
      }
      return { results: [{ text: `与「${query}」相关的历史事实` }] }
    },
    retain: async (_settings, bankId, content, extra) => {
      if (failRetain) throw new Error('boom')
      retains.push({ bankId, content, extra })
      return { success: true }
    }
  }
}

function userMessage(text) {
  return { id: 'u1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

await step('注入一次并带上上次进度', async () => {
  const retains = []
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log, api: fakeApi(retains) })
  const next = async () => ({ kind: 'enter', messages: [userMessage('继续')] })

  hooks.sessionStart({ agent: fakeAgent() })
  const first = await hooks.preStep({ agent: fakeAgent() }, next)
  assert.equal(first.messages.length, 2, '首步应当追加一条注入消息')
  const text = first.messages[1].content[0].text
  assert.match(text, /kp-aaa/)
  assert.match(text, /每次会话|知识页/)
  assert.match(text, /上次停下的地方/)
  assert.match(text, /上次在改 hooks\.js 的收尾快照/)
  assert.match(text, /下一步：跑离线测试/)
  assert.equal(text.split('上次在改 hooks.js 的收尾快照').length - 1, 1, '重复事实要去重')
  assert.equal(first.messages[1].source.kind, 'plugin:hindsight-local')

  const second = await hooks.preStep({ agent: fakeAgent() }, next)
  assert.equal(second.messages.length, 1, '同一会话不该重复注入')
  return '注入一次 + 去重 + 上次进度'
})

await step('子会话既不注入也不回写', async () => {
  const retains = []
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log, api: fakeApi(retains) })
  const agent = fakeAgent({ id: 'sub-1', origin: 'subagent' })
  const decision = await hooks.preStep({ agent }, async () => ({ kind: 'enter', messages: [userMessage('子任务')] }))
  assert.equal(decision.messages.length, 1)
  await hooks.turnStopping({ agent })
  await hooks.disposed({ agent })
  assert.equal(retains.length, 0, '子会话不该写任何东西')
  return 'subagent 全部跳过'
})

await step('一轮结束写进同一份 document', async () => {
  const retains = []
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log, api: fakeApi(retains) })
  await hooks.turnStopping({ agent: fakeAgent() })
  assert.equal(retains.length, 1)
  const call = retains[0]
  assert.equal(call.extra.documentId, documentIdFor('sess-1'))
  assert.deepEqual(call.extra.tags, ['dsh-session', 'dsh-session-turn'])
  assert.match(call.content, /会话片段/)
  return `${call.extra.documentId} / ${call.extra.tags.join('+')}`
})

await step('会话结束写收尾快照', async () => {
  const retains = []
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log, api: fakeApi(retains) })
  await hooks.disposed({ agent: fakeAgent() })
  assert.equal(retains.length, 1)
  const call = retains[0]
  assert.equal(call.extra.documentId, documentIdFor('sess-1'), '快照要和本轮共用一个 document')
  assert.deepEqual(call.extra.tags, ['dsh-session', 'dsh-session-handoff'])
  assert.match(call.content, /会话收尾快照/)
  assert.match(call.content, /把交接文档换成知识库/)
  assert.match(call.content, /要写测试/)
  assert.match(call.content, /已写好快照逻辑/)
  assert.doesNotMatch(call.content, /这是注入块/, '注入消息不能混进快照')
  return '快照含诉求与结论'
})

await step('关掉 handoffSnapshot 就不写', async () => {
  const retains = []
  const off = { ...settings, handoffSnapshot: false }
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => off, log, api: fakeApi(retains) })
  await hooks.disposed({ agent: fakeAgent() })
  assert.equal(retains.length, 0)
  return '开关生效'
})

await step('回写失败不抛错', async () => {
  const hooks = createHooks({ name: 'hindsight-local', getSettings: () => settings, log, api: fakeApi([], { failRetain: true }) })
  const agent = fakeAgent()
  await hooks.turnStopping({ agent }) // 不得抛出
  await hooks.disposed({ agent })
  return '失败只记日志'
})

await step('快照文本自身', async () => {
  const text = snapshotText({ sessionId: 'x', cwd: 'D:\\repo', requests: ['甲', '乙'], lastAssistant: '丙' })
  assert.match(text, /项目：D:\\repo/)
  assert.match(text, /- 甲/)
  assert.match(text, /- 乙/)
  assert.match(text, /丙/)
  const short = snapshotText({ sessionId: 'x', cwd: 'D:\\repo', requests: ['长'.repeat(500)], lastAssistant: '', maxChars: 80 })
  assert.ok(short.length < 120, `截断没生效：${short.length}`)
  return '格式与截断 ok'
})

for (const [status, name, detail] of results) console.log(`${status.padEnd(4)} ${name.padEnd(24)} ${detail}`)
const failed = results.filter(([status]) => status === 'FAIL')
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过')
if (failed.length) process.exitCode = 1
