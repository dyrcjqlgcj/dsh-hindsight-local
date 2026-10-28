// 本地 Hindsight HTTP 客户端。所有请求都打到 serverMode=self-hosted 的那个 base URL，
// 不碰云端：base URL 由配置或 profile 决定，默认 127.0.0.1。
import { probeHealth } from './daemon.js'

export class ApiError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
    this.path = path
  }
}

/** bank id 里带 `::`，必须整段编码，否则服务端会把它当成两个路径段。 */
export function bankPath(bankId) {
  return `/v1/default/banks/${encodeURIComponent(bankId)}`
}

function detailOf(body) {
  if (!body) return ''
  if (typeof body === 'string') return body.slice(0, 400)
  if (typeof body.detail === 'string') return body.detail
  if (Array.isArray(body.detail)) return JSON.stringify(body.detail).slice(0, 400)
  if (typeof body.error === 'string') return body.error
  return JSON.stringify(body).slice(0, 400)
}

async function request(settings, path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${settings.apiUrl}${path}`
  let res
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? settings.requestTimeoutMs)
    })
  } catch (error) {
    throw new ApiError(`连不上本地 Hindsight（${settings.apiUrl}）：${error?.message ?? error}`, { path })
  }

  const text = await res.text()
  let parsed = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  if (!res.ok) {
    throw new ApiError(`${method} ${path} → ${res.status} ${detailOf(parsed)}`.trim(), {
      status: res.status,
      body: parsed,
      path
    })
  }
  return parsed
}

/** bank 第一次使用前不存在：服务端对未知 bank 返回 404，这不算错误。 */
export function isEmptyBank(error) {
  if (!(error instanceof ApiError) || error.status !== 404) return false
  return /bank .*not found|not found/i.test(String(error.message))
}

export function health(settings, timeoutMs = 4000) {
  return probeHealth(settings, timeoutMs)
}

/**
 * 写入记忆：服务端用 LLM 把原文抽成 world / experience / observation 事实。
 *
 * documentId 很关键：服务端把同一个 document_id 的条目归成一份文档，所以一场会话
 * 的每一轮放进同一个 document，它在记忆里就是一份完整文档而不是几十条碎片。
 * tags 用于检索时做可见性过滤（recall 支持 tags）。
 */
export function retain(settings, bankId, content, { documentId, tags, context, timestamp, timeoutMs } = {}) {
  const item = { content }
  if (documentId) item.document_id = documentId
  if (tags?.length) item.tags = tags
  if (context) item.context = context
  if (timestamp) item.timestamp = timestamp
  return request(settings, `${bankPath(bankId)}/memories`, {
    method: 'POST',
    body: { items: [item] },
    // 抽取是一次 LLM 调用，比普通读慢一个量级
    timeoutMs: timeoutMs ?? Math.max(settings.requestTimeoutMs, 120000)
  })
}

/**
 * 检索事实。注意 recall 没有「条数」参数：它按 max_tokens 预算返回，
 * 想少拿几条就在调用方截断（工具里的 limit 就是这么做的）。
 */
export function recall(settings, bankId, query, { maxTokens = 4096, budget } = {}) {
  return request(settings, `${bankPath(bankId)}/memories/recall`, {
    method: 'POST',
    timeoutMs: 60000,
    body: budget ? { query, max_tokens: maxTokens, budget } : { query, max_tokens: maxTokens }
  })
}

export function reflect(settings, bankId, query, { timeoutMs } = {}) {
  return request(settings, `${bankPath(bankId)}/reflect`, {
    method: 'POST',
    body: { query },
    timeoutMs: timeoutMs ?? 120000
  })
}

export function listMemories(settings, bankId, limit = 20) {
  return request(settings, `${bankPath(bankId)}/memories/list?limit=${limit}`)
}

export function stats(settings, bankId) {
  return request(settings, `${bankPath(bankId)}/stats`)
}

export async function tree(settings, bankId) {
  const body = await request(settings, `${bankPath(bankId)}/knowledge-base/tree`)
  const roots = body?.roots ?? body?.pages ?? []
  // roots 里混着目录节点（kf-*），只保留真正的知识页（kp-*）
  return roots.filter((node) => !node?.kind || node.kind === 'page')
}

/** 注意参数名是 q（服务端 schema 里就叫 q，传 query 会被 422）。 */
export async function searchPages(settings, bankId, query, limit = 5) {
  const qs = new URLSearchParams({ q: query, limit: String(limit) })
  const body = await request(settings, `${bankPath(bankId)}/knowledge-base/search?${qs}`)
  return body?.results ?? body?.pages ?? body?.items ?? []
}

export async function readPage(settings, bankId, pageId) {
  const body = await request(settings, `${bankPath(bankId)}/knowledge-base/pages/${encodeURIComponent(pageId)}`)
  return body?.page ?? body
}

export function documents(settings, bankId) {
  return request(settings, `${bankPath(bankId)}/documents`)
}

export function deleteDocument(settings, bankId, documentId) {
  return request(settings, `${bankPath(bankId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
}

export function mentalModels(settings, bankId) {
  return request(settings, `${bankPath(bankId)}/mental-models`)
}

export function refreshMentalModel(settings, bankId, id, { timeoutMs } = {}) {
  return request(settings, `${bankPath(bankId)}/mental-models/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
    body: {},
    timeoutMs: timeoutMs ?? 180000
  })
}
