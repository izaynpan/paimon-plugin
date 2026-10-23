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
import { ReplyPacer, guideDelayScale } from "./reply-pacer.js"
import { randomUUID } from "node:crypto"
import { CommandRouter } from "./command-router.js"
import { commandSynthetic } from "./command-bridge.js"
import { RecentContextStore, recentOptions, messageNamespace } from "./recent-context.js"
import { quoteId, readQuotedMessage } from "./quoted-message.js"
import { maybeSendSticker } from "./sticker-provider.js"
import { ContextualStickerSelector } from "./sticker-selector.js"
import { StickerCatalog } from "./sticker-catalog.js"
import { contextualStickers, stickerOptions } from "./sticker-intent.js"
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
    recentContextStore,
    stickerSender = maybeSendSticker,
    stickerSelector,
    replyPacer,
    commandRouter,
    followUpTimers = {},
    logger = paimonLog,
  } = {}) {
    this.config = config
    this.logger = logger
    this.modelLogger = modelLogger || new ModelLogger({ logger })
    this.commands = commandRouter || new CommandRouter({ getConfig: () => this.config.load(),
      disposed: () => this.disposed, log: (...args) => this.modelLogger.write(...args),
      onReply: key => this.replyPacer.recordExternal(key) })
    this.memoryStore = memoryStore || new MemoryStore({ logger })
    this.client =
      client ||
      new DeepSeekClient({
        getConfig: () => this.config.load(),
        logger,
        modelLogger: this.modelLogger,
      })
    this.knowledgeProvider = knowledgeProvider
    this.webSearchService = webSearchService || new WebSearchService({ logger })
    this.researchJobs = new Set()
    this.researchContexts = new Map()
    this.recentStore = recentContextStore || new RecentContextStore({ logger })
    this.contextJobs = new Set()
    this.preparedQuotes = new WeakMap()
    this.batchQuotes = new Map()
    this.retentionQueue = Promise.resolve()
    this.stickerSender = stickerSender
    this.stickerSelector = stickerSelector || new ContextualStickerSelector({ catalog: new StickerCatalog({ root: config.root || pluginRoot }) })
    this.stickerJobs = new Set()
    this.stickerMigrationWarned = false
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
      onMessage: key => { this.followUps.onMessage(key); this.cancelStickers(key) },
      logger,
      now: () => this.replyPacer.now(),
    })
  }

  async initialize({ watch = true } = {}) {
    if (this.replyPacer.controller.signal.aborted)
      this.replyPacer = new ReplyPacer({ now: this.replyPacer.now,
        sleep: this.replyPacer.sleep, random: this.replyPacer.random })
    this.disposed = false
    this.revalidateStickers(await this.config.load())
    await this.refreshRetention(await this.config.load(), true)
    clearInterval(this.retentionTimer)
    this.retentionTimer = setInterval(() => {
      void this.config.load().then(config => this.refreshRetention(config)).catch(() =>
        this.logger("warn", "近期缓存定期清理失败"))
    }, 60000)
    this.retentionTimer.unref?.()
    if (watch) await this.config.startWatching?.(config => {
      this.followUps.revalidate(config)
      this.revalidateResearch(config)
      this.revalidateStickers(config)
      this.commands.revalidate(config)
      void this.refreshRetention(config).catch(() => this.logger("warn", "近期缓存配置更新失败"))
    })
    this.initialized = true
    return this
  }

  async handleEvent(e) {
    if (e[commandSynthetic]) return false
    const config = await this.config.load()
    this.followUps.revalidate(config)
    this.revalidateResearch(config)
    this.revalidateStickers(config)
    this.commands.revalidate(config)
    await this.refreshRetention(config)
    // Configuration changes only affect subsequent work; abort our optional reads on observed revocation.
    for (const pending of this.historyInitializations.values())
      if (!config.enabled || !config.deepseek?.apiKey ||
          pending.lookupQuote && (!recentOptions(config).enabled || !recentOptions(config).quoted) ||
          !pending.lookupQuote && !historyEnabled(config) ||
          pending.groupId != null && !isGroupAllowed(pending.groupId, config)) pending.controller.abort()
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
    // Cancel immediately, including while an accepted message waits for optional quote/history reads.
    this.cancelStickers(sessionKey)

    const directed = messageFromEvent(e, text, config.trigger?.nicknames || ["派蒙"])
    if ((e.isPrivate || directed.mentionsBot || directed.matchedBotNames.length) &&
        /(?:别|不要|不用)(?:再)?(?:查了|搜了|联网了|说了|回复了)|(?:停止|取消)(?:查询|搜索|联网|回复)|(?:别|不要|不用)(?:联网|搜索|回复)(?:了|[，。！!?？\s]|$)/.test(text)) {
      for (const job of this.researchJobs)
        if (job.session.sessionKey === sessionKey) job.controller.abort()
      this.commands.cancel(sessionKey, e.user_id)
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
    const lookupHistory = e.isGroup && !hasActiveSession && !this.buffer.get(sessionKey) && historyEnabled(config)
    const lookupQuote = recentOptions(config).enabled && recentOptions(config).quoted && Boolean(quoteId(e))
    if ((lookupHistory || lookupQuote) && this.historyInitializations.size < 8) {
      const pending = { groupId: e.group_id, queue: [e], controller: new AbortController(),
        lookupHistory, lookupQuote, hadActive: hasActiveSession }
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
    const dedupKey = m => m.messageId ? (m.namespace || messageNamespace(e)) + ":" + m.messageId : ""
    const seen = new Set([...(session?.pendingMessages || []),
      ...(session?.sessionBatches || []).flatMap(batch => batch.messages || [])]
      .map(dedupKey).filter(Boolean))
    for (const key of session?.inFlightMessageKeys || []) seen.add(key)
    const message = messageFromEvent(e, text, config.trigger?.nicknames || [])
    message.namespace = messageNamespace(e)
    if (quoteId(e)) message.replyTo = quoteId(e)
    const prepared = this.preparedQuotes.get(e)
    if (prepared) {
      message.quoteToken = randomUUID()
      this.batchQuotes.set(message.quoteToken, prepared)
      while (this.batchQuotes.size > 200) this.batchQuotes.delete(this.batchQuotes.keys().next().value)
      this.preparedQuotes.delete(e)
    }
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
      const key = dedupKey(item)
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      this.buffer.addMessage({ ...batchOptions, message: { namespace: messageNamespace(e), ...item, event: item === message ? e : undefined } })
    }
  }

  async initializeGroupHistory(sessionKey, pending, config) {
    const e = pending.queue[0]
    try {
      const start = performance.now()
      if (pending.lookupQuote) {
        const quoted = await readQuotedMessage({ e, config, store: this.recentStore,
          signal: pending.controller.signal, timeoutMs: 1500 })
        const latest = await this.config.load()
        if (!this.disposed && !pending.controller.signal.aborted && recentOptions(latest).enabled && recentOptions(latest).quoted)
          this.preparedQuotes.set(e, quoted)
        await this.modelLogger.write("quote_lookup", { reason: quoted.reason,
          found: Boolean(quoted.quote), elapsedMs: Math.round(performance.now() - start), sessionKey }, latest)
      }
      const budget = recentOptions(config).enabled ? Math.max(0, Math.min(historyOptions(config).timeoutMs,
        1500 - (performance.now() - start))) : historyOptions(config).timeoutMs
      const result = pending.lookupHistory ? await getPreTriggerHistory({ e,
        config: { ...config, conversation: { ...config.conversation, preTrigger: {
          ...config.conversation?.preTrigger, historyTimeoutMs: budget } } }, signal: pending.controller.signal })
        : { messages: [], status: "skipped", reason: "not_needed" }
      const latest = await this.config.load()
      if (this.disposed || this.historyInitializations.get(sessionKey) !== pending) return
      const allowed = latest.enabled && latest.deepseek?.apiKey && (!e.isGroup || isGroupAllowed(e.group_id, latest))
      const firstDecision = evaluateTrigger({ e, text: extractText(e), config: latest, hasActiveSession: pending.hadActive })
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
        this.enqueueEvent(e, firstDecision.text, latest, !pending.hadActive, preceding)
        for (const next of pending.queue.slice(1)) {
          const decision = evaluateTrigger({ e: next, text: extractText(next), config: latest, hasActiveSession: true })
          if (decision.accepted) this.enqueueEvent(next, decision.text, latest, false)
        }
      }
      const { messages, ...trace } = result
      if (pending.lookupHistory) await this.modelLogger.write("history_lookup", { ...trace, selected: preceding.length,
        sessionKey, sessionId: this.buffer.get(sessionKey)?.id, groupId: String(e.group_id) }, latest)
    } finally {
      if (this.historyInitializations.get(sessionKey) === pending) this.historyInitializations.delete(sessionKey)
      pending.controller.abort()
    }
  }

  async replyBatch({ session, replyBatchMessages, replyBatchEvents = [], replyEvent, replyStartedAt = this.replyPacer.now() }) {
    const config = await this.config.load()
    this.revalidateResearch(config)
    this.revalidateStickers(config)
    const stickerJob = contextualStickers(config) ? { controller: new AbortController(), session,
      apiKey: config.deepseek?.apiKey, baseUrl: config.deepseek?.baseUrl } : null
    if (stickerJob) this.stickerJobs.add(stickerJob)
    await this.refreshRetention(config)
    const contextJob = recentOptions(config).enabled ? { controller: new AbortController(), session,
      apiKey: config.deepseek?.apiKey, used: false, quoteUsed: false, timestamps: [] } : null
    if (contextJob) this.contextJobs.add(contextJob)
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
        (!contextJob || !contextJob.used || await this.contextAllowed(contextJob)) &&
        (!researchJob || !researchJob.used || await this.researchAllowed(researchJob)),
      onTiming: timing => pacing.push(timing), logger: this.logger,
    }
    const pacedReply = (value, kind) => sendOptions.pacer.send({ ...sendOptions,
      value, kind, isBatchFirst: !pacing.some(item => item.success), reply: text => replyEvent.reply(text) })
    const selective = selectiveGroupReplyEnabled(config, session.scene)
    if (!(await this.isSessionAllowed(session))) {
      if (stickerJob) this.stickerJobs.delete(stickerJob)
      if (researchJob) this.researchJobs.delete(researchJob)
      if (contextJob) this.contextJobs.delete(contextJob)
      return { reply: "", emotion: "neutral", failed: true }
    }
    try {
      const commandContext = await this.commands.prepare(replyBatchMessages, replyBatchEvents, config)
      let recentContext = null, recentEvidence
      if (contextJob) {
        const latestQuote = [...replyBatchMessages].reverse().find(m => m.replyTo)
        const quoted = this.batchQuotes.get(latestQuote?.quoteToken)
        let quote = recentOptions(config).quoted ? quoted?.quote : null
        if (quote?.source === "local" && Date.now() - quote.timestamp >= recentOptions(config).retentionMs) quote = null
        const selected = await this.recentStore.select(config, { session, messages: replyBatchMessages, quote })
        if (quote || selected?.batches.length || replyBatchMessages.some(m => m.replyTo)) {
          recentContext = { batches: selected?.batches || [], quotedMessage: quote || null,
            quoteStatus: quoted?.reason || "unavailable" }
          if (quote?.sessionId === session.id && session.sessionBatches.some(b =>
            (b.messages || []).some(m => m.namespace === quote.namespace && m.messageId === quote.messageId) ||
            b.reply?.split("\n").includes(quote.text)))
            recentContext.quotedMessage = { ...quote, text: undefined, source: "active_context" }
          while (JSON.stringify(recentContext).length > 10000 && recentContext.quotedMessage?.text) {
            recentContext.quotedMessage = { ...recentContext.quotedMessage,
              text: recentContext.quotedMessage.text.slice(0, -100), truncated: true }
          }
          contextJob.used = true
          contextJob.quoteUsed = Boolean(quote)
          contextJob.timestamps = (selected?.batches || []).map(b => b.createdAt)
        }
        if (researchEnabled && selected?.evidenceKeys.length)
          recentEvidence = await this.webSearchService.readEvidence?.(selected.evidenceKeys, config)
        await this.modelLogger.write("recent_context", { sessionKey: session.sessionKey,
          batches: selected?.batches.length || 0, quoted: Boolean(quote),
          retentionMs: recentOptions(config).retentionMs, persisted: recentOptions(config).persist,
          searchCacheTtlMs: webSearchOptions(config).cacheTtlMs }, config)
      }
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
        recentContext,
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
        recentContext,
        commandRouting: Boolean(commandContext?.sources.length),
      })

      if (!(await sendOptions.canSend()))
        return { reply: "", emotion: "neutral", failed: true }
      const request = {
        messages,
        signal: contextJob?.controller.signal,
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
      if (!researchEnabled && commandContext?.prompt) messages[0].content += '\n' + commandContext.prompt
      const response = researchEnabled ? await completeWithResearch({
        commandContext,
        ...request, client: this.client, service: this.webSearchService, knowledge,
        provider: this.knowledgeProvider, providerArgs, signal: researchJob.controller.signal,
        allowed: async () => await this.researchAllowed(researchJob) &&
          (!contextJob || !contextJob.used || await this.contextAllowed(contextJob)),
        onUse: () => { researchJob.used = true },
        previousContext: this.researchContexts.get(session.id) || recentEvidence,
        saveContext: context => {
          if (context.sources.length) this.researchContexts.set(session.id, context)
          else this.researchContexts.delete(session.id)
          while (this.researchContexts.size > 100) this.researchContexts.delete(this.researchContexts.keys().next().value)
        },
        log: (event, data) => this.modelLogger.write(event, { ...data, sessionId: session.id,
          sessionKey: session.sessionKey }, config),
      }) : await this.client.complete(request)
      if (response.data?.action === 'invoke_command') {
        const invoked = await this.commands.invoke(response.data, commandContext, config,
          async () => await sendOptions.canSend() && this.buffer.get(session.sessionKey)?.id === session.id)
        const responded = (invoked.attempts || 0) > 0
        const hasSent = (invoked.successes || 0) > 0
        let summary = hasSent ? '已由游戏功能回复（不代表查询成功）' : ''
        if (!responded && !['duplicate', 'cancelled'].includes(invoked.status) && commandContext?.capabilities.length && await sendOptions.canSend()) {
          summary = invoked.status === 'cooldown' ? '刚刚已经查过啦，稍等一下再试吧'
            : invoked.status === 'rejected' ? '还没确认清楚要查哪项，告诉派蒙具体游戏和角色吧'
              : invoked.status === 'context_busy' ? '你还有其他功能的交互没结束，先完成或退出后再试吧'
                : invoked.command ? `这次没拿到回复，可以稍后手动发送「${invoked.command}」试试`
                  : '这次没拿到回复，稍后再试试原来的指令吧'
          if (!(await pacedReply(summary, 'text'))) summary = ''
        }
        return { reply: summary, emotion: 'neutral', origin: 'command', failed: !hasSent && !summary,
          followUpComplete: false, followUpMeta: null }
      }
      // Use the same config snapshot that produced this request, even during hot reload.
      const result = normalizeChatResponse(response.data, {
        selective,
      })
      const replyKind = response.data.replyKind === "guide" ? "guide" : "chat"
      sendOptions.delayScale = guideDelayScale(config.reply, replyKind)
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
        e: { reply: value => this.replyPacer.send({ ...sendOptions, value, kind: "sticker",
          isBatchFirst: !pacing.some(item => item.success),
          options: { ...config.reply, sendRetries: 0 },
          canSend: async () => {
            const latest = await this.config.load()
            return stickerOptions(latest).enabled && stickerOptions(latest).mode === "legacy" && await sendOptions.canSend()
          }, reply: image => replyEvent.reply(image) }) },
        emotion: result.emotion,
        config,
        stickers: this.config.getStickers(),
        root: this.config.root || pluginRoot,
        logger: this.logger,
      }
      const legacyStickers = stickerOptions(config).enabled && stickerOptions(config).mode === "legacy"
      if (legacyStickers && config.stickers?.sendAfterText === false) await this.stickerSender(stickerInput)
      const sent = await sendReplySegments({
        ...sendOptions,
        e: replyEvent,
        text: result.reply,
        firstReply: !pacing.some(item => item.success),
        onSent: this.archiveReply({ config, session, messages: replyBatchMessages, replyEvent, contextJob }),
      })
      const textComplete = sent.length > 0 && sent.length === splitReply(result.reply, config.reply).length
      if (legacyStickers && config.stickers?.sendAfterText !== false && textComplete && (await sendOptions.canSend()))
        await this.stickerSender(stickerInput)
      if (stickerJob && textComplete) {
        const stickerAllowed = async () => await this.stickersAllowed(stickerJob) && await sendOptions.canSend()
        const previous = session.sessionBatches?.at(-1)
        // No long-term memory or imported history is copied into this optional selection request.
        const context = { current: replyBatchMessages.filter(m => !m.preTrigger).map(m => m.text).join("\n"),
          reply: sent.join("\n"), recent: previous ? [...(previous.messages || []).map(m => m.text), previous.reply || ""].join("\n") : "" }
        try {
          await this.stickerSelector.send({ config, rawIntent: response.data.stickerIntent, context, client: this.client,
            signal: stickerJob.controller.signal, allowed: stickerAllowed,
            trace: { sessionId: session.id, sessionKey: session.sessionKey },
            log: (event, data) => this.modelLogger.write(event, data, config),
            sendImage: readImage => this.replyPacer.send({ ...sendOptions, value: null, kind: "sticker",
              signal: stickerJob.controller.signal,
              isBatchFirst: false, options: { ...config.reply, sendRetries: 0 }, canSend: stickerAllowed,
              reply: async () => {
                const bytes = await readImage()
                if (!bytes || !(await stickerAllowed())) return false
                return replyEvent.reply(globalThis.segment?.image?.(bytes) || { type: "image", file: bytes })
              } }),
          })
        } catch { this.logger("warn", "可选表情处理失败，已发送文字不受影响") }
      }
      await this.modelLogger.write(
        "reply_sent",
        {
          type: "chat",
          sessionId: session.id,
          sessionKey: session.sessionKey,
          scene: session.scene,
          groupId: session.groupId,
          reply: result.reply,
          replyKind,
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
      sendOptions.delayScale = 1
      if (researchJob?.controller.signal.aborted || contextJob?.controller.signal.aborted || error?.code === "search_cancelled")
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
      if (stickerJob) { stickerJob.controller.abort(); this.stickerJobs.delete(stickerJob) }
      for (const message of replyBatchMessages) this.batchQuotes.delete(message.quoteToken)
      if (contextJob) { contextJob.controller.abort(); this.contextJobs.delete(contextJob) }
      if (researchJob) {
        researchJob.controller.abort()
        this.researchJobs.delete(researchJob)
      }
    }
  }

  archiveReply({ config, session, messages, replyEvent, contextJob }) {
    if (!recentOptions(config).enabled) return undefined
    const id = randomUUID(), createdAt = Date.now(), replies = []
    return ({ result, value, kind }) => this.retentionOperation(async () => {
      if (kind !== "text" || this.disposed || contextJob?.controller.signal.aborted) return
      const latest = await this.config.load()
      if (!latest.enabled || !recentOptions(latest).enabled ||
          session.scene === "group" && !isGroupAllowed(session.groupId, latest)) return
      const ids = Array.isArray(result?.message_id) ? result.message_id :
        [result?.message_id ?? result?.data?.message_id]
      // Only unambiguous single-message receipts provide a quote mapping.
      replies.push({ text: value, timestamp: Date.now(), userId: String(replyEvent.self_id || ""), displayName: "派蒙",
        namespace: messageNamespace(replyEvent), messageId: ids.length === 1 && ids[0] != null ? String(ids[0]) : "" })
      const evidence = this.researchContexts.get(session.id)
      const evidenceKey = evidence ? await this.webSearchService.saveEvidence?.(evidence, latest) || "" : ""
      await this.recentStore.record(latest, { session, messages, replies, id, createdAt, evidenceKey })
    })
  }

  retentionOperation(task) {
    const operation = this.retentionQueue.then(task)
    this.retentionQueue = operation.catch(() => {})
    return operation
  }

  async refreshRetention(config, force = false) {
    const o = recentOptions(config)
    const quoteScope = JSON.stringify([config.enabled, o.enabled, o.quoted, o.retentionMs, config.groupWhitelist])
    if (!config.enabled || !o.enabled || !o.quoted || this.quoteScope !== undefined && this.quoteScope !== quoteScope) {
      this.batchQuotes.clear()
      this.preparedQuotes = new WeakMap()
    }
    this.quoteScope = quoteScope
    for (const job of this.contextJobs)
      if (this.disposed || !config.enabled || !o.enabled || !config.deepseek?.apiKey ||
          config.deepseek.apiKey !== job.apiKey || job.quoteUsed && !o.quoted ||
          job.timestamps.some(t => Date.now() - t >= o.retentionMs) ||
          job.session.scene === "group" && !isGroupAllowed(job.session.groupId, config)) job.controller.abort()
    for (const pending of this.historyInitializations.values())
      if (pending.lookupQuote && (!config.enabled || !o.enabled || !o.quoted ||
          pending.groupId != null && !isGroupAllowed(pending.groupId, config))) pending.controller.abort()
    if (force || o.enabled || this.retentionStarted) {
      this.retentionStarted = true
      const signature = JSON.stringify([config.enabled, o, config.groupWhitelist,
        webSearchOptions(config), searchApiKey(config)])
      // Ordinary untriggered group traffic must not serialize every saved conversation.
      // Actual reads still prune immediately; idle cleanup runs at least once per minute.
      if (!force && this.retentionSignature === signature && Date.now() - this.retentionCheckedAt < 60000) return
      this.retentionSignature = signature
      this.retentionCheckedAt = Date.now()
      await this.retentionOperation(async () => {
        const latest = await this.config.load()
        await this.recentStore.configure(latest)
        await this.webSearchService.configure?.(latest)
      })
    }
  }

  async contextAllowed(job) {
    await this.refreshRetention(await this.config.load())
    return !job.controller.signal.aborted
  }

  revalidateResearch(config) {
    const partition = searchApiKey(config)
    if (this.lastSearchKey !== undefined && this.lastSearchKey !== partition ||
        !config.enabled || !webSearchOptions(config).enabled) this.researchContexts.clear()
    this.lastSearchKey = partition
    const ttl = webSearchOptions(config).cacheTtlMs
    for (const context of this.researchContexts.values()) context.sources = context.sources
      .filter(s => Date.now() - Date.parse(s.fetchedAt) < ttl)
      .map(s => ({ ...s, expiresAt: Date.parse(s.fetchedAt) + ttl }))
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

  cancelStickers(sessionKey) {
    for (const job of this.stickerJobs) if (job.session.sessionKey === sessionKey) job.controller.abort()
  }

  revalidateStickers(config) {
    if (contextualStickers(config) && config.stickers?.sendAfterText === false && !this.stickerMigrationWarned) {
      this.stickerMigrationWarned = true
      this.logger("warn", "语境表情模式只在文字全部成功后发送；sendAfterText:false 不适用。要保留先图后文，请显式设置 stickers.mode: legacy")
    }
    for (const job of this.stickerJobs)
      if (this.disposed || !config.enabled || !contextualStickers(config) || !config.deepseek?.apiKey ||
          config.deepseek.apiKey !== job.apiKey || config.deepseek.baseUrl !== job.baseUrl ||
          job.session.scene === "group" && !isGroupAllowed(job.session.groupId, config)) job.controller.abort()
  }

  async stickersAllowed(job) {
    this.revalidateStickers(await this.config.load())
    // A message may have arrived between flush taking its snapshot and this job registering.
    const current = this.buffer.get(job.session.sessionKey)
    if (current && (current.id !== job.session.id || current.pendingMessages.length)) job.controller.abort()
    return !job.controller.signal.aborted
  }

  async endSession(session) {
    this.cancelStickers(session.sessionKey)
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
    this.commands.dispose()
    this.disposed = true
    for (const job of this.stickerJobs) job.controller.abort()
    this.stickerJobs.clear()
    clearInterval(this.retentionTimer)
    for (const job of this.contextJobs) job.controller.abort()
    this.contextJobs.clear()
    this.batchQuotes.clear()
    this.preparedQuotes = new WeakMap()
    for (const job of this.researchJobs) job.controller.abort()
    this.researchJobs.clear()
    this.researchContexts.clear()
    this.followUps.dispose()
    this.replyPacer.dispose()
    for (const pending of this.historyInitializations.values()) pending.controller.abort()
    this.historyInitializations.clear()
    this.buffer.dispose()
    await this.retentionQueue
    await this.recentStore.tail
    await this.webSearchService.file?.tail
    this.recentStore.chats.clear()
    this.recentStore.loaded = false
    this.recentStore.saved = false
    this.webSearchService.cache?.clear()
    this.webSearchService.evidence?.clear()
    this.webSearchService.loaded = false
    await this.config.close?.()
    this.initialized = false
  }
}

export const paimonRuntime = new PaimonRuntime()
