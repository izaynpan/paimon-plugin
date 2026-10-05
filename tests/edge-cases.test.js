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
    text: "甲".repeat(20) + "\n" + "乙".repeat(30) + "\n" + "丙".repeat(60),
    options: {
      minSegmentLength: 1,
      maxSegmentLength: 180,
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
  assert.deepEqual(delays, [3900, 6600])
  assert.equal(randomCalls, 1)
})

test("首句立即发，长句后的短回复留足阅读时间", async () => {
  const events = []
  await sendReplySegments({
    e: { reply: async text => { events.push(text.length); return true } },
    text: "甲".repeat(60) + "\n" + "乙".repeat(20),
    sleep: async ms => events.push(ms),
    random: () => 0.5,
  })
  assert.deepEqual(events, [60, 7200, 20])
})

test("整轮等待不超过预算且不丢失长回复", async () => {
  const parts = ["甲", "乙", "丙", "丁", "戊"].map(char => char.repeat(80))
  const delays = []
  const sent = await sendReplySegments({
    e: { reply: async () => true },
    text: parts.join("\n"),
    options: { maxSegments: 5 },
    sleep: async ms => delays.push(ms),
    random: () => 0.5,
  })
  assert.deepEqual(sent, parts)
  assert.deepEqual(delays, [4500, 4500, 4500, 4500])
})

test("随机节奏受区间约束，零延迟和预算优先配置有效", async () => {
  for (const [length, options, sample, expected] of [
    [30, {}, 0, 3510],
    [30, {}, 1, 4290],
    [1, { minSegmentLength: 1 }, 0, 2000],
    [180, {}, 1, 8000],
    [30, { minDelayMs: 0, maxDelayMs: 0 }, 0.5, 0],
    [30, { maxTotalDelayMs: 0 }, 0.5, 0],
    [30, { maxTotalDelayMs: 500 }, 0.5, 500],
  ]) {
    const delays = []
    await sendReplySegments({
      e: { reply: async () => true },
      text: "甲".repeat(length) + "\n" + "乙".repeat(length),
      options,
      sleep: async ms => delays.push(ms),
      random: () => sample,
    })
    assert.equal(delays.reduce((sum, ms) => sum + ms, 0), expected)
  }
})

test("超出条数时均衡分组，保留内容且不切坏 emoji", () => {
  const text = "😀".repeat(90)
  const segments = splitReply(text, { maxSegmentLength: 15, maxSegments: 3 })
  assert.deepEqual(segments.map(part => [...part].length), [30, 30, 30])
  assert.equal(segments.join(""), text)
  const sentences = Array.from({ length: 9 }, (_, index) => String(index).repeat(20) + "！")
  const grouped = splitReply(sentences.join(""))
  assert.deepEqual(grouped.map(part => part.length), [63, 63, 63])
  assert.equal(grouped.join(""), sentences.join(""))
  const fence = String.fromCharCode(96).repeat(3)
  const code = fence + "js\n" + "x".repeat(1000) + "\n" + fence
  assert.deepEqual(splitReply(code), [code])
})

test("分段发送最终失败后不再等待或发送后续片段", async () => {
  const delays = []
  let attempts = 0
  const first = "甲".repeat(20)
  const sent = await sendReplySegments({
    e: { reply: async () => ++attempts === 1 },
    text: [first, "乙".repeat(20), "丙".repeat(20)].join("\n"),
    options: { sendRetries: 1 },
    sleep: async ms => delays.push(ms),
    random: () => 0.5,
  })
  assert.deepEqual(sent, [first])
  assert.equal(attempts, 3)
  assert.deepEqual(delays, [3000])
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
          model: "deepseek-flash",
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
      { deepseek: { model: "deepseek-flash", timeoutMs: 60000 }, enabled: true },
      { deepseek: { timeoutMs: 1000 } },
    ),
    { deepseek: { model: "deepseek-flash", timeoutMs: 1000 }, enabled: true },
  )
})
