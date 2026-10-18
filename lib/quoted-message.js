import { messageId, messageTime, requestSafeMessage } from "./history-provider.js"
import { messageNamespace, recentOptions } from "./recent-context.js"
import { sessionKeyFor } from "./trigger.js"

export function quoteId(e) {
  const segment = Array.isArray(e?.message) ? e.message.find(m => m?.type === "reply") : null
  return messageId(e?.reply_id ?? segment?.id ?? segment?.data?.id).slice(0, 200)
}

export async function readQuotedMessage({ e, config, store, signal, timeoutMs = 1500,
  request = requestSafeMessage, now = Date.now }) {
  const options = recentOptions(config), id = quoteId(e)
  const started = performance.now()
  if (!options.enabled || !options.quoted || !id || signal?.aborted) return { reason: "disabled", quote: null }
  const namespace = messageNamespace(e)
  const cached = await store.quote(config, sessionKeyFor(e), namespace, id)
  if (signal?.aborted) return { reason: "aborted", quote: null }
  if (cached) return { reason: "local", quote: cached }
  try {
    const row = await request(e, "get_msg", { message_id: id }, {
      timeoutMs: Math.max(0, timeoutMs - (performance.now() - started)), signal })
    if (signal?.aborted) return { reason: "aborted", quote: null }
    const timestamp = messageTime(row?.time)
    const sender = messageId(row?.sender?.user_id ?? row?.user_id)
    const scopeMatches = e.isGroup
      ? row?.message_type === "group" && messageId(row.group_id) === messageId(e.group_id)
      // An outgoing private message without a verified peer cannot establish its chat scope.
      : e.isPrivate && row?.message_type === "private" && !row.group_id &&
        messageId(row.user_id) === messageId(e.user_id) && sender === messageId(e.user_id)
    if (!scopeMatches || messageId(row?.message_id) !== id || !sender || !timestamp ||
        timestamp > now() + 60000 || !Array.isArray(row.message)) return { reason: "invalid_scope_or_message", quote: null }
    const content = row.message.filter(m => m?.type === "text")
      .map(m => typeof (m.data?.text ?? m.text) === "string" ? (m.data?.text ?? m.text) : "").join("").trim()
    if (!content) return { reason: "no_text", quote: null }
    return { reason: "protocol", quote: { messageId: id, namespace, timestamp, userId: sender,
      displayName: String(row.sender?.card || row.sender?.nickname || "").slice(0, 80),
      text: content.slice(0, options.quoteChars), truncated: content.length > options.quoteChars, source: "protocol" } }
  } catch (error) {
    return { reason: ["timeout", "aborted", "unsupported", "connection_closed", "api_error", "send_error", "invalid_response"]
      .includes(error?.code) ? error.code : "lookup_error", quote: null }
  }
}
