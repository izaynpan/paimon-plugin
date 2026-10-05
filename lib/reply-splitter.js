function hardSplit(text, maxLength) {
  const result = []
  const chars = [...text]
  for (let index = 0; index < chars.length; index += maxLength)
    result.push(chars.slice(index, index + maxLength).join(""))
  return result
}

// Keep sentence boundaries where possible, spreading overflow across all messages.
function balanceParts(parts, limit) {
  const result = []
  let start = 0
  let remaining = parts.reduce((sum, part) => sum + [...part].length, 0)
  for (let groups = limit; groups > 1; groups--) {
    const target = remaining / groups
    let end = start + 1
    let length = [...parts[start]].length
    while (end < parts.length - (groups - 1)) {
      const next = [...parts[end]].length
      if (Math.abs(length + next - target) >= Math.abs(length - target)) break
      length += next
      end++
    }
    result.push(parts.slice(start, end).join(""))
    remaining -= length
    start = end
  }
  result.push(parts.slice(start).join(""))
  return result
}

function mergeShort(parts, minLength) {
  const result = []
  for (const part of parts) {
    if (!part) continue
    if (result.length && (part.length < minLength || result[result.length - 1].length < minLength))
      result[result.length - 1] += part
    else result.push(part)
  }
  return result
}

export function splitReply(text, options = {}) {
  const value = String(text || "").trim()
  if (!value) return []
  const {
    split = true,
    maxSegments = 3,
    minSegmentLength = 15,
    maxSegmentLength = 180,
    keepCodeBlockTogether = true,
  } = options
  if (!split) return [value]
  const fence = String.fromCharCode(96).repeat(3)
  const listLike = /^(?:\s*(?:[-*+]|\d+[.)])\s+.+\n?){2,}$/m.test(value)
  const structured =
    value.includes(fence) || /^\s*[\[{][\s\S]*[\]}]\s*$/.test(value) || listLike
  if (keepCodeBlockTogether && structured)
    return [value]

  const sentenceParts = value
    .split(/(?<=[。！？…])|\n+/u)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.endsWith("。") ? part.slice(0, -1) : part))
  const merged = mergeShort(sentenceParts, Math.max(1, minSegmentLength))
  const segmentLength = Math.max(1, Math.floor(nonNegative(maxSegmentLength, 180)))
  const bounded = merged.flatMap(part =>
    [...part].length > segmentLength ? hardSplit(part, segmentLength) : [part],
  )
  const limit = Math.max(1, Math.floor(nonNegative(maxSegments, 3)))
  if (bounded.length <= limit) return bounded
  return balanceParts(bounded, limit)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function nonNegative(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : fallback
}

function planDelays(segments, options, random) {
  if (segments.length < 2) return []
  const min = nonNegative(options.minDelayMs, 2000)
  const max = Math.max(min, nonNegative(options.maxDelayMs, 8000))
  const base = nonNegative(options.baseDelayMs, 1200)
  const typing = nonNegative(options.typingMsPerChar, 90)
  const reading = nonNegative(options.readingMsPerChar, 120)
  const jitter = clamp(nonNegative(options.delayJitter, 0.1), 0, 1)
  const sample = Number(random())
  const pace = 1 + (clamp(Number.isFinite(sample) ? sample : 0.5, 0, 1) * 2 - 1) * jitter
  const delays = segments.slice(1).map((next, index) => Math.round(clamp(
    Math.max(base + [...next].length * typing, [...segments[index]].length * reading) * pace,
    min,
    max,
  )))
  const total = delays.reduce((sum, delay) => sum + delay, 0)
  const budget = Math.floor(nonNegative(options.maxTotalDelayMs, 18000))
  // The total budget takes precedence over the per-gap minimum for long replies.
  return total > budget ? delays.map(delay => Math.floor(delay * budget / total)) : delays
}

export async function sendReplySegments({
  e,
  text,
  options = {},
  sleep = wait,
  random = Math.random,
  logger,
}) {
  const segments = splitReply(text, options)
  const sent = []
  const retries = Math.max(0, Number(options.sendRetries) || 0)
  const delays = planDelays(segments, options, random)
  for (let index = 0; index < segments.length; index++) {
    if (index > 0 && delays[index - 1] > 0) await sleep(delays[index - 1])
    let success = false
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await e.reply(segments[index])
        if (result !== false && !result?.error) {
          success = true
          sent.push(segments[index])
          break
        }
      } catch (error) {
        logger?.("error", "分段回复发送失败", error)
      }
    }
    if (!success) break
  }
  return sent
}
