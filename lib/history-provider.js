import { randomUUID } from "node:crypto"
import { extractText, isIgnoredCommand, messageFromEvent } from "./trigger.js"

function bounded(value, fallback, max) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.floor(number))) : fallback
}

export function historyOptions(config) {
  const options = config.conversation?.preTrigger || {}
  return {
    enabled: options.enabled !== false,
    windowMs: bounded(options.windowMs, 30000, 300000),
    maxMessages: bounded(options.maxMessages, 3, 20),
    pageSize: bounded(options.historyPageSize, 20, 100),
    maxPages: bounded(options.historyMaxPages, 3, 5),
    timeoutMs: bounded(options.historyTimeoutMs, 1500, 5000),
  }
}

export function historyEnabled(config) {
  const o = historyOptions(config)
  return o.enabled && o.windowMs > 0 && o.maxMessages > 0 &&
    o.pageSize > 0 && o.maxPages > 0 && o.timeoutMs > 0
}

export function messageId(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : ""
}

export function messageTime(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : 0
}

function failure(code) { return Object.assign(new Error(code), { code }) }

// Only the inspected TRSS OneBot/NapCat combination is enabled. Unknown adapters
// must not fall back to sendApi/getChatHistory: their timeout may kill the shared WS.
export function supportsSafeHistory(e) {
  const bot = e?.bot
  return bot?.adapter?.name === "OneBotv11" && bot?.version?.app_name === "NapCat.Onebot" &&
    bot.adapter.echo instanceof Map && bot.ws?.readyState === 1 &&
    typeof bot.ws.send === "function" && typeof bot.ws.on === "function" &&
    typeof bot.ws.off === "function"
}

export function requestHistoryPage(e, params, { timeoutMs, signal } = {}) {
  return requestSafeMessage(e, "get_group_msg_history", params, { timeoutMs, signal }).then(data => {
    if (!Array.isArray(data?.messages)) throw failure("invalid_response")
    return data.messages
  })
}

export function requestSafeMessage(e, action, params, { timeoutMs, signal } = {}) {
  if (!["get_group_msg_history", "get_msg"].includes(action)) return Promise.reject(failure("unsupported"))
  if (!supportsSafeHistory(e)) return Promise.reject(failure("unsupported"))
  if (signal?.aborted) return Promise.reject(failure("aborted"))
  if (!(timeoutMs > 0)) return Promise.reject(failure("timeout"))
  const { ws, adapter } = e.bot
  const echo = "paimon-history-" + randomUUID()
  return new Promise((resolve, reject) => {
    let finished = false
    let timer
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      adapter.echo.delete(echo)
      ws.off("close", closed)
      ws.off("error", closed)
      signal?.removeEventListener("abort", aborted)
      error ? reject(error) : resolve(value)
    }
    const closed = () => finish(failure("connection_closed"))
    const aborted = () => finish(failure("aborted"))
    adapter.echo.set(echo, { resolve: response => {
      if (response?.retcode !== 0 && response?.retcode !== 1)
        return finish(failure("api_error"))
      if (!response?.data || typeof response.data !== "object") return finish(failure("invalid_response"))
      finish(null, response.data)
    } })
    ws.on("close", closed)
    ws.on("error", closed)
    signal?.addEventListener("abort", aborted, { once: true })
    timer = setTimeout(() => finish(failure("timeout")), timeoutMs)
    try {
      // Register our own echo before sending. No framework sendApi timer is created.
      ws.send(JSON.stringify({ action, params, echo }),
        error => { if (error) finish(failure("send_error")) })
    } catch { finish(failure("send_error")) }
  })
}

function normalize(row, e, config) {
  if (String(row.group_id) !== String(e.group_id) || String(row.user_id) !== String(e.user_id) ||
      String(row.user_id) === String(e.self_id)) return null
  // CQ strings cannot safely preserve @/non-text boundaries; skip rather than guess.
  if (!Array.isArray(row.message)) return null
  const segments = row.message.filter(item => item && ["text", "at"].includes(item.type))
    .map(item => ({ ...(item.data || item), type: item.type }))
  if (!segments.some(item => item.type === "text" && typeof item.text === "string" && item.text.trim()))
    return null
  const event = { ...e, atBot: false, sender: row.sender || {}, nickname: undefined, message: segments }
  const text = extractText(event)
  if (!text || isIgnoredCommand(text, config.trigger?.ignoreCommandPrefixes)) return null
  const { event: unused, ...message } = messageFromEvent(event, text.slice(0, 4000), config.trigger?.nicknames)
  return { ...message, messageId: messageId(row.message_id), timestamp: messageTime(row.time), preTrigger: true }
}

export async function getPreTriggerHistory({ e, config, signal, excludedIds = [],
  requestPage = requestHistoryPage, now = () => performance.now() }) {
  const options = historyOptions(config)
  const start = now()
  const trace = { source: "onebot_napcat", status: "skipped", reason: "disabled", pages: 0, scanned: 0 }
  const result = (messages = []) => ({ messages, ...trace, selected: messages.length,
    elapsedMs: Math.max(0, Math.round(now() - start)) })
  if (!historyEnabled(config)) return result()
  const anchor = messageId(e.message_id)
  const end = messageTime(e.time)
  if (!anchor || !end) { trace.reason = "missing_anchor"; return result() }
  if (!supportsSafeHistory(e)) { trace.reason = "unsupported"; return result() }
  const lower = end - options.windowMs
  const seen = new Set([anchor, ...excludedIds.map(String)])
  const cursors = new Set()
  let cursor = anchor
  let selected = []
  try {
    for (let page = 0; page < options.maxPages; page++) {
      if (signal?.aborted) throw failure("aborted")
      const remaining = options.timeoutMs - (now() - start)
      if (remaining <= 0) throw failure("timeout")
      if (cursors.has(cursor)) { trace.reason = "cursor_stalled"; break }
      cursors.add(cursor)
      const rows = await requestPage(e, { group_id: e.group_id, message_seq: cursor,
        count: options.pageSize, reverseOrder: true }, { timeoutMs: remaining, signal })
      if (signal?.aborted) throw failure("aborted")
      if (now() - start >= options.timeoutMs) throw failure("timeout")
      trace.pages++
      if (!Array.isArray(rows) || rows.length > options.pageSize) throw failure("invalid_response")
      trace.scanned += rows.length
      if (!rows.length) { trace.reason = "empty"; break }
      // NapCat's inclusive, ascending page lets us exclude later messages even in the same second.
      const anchorIndex = rows.findIndex(row => messageId(row?.message_id) === cursor)
      if (anchorIndex < 0) throw failure("anchor_not_found")
      const earlier = rows.slice(0, anchorIndex)
      const times = rows.map(row => messageTime(row?.time))
      if (times.some(t => !t) || times.some((t, i) => i && t < times[i - 1]))
        throw failure("ambiguous_order")
      const pageSelected = []
      for (const row of earlier) {
        const id = messageId(row.message_id)
        const time = messageTime(row.time)
        if (!id || seen.has(id)) continue
        seen.add(id)
        if (time < lower || time > end) continue
        const message = normalize(row, e, config)
        if (message) pageSelected.push(message)
      }
      selected = [...pageSelected, ...selected].slice(-options.maxMessages)
      trace.status = "ok"
      trace.reason = "page_limit"
      if (selected.length >= options.maxMessages) { trace.reason = "enough"; break }
      if (times[0] < lower) { trace.reason = "window_end"; break }
      if (rows.length < options.pageSize) { trace.reason = "short_page"; break }
      const next = messageId(rows[0]?.message_id)
      if (!next || next === cursor) { trace.reason = "cursor_stalled"; break }
      cursor = next
    }
    return result(selected)
  } catch (error) {
    trace.status = "failed"
    trace.reason = ["timeout", "aborted", "unsupported", "api_error", "invalid_response",
      "connection_closed", "send_error", "anchor_not_found", "ambiguous_order"].includes(error?.code)
      ? error.code : "lookup_error"
    return result() // Never let partial/late history change a request after failure.
  }
}
