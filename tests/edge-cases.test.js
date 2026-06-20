import test from "node:test"
import assert from "node:assert/strict"
import { deepMerge } from "../lib/config.js"
import { DeepSeekClient, DeepSeekError } from "../lib/deepseek.js"
import { sendReplySegments, splitReply } from "../lib/reply-splitter.js"
import { evaluateTrigger } from "../lib/trigger.js"

test("昵称清洗后为空时仍形成可回复文本", () => {
  const result = evaluateTrigger({
    e: { isGroup: true, group_id: "1", user_id: "2", self_id: "3" },
    text: "派蒙",
    config: {
      trigger: {
        nicknames: ["派蒙"],
        stripTriggerName: true,
        groupNicknameTrigger: true,
        groupMentionTrigger: true,
        ignoreCommandPrefixes: ["#"],
      },
      conversation: {},
    },
  })
  assert.equal(result.accepted, true)
  assert.equal(result.text, "（用户在呼唤你）")
})

test("代码化列表保持为一条消息", () => {
  assert.deepEqual(
    splitReply("- 第一项\n- 第二项\n- 第三项", {
      maxSegmentLength: 100,
      maxSegments: 4,
      keepCodeBlockTogether: true,
    }),
    ["- 第一项\n- 第二项\n- 第三项"],
  )
})

test("分段发送失败会有限重试", async () => {
  let calls = 0
  const sent = await sendReplySegments({
    e: {
      reply: async () => {
        calls++
        return calls === 1 ? false : { message_id: "1" }
      },
    },
    text: "测试",
    options: { split: false, sendRetries: 1 },
  })
  assert.equal(calls, 2)
  assert.deepEqual(sent, ["测试"])
})

test("分段发送延迟随即将发送的分句长度增长", async () => {
  const delays = []
  let randomCalls = 0
  const sent = await sendReplySegments({
    e: { reply: async value => ({ message_id: value }) },
    text: "甲\n中等长度\n这是一个明显更长的分句内容",
    options: {
      minDelayMs: 100,
      maxDelayMs: 1100,
      minSegmentLength: 1,
      maxSegmentLength: 20,
      maxSegments: 4,
    },
    sleep: async delay => delays.push(delay),
    random: () => {
      randomCalls++
      return 0.5
    },
  })

  assert.equal(sent.length, 3)
  assert.equal(delays.length, 2)
  assert.ok(delays[0] >= 100)
  assert.ok(delays[1] <= 1100)
  assert.ok(delays[1] > delays[0])
  assert.equal(randomCalls, 1)
})

test("DeepSeek 超时转换为可识别错误", async () => {
  const client = new DeepSeekClient({
    fetchImpl: async (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted")
          error.name = "AbortError"
          reject(error)
        })
      }),
  })
  await assert.rejects(
    client.complete({
      messages: [{ role: "user", content: "x" }],
      config: {
        deepseek: {
          apiKey: "test",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
          timeoutMs: 5,
          maxRetries: 0,
          thinking: { type: "disabled" },
        },
      },
    }),
    error => error instanceof DeepSeekError && error.code === "timeout",
  )
})

test("用户配置进行深合并而不是覆盖整个分组", () => {
  assert.deepEqual(
    deepMerge(
      { deepseek: { model: "deepseek-v4-flash", timeoutMs: 60000 }, enabled: true },
      { deepseek: { timeoutMs: 1000 } },
    ),
    { deepseek: { model: "deepseek-v4-flash", timeoutMs: 1000 }, enabled: true },
  )
})
