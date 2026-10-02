import test from "node:test"
import assert from "node:assert/strict"
import { PaimonRuntime } from "../lib/paimon-runtime.js"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test("私聊事件贯通触发、回复、session 结束和记忆评估", async () => {
  const cfg = {
    enabled: true,
    trigger: {
      nicknames: ["派蒙"],
      privateTrigger: true,
      groupMentionTrigger: true,
      groupNicknameTrigger: true,
      ignoreBotSelf: true,
      ignoreCommandPrefixes: ["#", "＃", "*", "%"],
    },
    conversation: {
      debounceMs: 5,
      activeWindowMs: 10,
      collectAllNonCommandInActiveGroupSession: true,
      collectPrivateFollowupWithoutTrigger: true,
      maxContextBatches: 4,
    },
    deepseek: {
      apiKey: "test",
      model: "deepseek-flash",
      thinking: { type: "disabled" },
    },
    memory: {
      enabled: true,
      userMemoryEnabled: true,
      maxParticipantMemoriesForPrompt: 8,
      maxMemoryCharsForPrompt: 1000,
      evaluationModel: "deepseek-flash",
      evaluationMaxTokens: 1000,
      evaluationTemperature: 0.2,
      maxSessionMessagesForEvaluation: 100,
      maxSessionCharsForEvaluation: 10000,
      maxStoredMemoryChars: 8000,
    },
    runtime: { saveFailedMemoryEvaluations: true, maxFailedMemoryEvaluationFiles: 20 },
    reply: { split: false, minDelayMs: 0, maxDelayMs: 0, sendRetries: 0 },
    stickers: { enabled: false, sendAfterText: true },
  }
  const config = {
    load: async () => cfg,
    getPersona: () => "派蒙人设",
    getStickers: () => ({}),
    close: async () => {},
  }
  let apiCalls = 0
  const client = {
    complete: async ({ messages }) => {
      apiCalls++
      if (messages[0].content.includes("评估一次 QQ"))
        return {
          content: '{"version":1}',
          data: {
            version: 1,
            sessionSummary: "测试",
            userMemoryUpdates: [
              {
                userId: "123456",
                shouldUpdateMemory: true,
                updateReason: "明确要求",
                newMemory: "喜欢简洁回答",
              },
            ],
          },
        }
      return {
        content: '{"reply":"你好呀","emotion":"happy"}',
        data: { reply: "你好呀", emotion: "happy" },
      }
    },
  }
  const applied = []
  const logged = []
  const modelLogger = {
    write: async (event, data) => {
      logged.push({ event, data })
      return true
    },
  }
  const memoryStore = {
    readMany: async participants =>
      Object.fromEntries(
        Object.values(participants).map(item => [
          item.userId,
          { userId: item.userId, displayName: item.displayName, memory: "" },
        ]),
      ),
    applySessionEvaluation: async value => applied.push(value),
    saveFailedEvaluation: async () => {},
  }
  const runtime = new PaimonRuntime({
    config,
    client,
    memoryStore,
    modelLogger,
    stickerSender: async () => false,
    logger: () => {},
  })
  const replies = []
  const event = {
    isPrivate: true,
    isGroup: false,
    self_id: "999999",
    user_id: "123456",
    sender: { nickname: "旅行者" },
    message: [{ type: "text", text: "请记住我喜欢简洁回答" }],
    reply: async value => {
      replies.push(value)
      return { message_id: String(replies.length) }
    },
  }
  assert.equal(await runtime.handleEvent(event), true)
  await wait(60)
  assert.deepEqual(replies, ["你好呀"])
  assert.equal(apiCalls, 2)
  assert.equal(applied.length, 1)
  assert.equal(applied[0].updates[0].newMemory, "喜欢简洁回答")
  assert.deepEqual(
    logged.map(item => item.event),
    ["reply_sent", "memory_applied"],
  )
  assert.equal(logged[0].data.reply, "你好呀")
  assert.equal(runtime.hasSession("private:user:123456"), false)
  await runtime.dispose()
})
