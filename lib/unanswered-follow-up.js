import { randomUUID } from "node:crypto"
import { buildUnansweredFollowUpMessages } from "./prompt-builder.js"
import { isGroupAllowed } from "./trigger.js"

function bounded(value, fallback, min, max) {
  const n = value == null ? fallback : Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function followUpOptions(config) {
  const options = config.conversation?.unansweredFollowUp || {}
  return { enabled: options.enabled === true,
    waitMs: bounded(options.waitMs, 30000, 5000, 300000),
    cooldownMs: bounded(options.cooldownMs, 180000, 30000, 3600000) }
}

export function followUpMetadata(data, { pending, session, reply }) {
  const status = data?.pendingQuestion
  const states = new Set(["answered", "declined", "topic_changed", "unrelated", "uncertain"])
  const resolution = pending ? { id: pending.id,
    status: status?.id === pending.id && states.has(status.status) ? status.status : "uncertain" } : null
  const value = data?.followUp
  const ids = value?.targetUserIds
  const question = typeof value?.question === "string" ? value.question.trim() : ""
  const valid = value?.eligible === true && question && [...question].length <= 200 && reply.includes(question) &&
    Array.isArray(ids) && ids.length <= 8 && ids.every(id => typeof id === "string" &&
      Object.hasOwn(session.participants || {}, id))
  return { resolution, candidate: valid ? { question, targetUserIds: [...new Set(ids)] } : null }
}

export function normalizeFollowUpDecision(data) {
  if (!data || typeof data.shouldReply !== "boolean") throw new TypeError("补话决策无效")
  if (!data.shouldReply) {
    if (data.reply !== "" || !["not_appropriate", "already_answered"].includes(data.reason))
      throw new TypeError("补话沉默格式无效")
    return data
  }
  if (data.reason !== "unanswered_question" || typeof data.reply !== "string" ||
      !data.reply.trim() || [...data.reply.trim()].length > 80 || /[\r\n]|\[CQ:/i.test(data.reply))
    throw new TypeError("补话文本无效")
  return { shouldReply: true, reason: data.reason, reply: data.reply.trim() }
}

export class UnansweredFollowUp {
  constructor({ runtime, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.runtime = runtime
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.pending = new Map()
    this.cooldowns = new Map()
  }

  now() { return this.runtime.replyPacer.now() }
  describe(key) {
    const q = this.pending.get(key)
    return q ? { id: q.id, question: q.question, targetUserIds: q.targetUserIds,
      sentAt: q.sentAt, batchIndex: q.batchIndex } : null
  }
  log(event, q, reason, extra = {}) {
    // No question/message text in lifecycle events; normal model log privacy switches still apply.
    return this.runtime.modelLogger.write(event, { sessionKey: q.key, sessionId: q.sessionId,
      questionId: q.id, reason, ...extra }, q.config).catch(() => {})
  }
  cancel(key, reason) {
    const q = this.pending.get(key)
    if (!q) return
    this.clearTimer(q.timer)
    this.pending.delete(key)
    void this.log("follow_up_cancelled", q, reason)
  }
  onMessage(key) {
    // Once an autonomous request starts, any newly accepted input invalidates its snapshot.
    if (this.pending.get(key)?.phase === "requesting") this.cancel(key, "new_message")
  }
  allowed(config, session) {
    return !this.runtime.disposed && config.enabled && config.deepseek?.apiKey &&
      followUpOptions(config).enabled && session &&
      (session.scene !== "group" || isGroupAllowed(session.groupId, config))
  }
  revalidate(config) {
    for (const [key, q] of this.pending) {
      const s = this.runtime.buffer.get(key)
      if (!this.allowed(config, s) || s.id !== q.sessionId) this.cancel(key, "revoked")
      else if (q.phase === "waiting") this.schedule(q, Math.max(0, q.sentAt + followUpOptions(config).waitMs - this.now()))
    }
  }

  async afterBatch({ session, result, replyEvent }) {
    const key = session.sessionKey
    let config
    try { config = await this.runtime.config.load() } catch {
      if (this.pending.get(key)?.sessionId === session.id) this.cancel(key, "config_error")
      return
    }
    if (this.runtime.buffer.get(key)?.id !== session.id) return
    const old = this.pending.get(key)
    if (!this.allowed(config, session)) { this.cancel(key, "disabled"); return }
    if (old) {
      const resolution = result.followUpMeta?.resolution
      const keep = result.skipped && !result.failed && result.reason !== "asked_to_stop" &&
        resolution?.id === old.id && resolution.status === "unrelated"
      if (!keep) this.cancel(key, result.reason === "asked_to_stop" ? "declined" :
        resolution?.status || "superseded")
    }
    const candidate = result.followUpMeta?.candidate
    const blocked = !candidate ? "not_eligible" : !result.followUpComplete || result.failed || result.skipped
      ? "incomplete_reply" : result.followUpMeta.resolution?.status === "declined" ? "declined"
        : this.pending.has(key) ? "already_waiting" : this.cooldowns.get(key)?.until > this.now() ? "cooldown" : ""
    if (blocked) {
      await this.log("follow_up_not_armed", { key, sessionId: session.id, config }, blocked)
      return
    }
    // A stale batch must never arm a timer for a replacement/disposed session.
    if (this.runtime.buffer.get(key)?.id !== session.id || this.runtime.disposed) return
    const sentAt = result.followUpSentAt
    if (!Number.isFinite(sentAt)) return
    const q = { ...candidate, id: randomUUID(), key, sessionId: session.id, sentAt,
      batchIndex: session.sessionBatches.length - 1,
      replyEvent, config, phase: "waiting", timer: null }
    this.pending.set(key, q)
    const delay = Math.max(0, sentAt + followUpOptions(config).waitMs - this.now())
    this.schedule(q, delay)
    await this.log("follow_up_armed", q, "question", { waitMs: followUpOptions(config).waitMs })
  }

  schedule(q, delay) {
    this.clearTimer(q.timer)
    q.timer = this.setTimer(() => {
      q.timer = null
      void this.fire(q).catch(() => {
        if (this.pending.get(q.key) === q) this.cancel(q.key, "error")
      })
    }, delay)
    q.timer?.unref?.()
  }

  async fire(q) {
    if (this.pending.get(q.key) !== q || q.phase !== "waiting") return
    const config = await this.runtime.config.load()
    if (this.pending.get(q.key) !== q) return
    const session = this.runtime.buffer.get(q.key)
    if (!this.allowed(config, session) || session.id !== q.sessionId || this.now() >= session.expiresAt) {
      this.cancel(q.key, "expired_or_disabled"); return
    }
    const deadline = q.sentAt + followUpOptions(config).waitMs
    if (this.now() < deadline) { this.schedule(q, deadline - this.now()); return }
    // Bounded grace for normal message processing; never keep an unanswered question alive forever.
    if (this.now() > deadline + 30000) { this.cancel(q.key, "busy_timeout"); return }
    if (session.isReplying || session.pendingMessages.length) { this.schedule(q, 1000); return }
    await this.runtime.buffer.runIdle(q.key, q.sessionId, async snapshot => {
      q.phase = "requesting"
      const valid = async () => {
        const latest = await this.runtime.config.load()
        const current = this.runtime.buffer.get(q.key)
        return this.pending.get(q.key) === q && this.allowed(latest, current) &&
          current.id === q.sessionId && !current.pendingMessages.length && this.now() < current.expiresAt
      }
      try {
        if (!(await valid())) return
        await this.log("follow_up_due", q, "timeout")
        const response = await this.runtime.client.complete({ json: true, maxTokens: 256,
          config: { ...config, deepseek: { ...config.deepseek, maxRetries: 0,
            timeoutMs: bounded(config.deepseek?.timeoutMs, 15000, 1, 15000) } },
          messages: buildUnansweredFollowUpMessages({ session: snapshot,
            question: this.describe(q.key), config, persona: this.runtime.config.getPersona(), now: this.now() }),
          trace: { type: "unanswered_follow_up", sessionKey: q.key, sessionId: q.sessionId, questionId: q.id } })
        if (!(await valid())) return
        const decision = normalizeFollowUpDecision(response.data)
        await this.log("follow_up_decision", q, decision.reason, { shouldReply: decision.shouldReply })
        if (!decision.shouldReply) return
        const pacing = []
        const sent = await this.runtime.replyPacer.send({ key: q.key, value: decision.reply,
          options: { ...config.reply, sendRetries: 0 }, kind: "unanswered_follow_up", isBatchFirst: false,
          canSend: valid, reply: value => q.replyEvent.reply(value), onTiming: item => pacing.push(item),
          logger: this.runtime.logger })
        if (!sent) return
        const cooldown = { until: this.now() + followUpOptions(config).cooldownMs }
        this.clearTimer(this.cooldowns.get(q.key)?.timer)
        this.cooldowns.set(q.key, cooldown)
        cooldown.timer = this.setTimer(() => {
          if (this.cooldowns.get(q.key) === cooldown) this.cooldowns.delete(q.key)
        }, followUpOptions(config).cooldownMs)
        cooldown.timer?.unref?.()
        await this.runtime.modelLogger.write("reply_sent", { type: "unanswered_follow_up",
          sessionKey: q.key, sessionId: q.sessionId, reply: decision.reply, emotion: "neutral",
          segments: [decision.reply], pacing, failed: false }, config).catch(() => {})
        await this.log("follow_up_sent", q, "sent")
        return { sentSegments: [decision.reply] }
      } catch {
        await this.log("follow_up_error", q, "failed")
      } finally {
        if (this.pending.get(q.key) === q) this.cancel(q.key, "finished")
      }
    })
  }

  dispose() {
    for (const key of this.pending.keys()) this.cancel(key, "disposed")
    for (const c of this.cooldowns.values()) this.clearTimer(c.timer)
    this.cooldowns.clear()
  }
}
