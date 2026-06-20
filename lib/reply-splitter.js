function hardSplit(text, maxLength) {
  const result = []
  for (let index = 0; index < text.length; index += maxLength)
    result.push(text.slice(index, index + maxLength))
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
    maxSegments = 4,
    minSegmentLength = 8,
    maxSegmentLength = 180,
    keepCodeBlockTogether = true,
  } = options
  if (!split) return [value]
  const fence = String.fromCharCode(96).repeat(3)
  const listLike = /^(?:\s*(?:[-*+]|\d+[.)])\s+.+\n?){2,}$/m.test(value)
  const structured =
    value.includes(fence) || /^\s*[\[{][\s\S]*[\]}]\s*$/.test(value) || listLike
  if (keepCodeBlockTogether && structured && value.length <= maxSegmentLength * maxSegments)
    return [value]

  const sentenceParts = value
    .split(/(?<=[。！？…])|\n+/u)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => (part.endsWith("。") ? part.slice(0, -1) : part))
  const merged = mergeShort(sentenceParts, Math.max(1, minSegmentLength))
  const bounded = merged.flatMap(part =>
    part.length > maxSegmentLength ? hardSplit(part, maxSegmentLength) : [part],
  )
  const limit = Math.max(1, maxSegments)
  if (bounded.length <= limit) return bounded
  return [...bounded.slice(0, limit - 1), bounded.slice(limit - 1).join("")]
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function segmentDelay(segment, options, paceExponent) {
  const minDelay = Math.max(0, Number(options.minDelayMs) || 0)
  const maxDelay = Math.max(minDelay, Number(options.maxDelayMs) || minDelay)
  if (maxDelay === minDelay) return minDelay

  const minLength = Math.max(0, Number(options.minSegmentLength) || 0)
  const maxLength = Math.max(minLength + 1, Number(options.maxSegmentLength) || minLength + 1)
  const length = [...String(segment || "")].length
  const lengthRatio = clamp((length - minLength) / (maxLength - minLength), 0, 1)
  const pacedRatio = lengthRatio ** paceExponent
  return Math.round(minDelay + pacedRatio * (maxDelay - minDelay))
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
  const randomValue = segments.length > 1 ? Number(random()) : 0.5
  const boundedRandom = clamp(Number.isFinite(randomValue) ? randomValue : 0.5, 0, 1)
  const paceExponent = 0.9 + boundedRandom * 0.2
  for (let index = 0; index < segments.length; index++) {
    if (index > 0) await sleep(segmentDelay(segments[index], options, paceExponent))
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
