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

  has(sessionKey, selectiveReply) {
    const session = this.sessions.get(sessionKey)
    return Boolean(session) && (!(selectiveReply ?? session.selectiveReply) || this.now() < session.expiresAt)
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
    activeWindowMs = 90000,
    selectiveReply = false,
    renewWindow = false,
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
        expiresAt: now + Math.max(0, Number(activeWindowMs) || 0),
        selectiveReply,
      }
      this.sessions.set(sessionKey, session)
    }

    session.debounceMs = Math.max(0, Number(debounceMs) || 0)
    session.activeWindowMs = Math.max(0, Number(activeWindowMs) || 0)
    session.selectiveReply = selectiveReply
    if (renewWindow) session.expiresAt = now + session.activeWindowMs
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
    // Ordinary messages must not postpone the deadline while waiting for model judgment.
    if (session.selectiveReply) this.scheduleEnd(session)
    return this.snapshot(session)
  }

  scheduleReply(session) {
    if (session.replyBatchTimer) this.clearTimer(session.replyBatchTimer)
    session.replyBatchTimer = this.setTimer(() => {
      session.replyBatchTimer = null
      void this.flush(session.sessionKey)
    }, session.selectiveReply
      ? Math.min(session.debounceMs, Math.max(0, session.expiresAt - this.now()))
      : session.debounceMs)
    session.replyBatchTimer?.unref?.()
  }

  async flush(sessionKey) {
    const session = this.sessions.get(sessionKey)
    if (!session || session.isReplying || !session.pendingMessages.length) return
    if (session.replyBatchTimer) this.clearTimer(session.replyBatchTimer)
    session.replyBatchTimer = null
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
      result.failed = !value || value.failed === true
    } catch (error) {
      this.logger?.("error", "session 回复批次处理失败", error)
    } finally {
      session.isReplying = false
    }

    if (this.sessions.get(sessionKey) !== session) return
    const skipped = result.skipped === true && result.failed !== true
    const sentReply = !skipped && (Array.isArray(result.sentSegments)
      ? result.sentSegments.length > 0 : result.failed !== true && Boolean(result.reply))
    session.sessionBatches.push({
      messages,
      reply: skipped ? "" : Array.isArray(result.sentSegments)
        ? result.sentSegments.join("\n") : typeof result.reply === "string" ? result.reply : "",
      emotion: result.emotion || "neutral",
      failed: result.failed === true,
      skipped,
      ...(result.reason ? { reason: result.reason } : {}),
      createdAt: this.now(),
    })
    if (sentReply) session.lastReplyAt = this.now()
    session.updatedAt = this.now()
    if (sentReply || (!session.selectiveReply && !skipped))
      session.expiresAt = this.now() + session.activeWindowMs
    if (session.pendingMessages.length) this.scheduleReply(session)
    else this.scheduleEnd(session)
  }

  scheduleEnd(session) {
    if (session.sessionEndTimer) this.clearTimer(session.sessionEndTimer)
    const generation = ++session.endGeneration
    session.sessionEndTimer = this.setTimer(() => {
      session.sessionEndTimer = null
      if (session.endGeneration === generation) void this.finish(session.sessionKey)
    }, Math.max(0, session.expiresAt - this.now()))
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
      expiresAt: session.expiresAt,
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
