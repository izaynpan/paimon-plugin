import test from "node:test"
import assert from "node:assert/strict"
import {
  buildMemoryEvaluationMessages,
  evaluateSessionMemory,
  validateMemoryEvaluation,
} from "../lib/memory-compressor.js"

const session = {
  id: "s1",
  scene: "group",
  groupId: "88",
  participants: {
    123456: { userId: "123456", displayName: "甲" },
    654321: { userId: "654321", displayName: "乙" },
  },
  sessionBatches: [
    {
      messages: [{ userId: "123456", displayName: "甲", text: "请记住我喜欢简洁回答" }],
      reply: "记住啦",
    },
  ],
}

const config = {
  deepseek: { apiKey: "x", model: "deepseek-flash" },
  memory: {
    enabled: true,
    userMemoryEnabled: true,
    evaluationModel: "deepseek-flash",
    evaluationMaxTokens: 1600,
    evaluationTemperature: 0.2,
    maxSessionMessagesForEvaluation: 100,
    maxSessionCharsForEvaluation: 12000,
    maxStoredMemoryChars: 8000,
  },
  runtime: { saveFailedMemoryEvaluations: true, maxFailedMemoryEvaluationFiles: 20 },
}

test("记忆评估 Prompt 包含旧记忆和完整 session", () => {
  const messages = buildMemoryEvaluationMessages({
    session,
    memories: {
      123456: { memory: "旧记忆" },
      654321: { memory: "" },
    },
    config,
  })
  assert.match(messages[0].content, /合法 JSON/)
  assert.match(messages[1].content, /旧记忆/)
  assert.match(messages[1].content, /喜欢简洁回答/)
})

test("只接受参与用户的合法记忆更新", () => {
  const result = validateMemoryEvaluation(
    {
      sessionSummary: "摘要",
      userMemoryUpdates: [
        {
          userId: "123456",
          shouldUpdateMemory: true,
          updateReason: "明确要求",
          newMemory: "喜欢简洁回答",
        },
        {
          userId: "999999",
          shouldUpdateMemory: true,
          updateReason: "越权",
          newMemory: "不应写入",
        },
      ],
    },
    ["123456", "654321"],
  )
  assert.equal(result.userMemoryUpdates.length, 1)
  assert.equal(result.userMemoryUpdates[0].userId, "123456")
})

test("评估成功应用更新，失败则保留旧记忆并保存材料", async () => {
  const applied = []
  const failed = []
  const memoryStore = {
    readMany: async () => ({
      123456: { memory: "旧记忆" },
      654321: { memory: "" },
    }),
    applySessionEvaluation: async value => applied.push(value),
    saveFailedEvaluation: async (...args) => failed.push(args),
  }
  const successClient = {
    complete: async () => ({
      content: '{"ok":true}',
      data: {
        version: 1,
        sessionSummary: "摘要",
        userMemoryUpdates: [
          {
            userId: "123456",
            shouldUpdateMemory: true,
            updateReason: "明确要求",
            newMemory: "喜欢简洁回答",
          },
        ],
      },
    }),
  }
  await evaluateSessionMemory({ session, config, client: successClient, memoryStore })
  assert.equal(applied.length, 1)
  assert.equal(applied[0].updates[0].newMemory, "喜欢简洁回答")

  const failureClient = { complete: async () => { throw new Error("api down") } }
  await evaluateSessionMemory({ session, config, client: failureClient, memoryStore })
  assert.equal(failed.length, 1)
  assert.equal(applied.length, 2)
  assert.deepEqual(applied[1].updates, [])
})
