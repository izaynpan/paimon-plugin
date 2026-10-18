import path from "node:path"
import { randomUUID } from "node:crypto"
import { CacheFile } from "./cache-file.js"
import { pluginRoot } from "./paths.js"
import { isGroupAllowed } from "./trigger.js"

const bounded = (v, d, min, max) => Number.isFinite(Number(v ?? d))
  ? Math.max(min, Math.min(max, Math.floor(Number(v ?? d)))) : d
const text = (v, n) => typeof v === "string" ? v.slice(0, n) : ""
export function recentOptions(config) {
  const c = config.conversation?.recentContext || {}
  return { enabled: c.enabled === true, persist: c.persist !== false,
    retentionMs: bounded(c.retentionMs, 86400000, 300000, 86400000),
    maxBatches: bounded(c.maxBatches, 20, 1, 20),
    maxStoredChars: bounded(c.maxStoredChars, 16000, 1000, 16000),
    maxPromptChars: bounded(c.maxPromptChars, 6000, 500, 6000),
    quoted: c.quotedMessage?.enabled !== false,
    quoteChars: bounded(c.quotedMessage?.maxChars, 4000, 100, 4000) }
}

export function messageNamespace(e) {
  // No credential or transport URL. Different accounts/adapters cannot alias IDs.
  return e?.self_id ? JSON.stringify([String(e.bot?.adapter?.name || "unknown"), String(e.self_id)]) : ""
}

function allowedScope(key, config) {
  return typeof key === "string" && (/^private:user:[^:]{1,100}$/.test(key) ||
    /^group:[^:]{1,100}$/.test(key) && isGroupAllowed(key.slice(6), config))
}

function cleanMessage(m) {
  if (!m || typeof m.text !== "string" || !m.text.trim() || !Number.isFinite(m.timestamp)) return null
  return { text: text(m.text, 4000), userId: text(m.userId, 100), displayName: text(m.displayName, 80),
    timestamp: m.timestamp, messageId: text(m.messageId, 200), namespace: text(m.namespace, 250),
    ...(m.replyTo ? { replyTo: text(m.replyTo, 200) } : {}) }
}

function cleanBatch(b, now, options) {
  if (!b || !Number.isFinite(b.createdAt) || b.createdAt <= 0 || b.createdAt > now + 60000 ||
      now - b.createdAt >= options.retentionMs || !Array.isArray(b.messages) || !Array.isArray(b.replies)) return null
  const messages = b.messages.slice(-50).map(cleanMessage).filter(m => m && m.timestamp > 0 &&
    m.timestamp <= now + 60000 && now - m.timestamp < options.retentionMs)
  const replies = b.replies.slice(0, 100).map(cleanMessage).filter(m => m && m.timestamp > 0 &&
    m.timestamp <= now + 60000 && now - m.timestamp < options.retentionMs)
  if (!messages.length || !replies.length) return null
  // Preserve speaker/time metadata; budget applies to all serialized fields too.
  const result = { id: text(b.id, 100), sessionId: text(b.sessionId, 100), createdAt: b.createdAt,
    messages, replies, evidenceKey: /^[a-f0-9]{64}$/.test(b.evidenceKey) ? b.evidenceKey : "" }
  while (JSON.stringify(result).length > options.maxStoredChars) {
    const longest = [...result.messages, ...result.replies].sort((a, b) => b.text.length - a.text.length)[0]
    if (longest.text.length > 100) longest.text = longest.text.slice(0, Math.max(100, longest.text.length - 500))
    else if (result.messages.length > 1) result.messages.shift()
    else if (result.replies.length > 1) result.replies.pop()
    else return null
  }
  return result
}

export class RecentContextStore {
  constructor({ file = path.join(pluginRoot, "data/recent-context/history.json"), now = Date.now, logger } = {}) {
    this.file = new CacheFile(file, { logger })
    this.now = now
    this.chats = new Map()
    this.loaded = false
    this.tail = Promise.resolve()
  }

  run(config, task = () => {}) {
    const operation = this.tail.then(async () => {
      const o = recentOptions(config), enabled = config.enabled && o.enabled
      if (!this.loaded) {
        const saved = await this.file.read()
        this.loaded = true
        if (enabled && o.persist) for (const entry of (saved || []).slice(-200)) {
          if (Array.isArray(entry) && allowedScope(entry[0], config) && Array.isArray(entry[1]))
            this.chats.set(entry[0], entry[1].slice(-20))
        }
      }
      const before = JSON.stringify([...this.chats])
      for (const [key, batches] of this.chats) {
        if (!enabled || !allowedScope(key, config)) { this.chats.delete(key); continue }
        const kept = batches.map(b => cleanBatch(b, this.now(), o)).filter(Boolean).slice(-o.maxBatches)
        while (JSON.stringify(kept).length > o.maxStoredChars) kept.shift()
        if (kept.length) this.chats.set(key, kept)
        else this.chats.delete(key)
      }
      const result = enabled ? await task(o) : undefined
      while (this.chats.size > 200) this.chats.delete(this.chats.keys().next().value)
      const after = JSON.stringify([...this.chats])
      if (before !== after || !this.saved || this.persist !== (enabled && o.persist)) {
        this.saved = await this.file.save([...this.chats], enabled && o.persist)
      }
      this.persist = enabled && o.persist
      return result
    })
    this.tail = operation.catch(() => {})
    return operation
  }

  configure(config) { return this.run(config) }

  record(config, { session, messages, replies, evidenceKey = "", id = randomUUID(), createdAt = this.now() }) {
    return this.run(config, o => {
      if (!allowedScope(session.sessionKey, config)) return
      const b = cleanBatch({ id, sessionId: session.id, createdAt, messages, replies, evidenceKey }, this.now(), o)
      if (!b) return
      const batches = (this.chats.get(session.sessionKey) || []).filter(item => item.id !== id)
      batches.push(b)
      while (batches.length > o.maxBatches || JSON.stringify(batches).length > o.maxStoredChars) batches.shift()
      this.chats.delete(session.sessionKey)
      if (batches.length) this.chats.set(session.sessionKey, batches)
    })
  }

  quote(config, key, namespace, id) {
    return this.run(config, o => {
      if (!o.quoted || !namespace || !id) return null
      for (const b of [...(this.chats.get(key) || [])].reverse()) {
        const m = [...b.messages, ...b.replies].find(m => m.namespace === namespace && m.messageId === id)
        if (m) return { ...m, text: m.text.slice(0, o.quoteChars), batchId: b.id, sessionId: b.sessionId,
          truncated: m.text.length > o.quoteChars, source: "local" }
      }
      return null
    })
  }

  select(config, { session, messages, quote }) {
    return this.run(config, o => {
      const activeIds = new Set([...messages, ...(session.sessionBatches || []).flatMap(b => b.messages || [])]
        .filter(m => m.messageId && m.namespace).map(m => m.namespace + ":" + m.messageId))
      if (quote?.namespace && quote.messageId) activeIds.add(quote.namespace + ":" + quote.messageId)
      const all = (this.chats.get(session.sessionKey) || []).filter(b => b.sessionId !== session.id)
      const users = new Set(messages.map(m => m.userId))
      // Candidate ranking only: the model must decide topic continuity and ambiguity.
      const terms = messages.map(m => m.text).join(" ").match(/[\p{L}\p{N}]{2,12}/gu) || []
      const ranked = all.map((b, index) => ({ b, index, score:
        (b.id === quote?.batchId ? 10000 : 0) +
        (b.messages.some(m => users.has(m.userId)) ? 20 : 0) +
        terms.reduce((s, term) => s + (JSON.stringify(b.messages).includes(term) ? 5 : 0), 0) }))
        .sort((a, b) => b.score - a.score || b.index - a.index)
      // A quote's originating question/neighbor is more useful than an isolated short follow-up.
      const anchor = all.findIndex(b => b.id === quote?.batchId)
      const topicSession = anchor >= 0 ? all[anchor].sessionId : ranked[0]?.b.sessionId
      const beginning = all.find(b => b.sessionId === topicSession)
      const priority = anchor >= 0 ? [all[anchor], beginning, all[anchor - 1], all[anchor + 1]]
        : [ranked[0]?.b, beginning]
      const candidates = [...new Set([...priority.filter(Boolean), ...ranked.map(x => x.b)])]
      const picked = [], evidenceKeys = []
      let remaining = o.maxPromptChars - 2
      for (const b of candidates) {
        if (picked.length >= 6) break
        const dedup = list => list.filter(m => !m.messageId || !activeIds.has(m.namespace + ":" + m.messageId))
        const item = { createdAt: b.createdAt, messages: dedup(b.messages), replies: dedup(b.replies) }
        if (!item.messages.length && !item.replies.length) continue
        // Truncate individual texts but keep valid JSON and who said each piece.
        while (JSON.stringify(item).length > remaining) {
          const longest = [...item.messages, ...item.replies].sort((a, b) => b.text.length - a.text.length)[0]
          if (!longest || longest.text.length <= 80) break
          const list = item.messages.includes(longest) ? item.messages : item.replies
          list[list.indexOf(longest)] = { ...longest, text: longest.text.slice(0, Math.max(80, longest.text.length - 300)), truncated: true }
        }
        const size = JSON.stringify(item).length + 1
        if (size > remaining) continue
        picked.push(item); remaining -= size
        if (b.evidenceKey) evidenceKeys.push(b.evidenceKey)
      }
      return { batches: picked.sort((a, b) => a.createdAt - b.createdAt), evidenceKeys }
    })
  }
}
