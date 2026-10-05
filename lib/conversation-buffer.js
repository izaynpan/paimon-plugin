function makeId(now) {
  return now + "-" + Math.random().toString(36).slice(2, 10)
}

function cleanMessage(message) {
  const { event, ...clean } = message
  return clean
}

export class ConversationBuffer {
  constructor({
    onReplyBatch,
    onSessionEnd,
    logger,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now(),
  } = {}) {
    this.sessions = new Map()
    this.onReplyBatch = onReplyBatch
    this.onSessionEnd = onSessionEnd
    this.logger = logger
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.now = now
  }

  has(sessionKey) {
    return this.sessions.has(sessionKey)
  }

  get(sessionKey) {
    const session = this.sessions.get(sessionKey)
    return session ? this.snapshot(session) : null
  }

  addMessage({
    sessionKey,
    scene,
    groupId = "",
    message,
    debounceMs = 3000,
    activeWindowMs = 30000,
  }) {
    if (!sessionKey || !message?.text) throw new TypeError("sessionKey 和文本消息不能为空")
    let session = this.sessions.get(sessionKey)
    const now = this.now()
    if (!session) {
      session = {
        id: makeId(now),
        sessionKey,
        scene,
        groupId: groupId ? String(groupId) : "",
        startedByUserId: String(message.userId),
        participants: {},
        pendingMessages: [],
        replyBatchTimer: null,
        sessionBatches: [],
        sessionEndTimer: null,
        endGeneration: 0,
        startedAt: now,
        updatedAt: now,
        lastReplyAt: 0,
        isReplying: false,
        debounceMs,
        activeWindowMs,
      }
      this.sessions.set(sessionKey, session)
    }

    session.debounceMs = Math.max(0, Number(debounceMs) || 0)
    session.activeWindowMs = Math.max(0, Number(activeWindowMs) || 0)
    session.updatedAt = now
    session.endGeneration++
    if (session.sessionEndTimer) {
      this.clearTimer(session.sessionEndTimer)
      session.sessionEndTimer = null
    }

    const id = String(message.userId)
    const existing = session.participants[id]
    session.participants[id] = {
      userId: id,
      displayName: String(message.displayName || id),
      nickname: message.nickname ?? existing?.nickname ?? "",
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
    }
    session.pendingMessages.push(message)
    if (!session.isReplying) this.scheduleReply(session)
    return this.snapshot(session)
  }

  scheduleReply(session) {
    if (session.replyBatchTimer) this.clearTimer(session.replyBatchTimer)
    session.replyBatchTimer = this.setTimer(() => {
      session.replyBatchTimer = null
      void this.flush(session.sessionKey)
    }, session.debounceMs)
    session.replyBatchTimer?.unref?.()
  }

  async flush(sessionKey) {
    const session = this.sessions.get(sessionKey)
    if (!session || session.isReplying || !session.pendingMessages.length) return
    const rawMessages = session.pendingMessages.splice(0)
    const messages = rawMessages.map(cleanMessage)
    const replyEvent = rawMessages[rawMessages.length - 1].event
    session.isReplying = true
    let result = { reply: "", emotion: "neutral", failed: true }
    try {
      const value = await this.onReplyBatch?.({
        session: this.snapshot(session),
        replyBatchMessages: messages,
        replyEvent,
      })
      result = { ...result, ...(value || {}) }
      result.failed = value?.failed === true
    } catch (error) {
      this.logger?.("error", "session 回复批次处理失败", error)
    } finally {
      session.isReplying = false
    }

    session.sessionBatches.push({
      messages,
      reply: typeof result.reply === "string" ? result.reply : "",
      emotion: result.emotion || "neutral",
      failed: result.failed === true,
      createdAt: this.now(),
    })
    session.lastReplyAt = this.now()
    session.updatedAt = session.lastReplyAt
    if (session.pendingMessages.length) this.scheduleReply(session)
    else this.scheduleEnd(session)
  }

  scheduleEnd(session) {
    if (session.sessionEndTimer) this.clearTimer(session.sessionEndTimer)
    const generation = ++session.endGeneration
    session.sessionEndTimer = this.setTimer(() => {
      session.sessionEndTimer = null
      if (session.endGeneration === generation) void this.finish(session.sessionKey)
    }, session.activeWindowMs)
    session.sessionEndTimer?.unref?.()
  }

  async finish(sessionKey) {
    const session = this.sessions.get(sessionKey)
    if (!session) return
    if (session.isReplying || session.pendingMessages.length) {
      if (!session.isReplying) this.scheduleReply(session)
      return
    }
    if (session.replyBatchTimer) this.clearTimer(session.replyBatchTimer)
    if (session.sessionEndTimer) this.clearTimer(session.sessionEndTimer)
    this.sessions.delete(sessionKey)
    try {
      await this.onSessionEnd?.(this.snapshot(session))
    } catch (error) {
      this.logger?.("error", "session 结束处理失败", error)
    }
  }

  snapshot(session) {
    return {
      id: session.id,
      sessionKey: session.sessionKey,
      scene: session.scene,
      groupId: session.groupId,
      startedByUserId: session.startedByUserId,
      participants: structuredClone(session.participants),
      pendingMessages: session.pendingMessages.map(cleanMessage),
      sessionBatches: structuredClone(session.sessionBatches),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      lastReplyAt: session.lastReplyAt,
      isReplying: session.isReplying,
    }
  }

  dispose() {
    for (const session of this.sessions.values()) {
      if (session.replyBatchTimer) this.clearTimer(session.replyBatchTimer)
      if (session.sessionEndTimer) this.clearTimer(session.sessionEndTimer)
    }
    this.sessions.clear()
  }
}
