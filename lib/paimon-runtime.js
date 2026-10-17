import { configManager, pluginRoot } from "./config.js"
import { ConversationBuffer } from "./conversation-buffer.js"
import { getPreTriggerHistory, historyEnabled, historyOptions, messageTime } from "./history-provider.js"
import { DeepSeekClient, DeepSeekError } from "./deepseek.js"
import { getKnowledgeContext, readKnowledge } from "./knowledge-provider.js"
import { WebSearchService, webSearchOptions, searchApiKey } from "./web-search.js"
import { completeWithResearch } from "./research.js"
import { evaluateSessionMemory } from "./memory-compressor.js"
import { MemoryStore } from "./memory-store.js"
import { ModelLogger } from "./model-logger.js"
import { buildChatMessages, normalizeChatResponse, selectiveGroupReplyEnabled } from "./prompt-builder.js"
import { sendReplySegments, splitReply } from "./reply-splitter.js"
import { UnansweredFollowUp, followUpMetadata, followUpOptions } from "./unanswered-follow-up.js"
import { ReplyPacer } from "./reply-pacer.js"
import { maybeSendSticker } from "./sticker-provider.js"
import {
  evaluateTrigger,
  extractText,
  isGroupAllowed,
  messageFromEvent,
  sessionKeyFor,
} from "./trigger.js"

function safeDetails(details) {
  if (details instanceof Error)
    return {
      name: details.name,
      message: details.message,
      code: details.code,
      status: details.status,
    }
  return details
}

export function paimonLog(level, message, details) {
  const payload = details === undefined ? message : [message, safeDetails(details)]
  globalThis.Bot?.makeLog?.(level, payload, "Paimon")
}

export class PaimonRuntime {
  constructor({
    config = configManager,
    memoryStore,
    client,
    modelLogger,
    knowledgeProvider = getKnowledgeContext,
    webSearchService,
    stickerSender = maybeSendSticker,
    replyPacer,
    followUpTimers = {},
    logger = paimonLog,
  } = {}) {
    this.config = config
    this.logger = logger
    this.modelLogger = modelLogger || new ModelLogger({ logger })
    this.memoryStore = memoryStore || new MemoryStore({ logger })
    this.client =
      client ||
      new DeepSeekClient({
        getConfig: () => this.config.load(),
        logger,
        modelLogger: this.modelLogger,
      })
    this.knowledgeProvider = knowledgeProvider
    this.webSearchService = webSearchService || new WebSearchService()
    this.researchJobs = new Set()
    this.researchContexts = new Map()
    this.stickerSender = stickerSender
    this.replyPacer = replyPacer || new ReplyPacer()
    this.initialized = false
    this.missingKeyWarned = false
    this.historyInitializations = new Map()
    this.disposed = false
    this.followUps = new UnansweredFollowUp({ runtime: this, ...followUpTimers })
    this.buffer = new ConversationBuffer({
      onReplyBatch: input => this.replyBatch(input),
      onSessionEnd: session => this.endSession(session),
      onBatchComplete: input => this.followUps.afterBatch(input),
      onMessage: key => this.followUps.onMessage(key),
      logger,
      now: () => this.replyPacer.now(),
    })
  }

  async initialize({ watch = true } = {}) {
    if (this.replyPacer.controller.signal.aborted)
      this.replyPacer = new ReplyPacer({ now: this.replyPacer.now,
        sleep: this.replyPacer.sleep, random: this.replyPacer.random })
    this.disposed = false
    await this.config.load()
    if (watch) await this.config.startWatching?.(config => {
      this.followUps.revalidate(config)
      this.revalidateResearch(config)
    })
    this.initialized = true
    return this
  }

  async handleEvent(e) {
    const config = await this.config.load()
    this.followUps.revalidate(config)
    this.revalidateResearch(config)
    // Configuration changes only affect subsequent work; abort our optional reads on observed revocation.
    for (const pending of this.historyInitializations.values())
      if (!config.enabled || !config.deepseek?.apiKey || !historyEnabled(config) ||
          !isGroupAllowed(pending.groupId, config)) pending.controller.abort()
    if (this.disposed || !config.enabled) return false
    const text = extractText(e)
    const sessionKey = sessionKeyFor(e)
    const selectiveReply = selectiveGroupReplyEnabled(config, e.isGroup ? "group" : "private")
    const initializing = this.historyInitializations.get(sessionKey)
    const hasActiveSession = Boolean(initializing) || (sessionKey ? this.buffer.has(sessionKey, selectiveReply) : false)
    const decision = evaluateTrigger({
      e,
      text,
      config,
      hasActiveSession,
    })
    if (!decision.accepted) return false

    const directed = messageFromEvent(e, text, config.trigger?.nicknames || ["派蒙"])
    if ((e.isPrivate || directed.mentionsBot || directed.matchedBotNames.length) &&
        /(?:别|不要|不用)(?:再)?(?:查了|搜了|联网了|说了|回复了)|(?:停止|取消)(?:查询|搜索|联网|回复)|(?:别|不要|不用)(?:联网|搜索|回复)(?:了|[，。！!?？\s]|$)/.test(text)) {
      for (const job of this.researchJobs)
        if (job.session.sessionKey === sessionKey) job.controller.abort()
    }

    if (!config.deepseek?.apiKey) {
      if (!this.missingKeyWarned) {
        this.logger("error", "paimon-plugin 未配置 DEEPSEEK_API_KEY")
        this.missingKeyWarned = true
        if (e.isMaster) await e.reply("paimon-plugin 尚未配置 DeepSeek API key")
      }
      return true
    }
    this.missingKeyWarned = false

    if (initializing) {
      if (initializing.queue.length >= 50) {
        initializing.controller.abort()
        await initializing.promise
        return this.handleEvent(e)
      }
      initializing.queue.push(e)
      return true
    }
    if (e.isGroup && !hasActiveSession && !this.buffer.get(sessionKey) && historyEnabled(config) &&
        this.historyInitializations.size < 8) {
      const pending = { groupId: e.group_id, queue: [e], controller: new AbortController() }
      this.historyInitializations.set(sessionKey, pending)
      pending.promise = this.initializeGroupHistory(sessionKey, pending, config)
      await pending.promise
      return true
    }
    this.enqueueEvent(e, decision.text, config, !hasActiveSession)
    return true
  }

  enqueueEvent(e, text, config, renewWindow, preceding = []) {
    const sessionKey = sessionKeyFor(e)
    const session = this.buffer.get(sessionKey)
    const seen = new Set([...(session?.pendingMessages || []),
      ...(session?.sessionBatches || []).flatMap(batch => batch.messages || [])]
      .map(message => message.messageId).filter(Boolean))
    for (const id of session?.inFlightMessageIds || []) seen.add(id)
    const message = messageFromEvent(e, text, config.trigger?.nicknames || [])
    const batchOptions = {
      sessionKey,
      scene: e.isGroup ? "group" : "private",
      groupId: e.group_id || "",
      debounceMs: config.conversation?.debounceMs,
      activeWindowMs: config.conversation?.activeWindowMs,
      selectiveReply: selectiveGroupReplyEnabled(config, e.isGroup ? "group" : "private"),
      renewWindow,
    }
    for (const item of [...preceding, message]) {
      if (item.messageId && seen.has(item.messageId)) continue
      if (item.messageId) seen.add(item.messageId)
      this.buffer.addMessage({ ...batchOptions, message: { ...item, event: e } })
    }
  }

  async initializeGroupHistory(sessionKey, pending, config) {
    const e = pending.queue[0]
    try {
      const result = await getPreTriggerHistory({ e, config, signal: pending.controller.signal })
      const latest = await this.config.load()
      if (this.disposed || this.historyInitializations.get(sessionKey) !== pending) return
      const allowed = latest.enabled && latest.deepseek?.apiKey && isGroupAllowed(e.group_id, latest)
      const firstDecision = evaluateTrigger({ e, text: extractText(e), config: latest })
      // Delete before synchronous queue draining so subsequent messages use the normal session path.
      this.historyInitializations.delete(sessionKey)
      let preceding = result.messages
      if (!allowed || !firstDecision.accepted || pending.controller.signal.aborted || !historyEnabled(latest)) {
        preceding = []
        result.status = "skipped"
        result.reason = "revoked"
      }
      const options = historyOptions(latest)
      const queuedIds = new Set(pending.queue.map(event => String(event.message_id ?? "")).filter(Boolean))
      preceding = preceding.filter(message => !queuedIds.has(message.messageId) &&
        message.timestamp >= messageTime(e.time) - options.windowMs).slice(-options.maxMessages)
      if (allowed && firstDecision.accepted) {
        this.enqueueEvent(e, firstDecision.text, latest, true, preceding)
        for (const next of pending.queue.slice(1)) {
          const decision = evaluateTrigger({ e: next, text: extractText(next), config: latest, hasActiveSession: true })
          if (decision.accepted) this.enqueueEvent(next, decision.text, latest, false)
        }
      }
      const { messages, ...trace } = result
      await this.modelLogger.write("history_lookup", { ...trace, selected: preceding.length,
        sessionKey, sessionId: this.buffer.get(sessionKey)?.id, groupId: String(e.group_id) }, latest)
    } finally {
      if (this.historyInitializations.get(sessionKey) === pending) this.historyInitializations.delete(sessionKey)
      pending.controller.abort()
    }
  }

  async replyBatch({ session, replyBatchMessages, replyEvent, replyStartedAt = this.replyPacer.now() }) {
    const config = await this.config.load()
    const researchEnabled = webSearchOptions(config).enabled
    const researchJob = researchEnabled ? { controller: new AbortController(), session,
      apiKey: config.deepseek?.apiKey, searchApiKey: searchApiKey(config), used: false } : null
    if (researchJob) this.researchJobs.add(researchJob)
    const pendingQuestion = this.followUps.describe(session.sessionKey)
    const pacing = []
    const sendOptions = {
      pacer: this.replyPacer, key: session.sessionKey, startedAt: replyStartedAt,
      options: config.reply, pace: this.replyPacer.sample(config.reply),
      canSend: async () => (await this.isSessionAllowed(session)) &&
        (!researchJob || !researchJob.used || await this.researchAllowed(researchJob)),
      onTiming: timing => pacing.push(timing), logger: this.logger,
    }
    const pacedReply = (value, kind) => sendOptions.pacer.send({ ...sendOptions,
      value, kind, isBatchFirst: !pacing.some(item => item.success), reply: text => replyEvent.reply(text) })
    const selective = selectiveGroupReplyEnabled(config, session.scene)
    if (!(await this.isSessionAllowed(session))) {
      if (researchJob) this.researchJobs.delete(researchJob)
      return { reply: "", emotion: "neutral", failed: true }
    }
    try {
      const memoryLimit = config.memory?.maxParticipantMemoriesForPrompt || 8
      const participantMemories =
        config.memory?.enabled && config.memory?.userMemoryEnabled
          ? await this.memoryStore.readMany(session.participants, memoryLimit)
          : {}
      const providerArgs = {
        e: replyEvent,
        session,
        replyBatchMessages,
        participantMemories,
        config,
      }
      const knowledge = await readKnowledge(this.knowledgeProvider, providerArgs,
        { signal: researchJob?.controller.signal })
      const messages = buildChatMessages({
        session,
        replyBatchMessages,
        participantMemories,
        knowledge: researchEnabled ? { text: "" } : knowledge,
        config,
        persona: this.config.getPersona(),
        pendingQuestion,
      })

      if (!(await this.isSessionAllowed(session)))
        return { reply: "", emotion: "neutral", failed: true }
      const request = {
        messages,
        json: true,
        config,
        trace: {
          type: "chat",
          sessionId: session.id,
          sessionKey: session.sessionKey,
          scene: session.scene,
          groupId: session.groupId,
          participantIds: Object.keys(session.participants || {}),
        },
      }
      const response = researchEnabled ? await completeWithResearch({
        ...request, client: this.client, service: this.webSearchService, knowledge,
        provider: this.knowledgeProvider, providerArgs, signal: researchJob.controller.signal,
        allowed: () => this.researchAllowed(researchJob), onUse: () => { researchJob.used = true },
        previousContext: this.researchContexts.get(session.id),
        saveContext: context => {
          if (context.sources.length) this.researchContexts.set(session.id, context)
          else this.researchContexts.delete(session.id)
          while (this.researchContexts.size > 100) this.researchContexts.delete(this.researchContexts.keys().next().value)
        },
        log: (event, data) => this.modelLogger.write(event, { ...data, sessionId: session.id,
          sessionKey: session.sessionKey }, config),
      }) : await this.client.complete(request)
      // Use the same config snapshot that produced this request, even during hot reload.
      const result = normalizeChatResponse(response.data, {
        selective,
      })
      const followUpMeta = followUpOptions(config).enabled
        ? followUpMetadata(response.data, { pending: pendingQuestion, session, reply: result.reply }) : null
      if (!(await sendOptions.canSend()))
        return { reply: "", emotion: "neutral", failed: true }
      if (result.shouldReply === false) {
        await this.modelLogger.write("reply_skipped", {
          type: "chat", sessionId: session.id, sessionKey: session.sessionKey,
          scene: session.scene, groupId: session.groupId,
          batchNumber: (session.sessionBatches?.length || 0) + 1,
          participantIds: [...new Set(replyBatchMessages.map(message => message.userId))],
          messageCount: replyBatchMessages.length, decisionSource: "model",
          shouldReply: false, reason: result.reason, failed: false,
        }, config)
        return { ...result, followUpMeta, skipped: true, sentSegments: [], failed: false }
      }
      const stickerInput = {
        e: { reply: value => pacedReply(value, "sticker") },
        emotion: result.emotion,
        config,
        stickers: this.config.getStickers(),
        root: pluginRoot,
        logger: this.logger,
      }
      if (config.stickers?.sendAfterText === false) await this.stickerSender(stickerInput)
      const sent = await sendReplySegments({
        ...sendOptions,
        e: replyEvent,
        text: result.reply,
        firstReply: !pacing.some(item => item.success),
      })
      if (config.stickers?.sendAfterText !== false && (await sendOptions.canSend()))
        await this.stickerSender(stickerInput)
      await this.modelLogger.write(
        "reply_sent",
        {
          type: "chat",
          sessionId: session.id,
          sessionKey: session.sessionKey,
          scene: session.scene,
          groupId: session.groupId,
          reply: result.reply,
          emotion: result.emotion,
          segments: sent,
          pacing,
          failed: sent.length === 0,
          ...(result.shouldReply === true ? { shouldReply: true, reason: result.reason } : {}),
        },
        config,
      )
      return { ...result, followUpMeta, sentSegments: sent, failed: sent.length === 0,
        followUpComplete: sent.length > 0 && sent.length === splitReply(result.reply, config.reply).length,
        followUpSentAt: pacing.filter(item => item.kind === "text" && item.success).at(-1)?.sentAt }
    } catch (error) {
      if (researchJob?.controller.signal.aborted || error?.code === "search_cancelled")
        return { reply: "", emotion: "neutral", failed: true }
      this.logger("error", "DeepSeek 聊天回复失败", error)
      if (!(await this.isSessionAllowed(session)))
        return { reply: "", emotion: "neutral", failed: true }
      if (error instanceof DeepSeekError && error.silent) {
        if (replyEvent?.isMaster)
          await pacedReply("DeepSeek API 鉴权或余额异常，请检查配置与账户状态", "error")
        await this.modelLogger.write(
          "reply_sent",
          {
            type: "chat",
            sessionId: session.id,
            sessionKey: session.sessionKey,
            reply: "",
            emotion: "neutral",
            segments: [],
            pacing,
            failed: true,
            errorCode: error.code,
          },
          config,
        )
        return { reply: "", emotion: "neutral", failed: true }
      }
      const fallback = "派蒙有点困了，稍后再聊吧"
      const fallbackSent = Boolean(replyEvent?.reply) && await pacedReply(fallback, "fallback")
      await this.modelLogger.write(
        "reply_sent",
        {
          type: "chat",
          sessionId: session.id,
          sessionKey: session.sessionKey,
          reply: fallback,
          emotion: "neutral",
          segments: fallbackSent ? [fallback] : [],
          pacing,
          failed: true,
          errorCode: error?.code || "chat_error",
        },
        config,
      )
      return { reply: fallback, emotion: "neutral", sentSegments: fallbackSent ? [fallback] : [], failed: true }
    } finally {
      if (researchJob) {
        researchJob.controller.abort()
        this.researchJobs.delete(researchJob)
      }
    }
  }

  revalidateResearch(config) {
    for (const job of this.researchJobs)
      if (this.disposed || !config.enabled || !webSearchOptions(config).enabled ||
          !config.deepseek?.apiKey || config.deepseek.apiKey !== job.apiKey ||
          searchApiKey(config) !== job.searchApiKey ||
          job.session.scene === "group" && !isGroupAllowed(job.session.groupId, config))
        job.controller.abort()
  }

  async researchAllowed(job) {
    const config = await this.config.load()
    this.revalidateResearch(config)
    return !job.controller.signal.aborted
  }

  async endSession(session) {
    this.researchContexts.delete(session.id)
    this.followUps.cancel(session.sessionKey, "session_end")
    const config = await this.config.load()
    if (!(await this.isSessionAllowed(session))) return
    return evaluateSessionMemory({
      session,
      config,
      client: this.client,
      memoryStore: this.memoryStore,
      logger: this.logger,
      modelLogger: this.modelLogger,
    })
  }

  hasSession(sessionKey) {
    return this.buffer.has(sessionKey)
  }

  async isSessionAllowed(session) {
    const config = await this.config.load()
    return !this.disposed && Boolean(config.enabled) &&
      (session.scene !== "group" || isGroupAllowed(session.groupId, config))
  }

  async dispose() {
    this.disposed = true
    for (const job of this.researchJobs) job.controller.abort()
    this.researchJobs.clear()
    this.researchContexts.clear()
    this.followUps.dispose()
    this.replyPacer.dispose()
    for (const pending of this.historyInitializations.values()) pending.controller.abort()
    this.historyInitializations.clear()
    this.buffer.dispose()
    await this.config.close?.()
    this.initialized = false
  }
}

export const paimonRuntime = new PaimonRuntime()
