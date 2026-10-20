function nonNegative(value, fallback) {
  if (value == null) return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : fallback
}

export function guideDelayScale(options = {}, replyKind) {
  if (replyKind !== "guide") return 1
  const value = options?.guideDelayScale
  const number = typeof value === "number" || typeof value === "string" && value.trim() ? Number(value) : NaN
  return Number.isFinite(number) ? Math.min(1, Math.max(0.1, number)) : 0.5
}

function wait(ms, signal) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}

// One successful-send clock per conversation, independent of API batches/splitting.
export class ReplyPacer {
  constructor({ now = Date.now, sleep = wait, random = Math.random } = {}) {
    this.now = now
    this.sleep = sleep
    this.random = random
    this.states = new Map()
    this.controller = new AbortController()
  }

  sample(options = {}) {
    const jitter = Math.min(1, nonNegative(options.delayJitter, 0.1))
    const sample = Number(this.random())
    return 1 + (Math.min(1, Math.max(0, Number.isFinite(sample) ? sample : 0.5)) * 2 - 1) * jitter
  }

  // Command handlers send their own images/text immediately on the session lane.
  // Count their successful output as zero-length, so the next chat respects it.
  recordExternal(key) {
    if (this.controller.signal.aborted) return
    let state = this.states.get(key)
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, lastSentAt: null, lastLength: 0, cleanup: null }
      this.states.set(key, state)
    }
    clearTimeout(state.cleanup)
    state.lastSentAt = this.now()
    state.lastLength = 0
    state.cleanup = setTimeout(() => { if (!state.pending) this.states.delete(key) }, 300000)
    state.cleanup.unref?.()
  }

  async send({ key = "default", value, options = {}, reply, startedAt = this.now(),
    pace = this.sample(options), canSend = () => true, onTiming, logger, kind = "text",
    isBatchFirst = false, delayScale = 1, onSent }) {
    if (this.controller.signal.aborted) return false
    let state = this.states.get(key)
    if (!state) {
      state = { tail: Promise.resolve(), pending: 0, lastSentAt: null, lastLength: 0, cleanup: null }
      this.states.set(key, state)
    }
    clearTimeout(state.cleanup)
    state.pending++
    const operation = state.tail.then(async () => {
      const allowed = async () => !this.controller.signal.aborted && await canSend() &&
        !this.controller.signal.aborted
      if (!(await allowed())) return false
      const length = typeof value === "string" ? [...value].length : 0
      const min = nonNegative(options.minDelayMs, 4000)
      const max = Math.max(min, nonNegative(options.maxDelayMs, 24000))
      const typingTime = nonNegative(options.baseDelayMs, 1200) + length * nonNegative(options.typingMsPerChar, 340)
      const scale = Number.isFinite(delayScale) ? Math.min(1, Math.max(0.1, delayScale)) : 1
      // Scale both typing/reading targets and their bounds; elapsed API time stays credited.
      const bounded = ms => Math.round(Math.min(max, Math.max(min, ms * pace)) * scale)
      const targetGapMs = bounded(Math.max(
        typingTime,
        state.lastLength * nonNegative(options.readingMsPerChar, 360),
      ))
      const reactionTargetMs = isBatchFirst ? bounded(typingTime) : null
      const previousSentAt = state.lastSentAt
      const previousLength = state.lastLength
      const anchor = previousSentAt ?? startedAt
      // A user's thinking/typing time must not consume this batch's reaction time.
      // Honor both deadlines, rather than summing two complete waits.
      const deadline = Math.max(anchor + targetGapMs,
        isBatchFirst ? startedAt + reactionTargetMs : -Infinity)
      const waitMs = Math.max(0, deadline - this.now())
      if (waitMs > 0) await this.sleep(waitMs, this.controller.signal)
      // maxTotalDelayMs is ignored; the batch's selected scale stays constant.
      const retries = Math.max(0, Math.floor(nonNegative(options.sendRetries, 0)))
      let success = false
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (!(await allowed())) break
        try {
          const result = await reply(value)
          if (result !== false && !result?.error) {
            success = true
            state.lastSentAt = this.now()
            state.lastLength = length
            // Persistence failure must never retry an already delivered protocol message.
            try { await onSent?.({ result, value, kind, sentAt: state.lastSentAt }) }
            catch { logger?.("warn", "已发送回复的近期记录保存失败") }
            break
          }
        } catch (error) {
          logger?.("error", "分段回复发送失败", error)
        }
      }
      onTiming?.({ kind, length, previousLength, targetGapMs, waitMs, isBatchFirst, delayScale: scale,
        reactionTargetMs, reactionStartedAt: isBatchFirst ? startedAt : null,
        previousSentAt, sentAt: success ? state.lastSentAt : null,
        actualGapMs: success && previousSentAt != null ? state.lastSentAt - previousSentAt : null,
        firstLatencyMs: success && isBatchFirst ? state.lastSentAt - startedAt : null,
        success })
      return success
    })
    state.tail = operation.catch(() => {})
    try {
      return await operation
    } finally {
      state.pending--
      if (!state.pending && !this.controller.signal.aborted) {
        // Retain across short session restarts, but not indefinitely in inactive groups.
        const retention = Math.min(2147483647, Math.max(300000,
          nonNegative(options.maxDelayMs, 24000) * 2, nonNegative(options.minDelayMs, 4000) * 2))
        state.cleanup = setTimeout(() => {
          if (this.states.get(key) === state) this.states.delete(key)
        }, retention)
        state.cleanup.unref?.()
      }
    }
  }

  dispose() {
    this.controller.abort()
    for (const state of this.states.values()) clearTimeout(state.cleanup)
    this.states.clear()
  }
}
