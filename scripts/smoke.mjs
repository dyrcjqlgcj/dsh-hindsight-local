// 离线冒烟：不依赖 DSH 运行时，也不要求服务在跑。
// 校验四件事：模块能加载、Config 校验不抛错、九个工具能注册、能连上本机服务（连不上就跳过网络部分）。
import assert from 'node:assert/strict'
import * as plugin from '../index.js'
import { resolveSettings, DEFAULTS } from '../lib/config.js'
import { findServerExe, probeHealth } from '../lib/daemon.js'
import * as api from '../lib/api.js'
import { bankIdFor } from '../lib/bank.js'

const results = []
async function step(name, fn) {
  try {
    const value = await fn()
    results.push(['ok', name, value])
    return value
  } catch (error) {
    results.push(['FAIL', name, error?.message ?? String(error)])
    return undefined
  }
}

// 1. 导出面：加载器要的四个东西 + Config 的 standard-schema 形状
step('exports', () => {
  assert.equal(plugin.name, 'hindsight-local')
  assert.deepEqual(plugin.inject, ['agents'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.Config['~standard'].version, 1)
  assert.equal(typeof plugin.Config['~standard'].validate, 'function')
  return 'name/inject/apply/Config ok'
})

// 2. 配置校验：脏值必须退回默认值，而不是抛错
step('config validation', () => {
  const { value } = plugin.Config['~standard'].validate({
    enabled: 'true',
    recallLimit: 'abc',
    readyTimeoutMs: -5,
    apiUrl: '   ',
    unknownKey: 1
  })
  assert.equal(value.enabled, true)
  assert.equal(value.recallLimit, DEFAULTS.recallLimit)
  assert.equal(value.readyTimeoutMs, DEFAULTS.readyTimeoutMs)
  assert.equal(value.apiUrl, DEFAULTS.apiUrl)
  assert.equal(value.handoffSnapshot, DEFAULTS.handoffSnapshot)
  assert.equal(value.snapshotMaxChars, DEFAULTS.snapshotMaxChars)
  assert.equal(value.unknownKey, undefined)
  return 'dirty values fall back to defaults'
})

// 3. 设置解析：key 不回显，provider/model 有推断
step('resolveSettings', () => {
  const settings = resolveSettings({ apiKey: 'sk-test-not-real', profile: 'coding-agent' })
  assert.equal(settings.apiKey, 'sk-test-not-real')
  assert.ok(settings.llmModel.length > 0, 'model should be inferred')
  assert.ok(settings.llmProvider.length > 0, 'provider should be inferred')
  assert.ok(settings.port > 0)
  return `${settings.llmProvider}/${settings.llmModel} @ ${settings.apiUrl}`
})

// 4. bank 命名
step('bankIdFor', () => {
  const settings = resolveSettings({})
  assert.equal(bankIdFor(settings, 'D:\\cloud_farm'), 'coding-agent::cloud_farm')
  assert.equal(bankIdFor({ ...settings, bankId: 'fixed' }, 'D:\\x'), 'fixed')
  return 'template + explicit override'
})

// 5. 工具注册：假装一个 toolCtx，把 register 的 spec 收集起来
step('registerTools', () => {
  const specs = []
  const toolCtx = { tools: { register: (spec) => specs.push(spec) } }
  plugin.inject // 保持引用，避免被 tree-shake 的错觉
  plugin.apply(
    {
      on() {},
      inject(_deps, factory) {
        factory(toolCtx)
      },
      logger: () => {}
    },
    {}
  )
  assert.equal(specs.length, 10, `expected 10 tools, got ${specs.length}`)
  const names = specs.map((spec) => spec.name)
  assert.equal(new Set(names).size, names.length, 'tool names must be unique')
  for (const spec of specs) {
    assert.equal(spec.parameters.type, 'object', `${spec.name} parameters.type`)
    assert.equal(typeof spec.description, 'string')
    assert.ok(spec.description.length > 10, `${spec.name} description too short`)
    assert.equal(spec.output.schema.type, 'string', `${spec.name} output schema`)
    for (const [key, prop] of Object.entries(spec.parameters.properties ?? {})) {
      assert.ok(['string', 'integer', 'number', 'boolean'].includes(prop.type), `${spec.name}.${key} type`)
      if (prop.type === 'integer') assert.ok(Number.isFinite(prop.maximum), `${spec.name}.${key} needs maximum`)
    }
  }
  return names.join(', ')
})

// 6. 网络部分：服务在跑才验，没跑就说明怎么起
const settings = resolveSettings({ profile: 'coding-agent' })
const serverExe = step('findServerExe', () => {
  const exe = findServerExe(settings)
  return exe ?? '未找到（服务没准备过时属正常）'
})

const health = await probeHealth(settings)
if (!health.ok) {
  results.push(['skip', 'live server', `未就绪（${settings.apiUrl}），跳过读数：${health.error ?? health.status}`])
} else {
  const bankId = bankIdFor(settings, process.cwd())
  // 新目录第一次跑时 bank 还不存在，404 是正常状态而不是失败
  const tolerate = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      if (api.isEmptyBank(error)) return '空 bank（还没有记忆）'
      throw error
    }
  }
  await step('health', () => `${health.body?.status ?? 'ok'} db=${health.body?.database ?? '?'}`)
  await step('tree', async () => tolerate(async () => `${(await api.tree(settings, bankId)).length} 张知识页`))
  await step('stats', async () =>
    tolerate(async () => {
      const s = await api.stats(settings, bankId)
      return `nodes=${s?.total_nodes ?? '?'} docs=${s?.total_documents ?? '?'}`
    })
  )
  await step('search', async () => tolerate(async () => `${(await api.searchPages(settings, bankId, '插件', 3)).length} 命`))
  await step('recall', async () => tolerate(async () => `${(await api.recall(settings, bankId, '本地记忆', 3))?.results?.length ?? 0} 条`))
}

// 收尾快照：纯函数，不碰网络
await step('snapshot', async () => {
  const { snapshotText, documentIdFor } = await import('../lib/hooks.js')
  assert.equal(documentIdFor('s1'), 'dsh-session:s1')
  const text = snapshotText({
    sessionId: 's1',
    cwd: 'D:\\demo',
    requests: ['把交接文档换成知识库'],
    lastAssistant: 'hooks 已改成写收尾快照',
    at: new Date('2026-10-28T12:00:00Z')
  })
  assert.match(text, /会话收尾快照/)
  assert.match(text, /把交接文档换成知识库/)
  assert.match(text, /hooks 已改成写收尾快照/)
  assert.ok(snapshotText({ sessionId: 's1', cwd: 'x', requests: [], lastAssistant: '', maxChars: 40 }).length <= 40 + 20)
  return '快照文本与 document id ok'
})

for (const [status, name, detail] of results) console.log(`${status.padEnd(4)} ${name.padEnd(18)} ${detail}`)
const failed = results.filter(([status]) => status === 'FAIL')
console.log(failed.length ? `\n${failed.length} 项失败` : '\n全部通过')
if (failed.length) process.exitCode = 1
