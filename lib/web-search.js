import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { isIP } from "node:net"
import { pluginRoot } from "./paths.js"

const clamp = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : fallback
export function searchApiKey(config) {
  const dedicated = typeof config.webSearch?.apiKey === "string" ? config.webSearch.apiKey.trim() : ""
  return dedicated || String(config.deepseek?.apiKey || "").trim()
}

export function webSearchOptions(config) {
  const c = config.webSearch || {}
  return { enabled: c.enabled === true,
    maxSearches: clamp(c.maxSearches ?? 2, 2, 0, 2),
    maxFetches: clamp(c.maxFetches ?? 3, 3, 0, 3),
    timeoutMs: clamp(c.timeoutMs ?? 15000, 15000, 1000, 30000),
    dailyRequestLimit: clamp(c.dailyRequestLimit ?? 200, 200, 0, 10000),
    cacheTtlMs: clamp(c.cacheTtlMs ?? 3600000, 3600000, 0, 86400000),
    maxContextChars: clamp(c.maxContextChars ?? 12000, 12000, 1000, 24000),
    includeSources: c.includeSources === true }
}

export function publicUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, "")
    if (String(value).length > 2048 || !["http:", "https:"].includes(url.protocol) ||
        url.username || url.password || url.port && !["80", "443"].includes(url.port) ||
        isIP(host) || host.startsWith("[") || !host.includes(".") ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid|lan|home|arpa)$/.test(host)) return null
    url.hash = ""
    return url.href
  } catch { return null }
}

export function safeQuery(value) {
  if (typeof value !== "string") return null
  const query = value.trim().replace(/\s+/g, " ")
  if (!query || [...query].length > 128 || /\d{5,}|sk-[\w-]+|Bearer\s|[\w.+-]+@[\w.-]+/i.test(query)) return null
  return query
}

function interrupted() {
  return Object.assign(new Error("web search cancelled"), { code: "search_cancelled" })
}

export async function abortable(promise, signal) {
  if (signal?.aborted) {
    // The caller may have already started an async operation while constructing arguments.
    void Promise.resolve(promise).catch(() => {})
    throw interrupted()
  }
  let abort
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      abort = () => reject(interrupted())
      signal?.addEventListener("abort", abort, { once: true })
    })])
  } finally { signal?.removeEventListener("abort", abort) }
}

async function pause(ms, signal) {
  let timer
  try { await abortable(new Promise(resolve => { timer = setTimeout(resolve, ms) }), signal) }
  finally { clearTimeout(timer) }
}

export class WebSearchService {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now,
    budgetFile = path.join(pluginRoot, "data/runtime/web-search-budget.json") } = {}) {
    this.fetch = fetchImpl
    this.now = now
    this.budgetFile = budgetFile
    this.budget = null
    this.queue = Promise.resolve()
    this.nextAt = { search: 0, fetch: 0 }
    this.cache = new Map()
    this.inFlight = new Map()
  }

  // Serialized reservations persist attempts before sending. Fail closed on disk errors.
  async reserve(kind, options, signal, allowed) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await pause(Math.max(0, this.nextAt[kind] - this.now()), signal)
      if (signal.aborted || !(await allowed())) throw interrupted()
      const day = new Date(this.now() + 8 * 3600000).toISOString().slice(0, 10)
      if (!this.budget) {
        try { this.budget = this.budgetFile ? JSON.parse(await fs.readFile(this.budgetFile, "utf8")) : { day, count: 0 } }
        catch (error) {
          if (error.code !== "ENOENT") throw Object.assign(new Error("budget unavailable"), { code: "budget_error" })
          this.budget = { day, count: 0 }
        }
        if (typeof this.budget.day !== "string" || !Number.isSafeInteger(this.budget.count) || this.budget.count < 0) {
          this.budget = null
          throw Object.assign(new Error("budget invalid"), { code: "budget_error" })
        }
      }
      if (this.budget.day !== day) this.budget = { day, count: 0 }
      if (this.budget.count >= options.dailyRequestLimit)
        throw Object.assign(new Error("daily request limit"), { code: "daily_limit" })
      const next = { day, count: this.budget.count + 1 }
      if (this.budgetFile) {
        await fs.mkdir(path.dirname(this.budgetFile), { recursive: true })
        const temp = this.budgetFile + ".tmp"
        await fs.writeFile(temp, JSON.stringify(next), "utf8")
        await fs.rename(temp, this.budgetFile)
      }
      this.budget = next
      this.nextAt[kind] = this.now() + 300 // Below the account-wide 5 QPS limit.
    })
    this.queue = operation
    return abortable(operation, signal)
  }

  cacheKey(kind, body, key, revision) {
    return createHash("sha256").update(JSON.stringify([kind, body, key, revision])).digest("hex")
  }

  async request(kind, body, context) {
    const key = this.cacheKey(kind, body, searchApiKey(context.config), context.revision)
    const pending = this.inFlight.get(key)
    if (pending && !context.bypassCache && context.options.cacheTtlMs > 0) {
      // Each waiter keeps its own cancellation. A revoked leader may fail; another
      // still-authorized caller can then make its own bounded request.
      await abortable(pending.catch(() => null), context.signal)
      context.stats.sharedWaits = (context.stats.sharedWaits || 0) + 1
    }
    const operation = this.requestNow(kind, body, context)
    this.inFlight.set(key, operation)
    try { return await operation }
    finally { if (this.inFlight.get(key) === operation) this.inFlight.delete(key) }
  }

  async requestNow(kind, body, { config, options, signal, allowed, revision, stats, bypassCache = false }) {
    if (signal.aborted || !(await allowed())) throw interrupted()
    const apiKey = searchApiKey(config)
    const cacheKey = this.cacheKey(kind, body, apiKey, revision)
    const cached = this.cache.get(cacheKey)
    if (!bypassCache && cached && cached.expiresAt > this.now() && options.cacheTtlMs > 0 &&
        this.now() - cached.createdAt < options.cacheTtlMs) {
      stats.cacheHits++
      return structuredClone(cached.data)
    }
    this.cache.delete(cacheKey)
    if (stats[kind] >= (kind === "search" ? options.maxSearches : options.maxFetches))
      throw Object.assign(new Error("per-question limit"), { code: "question_limit" })
    await this.reserve(kind, options, signal, allowed)
    if (signal.aborted || !(await allowed())) throw interrupted()
    stats[kind]++
    // Fixed official endpoint: never send credentials to a URL supplied by the model.
    const response = await abortable(this.fetch("https://api.deepseek.com/v1/tools/" + kind, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
    }), signal)
    if (!response.ok) throw Object.assign(new Error("search HTTP " + response.status), { code: "http_" + response.status })
    if (Number(response.headers?.get?.("content-length")) > 2000000)
      throw Object.assign(new Error("response too large"), { code: "response_size" })
    let raw = ""
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let bytes = 0
      try {
        while (true) {
          const { value, done } = await abortable(reader.read(), signal)
          if (done) break
          bytes += value.length
          if (bytes > 2000000) throw Object.assign(new Error("response too large"), { code: "response_size" })
          raw += decoder.decode(value, { stream: true })
        }
        raw += decoder.decode()
      } finally { await reader.cancel().catch(() => {}) }
    } else raw = await abortable(response.text(), signal)
    if (raw.length > 2000000) throw Object.assign(new Error("response too large"), { code: "response_size" })
    const data = JSON.parse(raw)
    if (!data || (kind === "search" ? !Array.isArray(data.results) : typeof data.content !== "string"))
      throw Object.assign(new Error("malformed search response"), { code: "malformed_response" })
    const hasResult = kind === "search" ? Array.isArray(data.results) && data.results.length > 0
      : typeof data.content === "string" && data.content.trim().length > 0
    if (hasResult) stats.successful++
    if (signal.aborted || !(await allowed())) throw interrupted()
    if (options.cacheTtlMs > 0) {
      // Store only bounded public source fields, never a whole conversation.
      const stored = kind === "search" ? { results: data.results.slice(0, 5).filter(item => item && typeof item === "object").map(item => ({
        title: String(item.title || "").slice(0, 200), url: publicUrl(item.url),
        content: String(item.content || "").slice(0, 8000), summary: String(item.summary || "").slice(0, 2000),
        date: String(item.date || "").slice(0, 80), rerank_score: Number(item.rerank_score) || 0,
        authority: Number(item.authority) || 0,
      })) } : { title: String(data.title || "").slice(0, 200), content: String(data.content || "").slice(0, 8000) }
      stored.retrievedAt = this.now()
      this.cache.set(cacheKey, { data: stored, createdAt: this.now(),
        expiresAt: this.now() + (hasResult ? options.cacheTtlMs : Math.min(60000, options.cacheTtlMs)) })
      for (const [key, entry] of this.cache) if (entry.expiresAt <= this.now()) this.cache.delete(key)
      while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value)
      return structuredClone(stored)
    }
    return { ...data, retrievedAt: this.now() }
  }

  async lookup(query, context) {
    const data = await this.request("search", { query, count: 5, need_content: true }, context)
    const candidates = (Array.isArray(data.results) ? data.results : []).slice(0, 5)
      .filter(item => item && publicUrl(item.url))
      .sort((a, b) => (Number(b.rerank_score) || 0) - (Number(a.rerank_score) || 0))
    const sources = []
    const seen = new Set()
    for (const item of candidates) {
      if (sources.length >= 3 || context.signal.aborted) break
      const url = publicUrl(item.url)
      if (seen.has(url)) continue
      seen.add(url)
      let content = String(item.content || "").trim()
      let retrievedAt = data.retrievedAt
      const longSummary = String(item.summary || "").trim().length >= 600
      // Long summaries suffice for an overview; detailed claims require page content.
      if (!content && (!longSummary || context.needDetails) && sources.length < 2 && context.stats.fetch < context.options.maxFetches) {
        try {
          const page = await this.request("fetch", { url }, context)
          content = String(page.content || "").trim()
          retrievedAt = Math.min(retrievedAt, page.retrievedAt)
        } catch (error) {
          if (context.signal.aborted) throw error
          context.stats.errors.push(error.code || "fetch_error")
        }
      }
      const summaryOnly = !content
      content ||= String(item.summary || item.snippet || "").trim()
      if (!content) continue
      sources.push({ title: String(item.title || "").slice(0, 200), url,
        publishedAt: String(item.date || "").slice(0, 80), fetchedAt: new Date(retrievedAt).toISOString(),
        expiresAt: retrievedAt + context.options.cacheTtlMs,
        summaryOnly, content: excerpt(content, query, 6000) })
    }
    return sources
  }
}

export function excerpt(content, query, limit) {
  const paragraphs = [...new Set(String(content).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean))]
  const terms = query.split(/[\s，,]+/).filter(term => term.length >= 2)
  const ranked = paragraphs.map((text, index) => ({ text, index,
    score: terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
  let length = 0
  const selected = []
  for (const part of ranked) {
    if (length >= limit) break
    const text = part.text.slice(0, limit - length)
    selected.push({ ...part, text })
    length += text.length + 2
  }
  return selected.sort((a, b) => a.index - b.index).map(item => item.text).join("\n\n").slice(0, limit)
}
