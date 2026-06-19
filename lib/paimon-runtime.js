import { configManager, pluginRoot } from "./config.js"
import { ConversationBuffer } from "./conversation-buffer.js"
import { DeepSeekClient, DeepSeekError } from "./deepseek.js"
import { getKnowledgeContext } from "./knowledge-provider.js"
import { evaluateSessionMemory } from "./memory-compressor.js"
import { MemoryStore } from "./memory-store.js"
import { buildChatMessages, normalizeChatResponse } from "./prompt-builder.js"
import { sendReplySegments } from "./reply-splitter.js"
import { maybeSendSticker } from "./sticker-provider.js"
import {
  evaluateTrigger,
  extractText,
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
    knowledgeProvider = getKnowledgeContext,
    stickerSender = maybeSendSticker,
    logger = paimonLog,
  } = {}) {
    this.config = config
    this.logger = logger
    this.memoryStore = memoryStore || new MemoryStore({ logger })
    this.client =
      client ||
      new DeepSeekClient({
        getConfig: () => this.config.load(),
        logger,
      })
    this.knowledgeProvider = knowledgeProvider
    this.stickerSender = stickerSender
    this.initialized = false
    this.missingKeyWarned = false
    this.buffer = new ConversationBuffer({
      onReplyBatch: input => this.replyBatch(input),
      onSessionEnd: session => this.endSession(session),
      logger,
    })
  }

  async initialize({ watch = true } = {}) {
    await this.config.load()
    if (watch) await this.config.startWatching?.()
    this.initialized = true
    return this
  }

  async handleEvent(e) {
    const config = await this.config.load()
    if (!config.enabled) return false
    const text = extractText(e)
    const sessionKey = sessionKeyFor(e)
    const decision = evaluateTrigger({
      e,
      text,
      config,
      hasActiveSession: sessionKey ? this.buffer.has(sessionKey) : false,
    })
    if (!decision.accepted) return false

    if (!config.deepseek?.apiKey) {
      if (!this.missingKeyWarned) {
        this.logger("error", "paimon-plugin 未配置 DEEPSEEK_API_KEY")
        this.missingKeyWarned = true
        if (e.isMaster) await e.reply("paimon-plugin 尚未配置 DeepSeek API key")
      }
      return true
    }
    this.missingKeyWarned = false

    const message = messageFromEvent(e, decision.text)
    this.buffer.addMessage({
      sessionKey,
      scene: e.isGroup ? "group" : "private",
      groupId: e.group_id || "",
      message,
      debounceMs: config.conversation?.debounceMs,
      activeWindowMs: config.conversation?.activeWindowMs,
    })
    return true
  }

  async replyBatch({ session, replyBatchMessages, replyEvent }) {
    const config = await this.config.load()
    const memoryLimit = config.memory?.maxParticipantMemoriesForPrompt || 8
    const participantMemories =
      config.memory?.enabled && config.memory?.userMemoryEnabled
        ? await this.memoryStore.readMany(session.participants, memoryLimit)
        : {}
    const knowledge = await this.knowledgeProvider({
      e: replyEvent,
      session,
      replyBatchMessages,
      participantMemories,
      config,
    })
    const messages = buildChatMessages({
      session,
      replyBatchMessages,
      participantMemories,
      knowledge,
      config,
      persona: this.config.getPersona(),
    })

    try {
      const response = await this.client.complete({ messages, json: true, config })
      const result = normalizeChatResponse(response.data)
      const stickerInput = {
        e: replyEvent,
        emotion: result.emotion,
        config,
        stickers: this.config.getStickers(),
        root: pluginRoot,
        logger: this.logger,
      }
      if (config.stickers?.sendAfterText === false) await this.stickerSender(stickerInput)
      const sent = await sendReplySegments({
        e: replyEvent,
        text: result.reply,
        options: config.reply,
        logger: this.logger,
      })
      if (config.stickers?.sendAfterText !== false) await this.stickerSender(stickerInput)
      return { ...result, sentSegments: sent, failed: sent.length === 0 }
    } catch (error) {
      this.logger("error", "DeepSeek 聊天回复失败", error)
      if (error instanceof DeepSeekError && error.silent) {
        if (replyEvent?.isMaster)
          await replyEvent.reply("DeepSeek API 鉴权或余额异常，请检查配置与账户状态")
        return { reply: "", emotion: "neutral", failed: true }
      }
      const fallback = "派蒙有点困了，稍后再聊吧"
      await replyEvent?.reply?.(fallback)
      return { reply: fallback, emotion: "neutral", failed: true }
    }
  }

  async endSession(session) {
    const config = await this.config.load()
    return evaluateSessionMemory({
      session,
      config,
      client: this.client,
      memoryStore: this.memoryStore,
      logger: this.logger,
    })
  }

  hasSession(sessionKey) {
    return this.buffer.has(sessionKey)
  }

  async dispose() {
    this.buffer.dispose()
    await this.config.close?.()
    this.initialized = false
  }
}

export const paimonRuntime = new PaimonRuntime()
