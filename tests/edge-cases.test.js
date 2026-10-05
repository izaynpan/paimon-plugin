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

test("旧 maxSegments 不再限制条数，保留内容且不切坏 emoji", () => {
  const text = "😀".repeat(90)
  const segments = splitReply(text, { maxSegmentLength: 15, maxSegments: 3 })
  assert.deepEqual(segments.map(part => [...part].length), [15, 15, 15, 15, 15, 15])
  assert.equal(segments.join(""), text)
  const sentences = Array.from({ length: 9 }, (_, index) => String(index).repeat(20) + "！")
  const grouped = splitReply(sentences.join(""))
  assert.deepEqual(grouped.map(part => part.length), Array(9).fill(21))
  assert.equal(grouped.join(""), sentences.join(""))
  const fence = String.fromCharCode(96).repeat(3)
  const code = fence + "js\n" + "x".repeat(1000) + "\n" + fence
  assert.deepEqual(splitReply(code), [code])
})

test("说明与追问分开发送，连续追问保持一起", () => {
  const explanation = "不过我只记得个大概，细枝末节可不敢乱说——万一讲错了，旅行者又要笑派蒙吹牛了"
  const questions = "你是想听哪一段？还是说你在渊下宫碰上什么了？"
  assert.deepEqual(splitReply(explanation + "。" + questions, { maxSegments: 1 }), [explanation, questions])
  assert.deepEqual(splitReply("先休息。你饿了吗？要吃什么？吃饱再出发吧。"), [
    "先休息", "你饿了吗？要吃什么？", "吃饱再出发吧",
  ])
})

test("短句合并保留内部句号，显式换行不会被吞掉", () => {
  assert.deepEqual(splitReply("先休息。吃点东西。"), ["先休息。吃点东西"])
  assert.deepEqual(splitReply("先休息\n吃点东西\n\n要去哪里？"), ["先休息", "吃点东西", "要去哪里？"])
  assert.deepEqual(splitReply("这是记载。\n\n你想听什么？"), ["这是记载", "你想听什么？"])
  assert.deepEqual(splitReply("她说“先休息。”你想去哪里？"), ["她说“先休息。”", "你想去哪里？"])
})

test("问句合并不超过单段长度，关闭拆分时保留原文", () => {
  const questions = Array(5).fill("你想先去看看哪个地方？")
  const segments = splitReply(questions.join(""), { maxSegmentLength: 24 })
  assert.ok(segments.every(part => [...part].length <= 24))
  assert.equal(segments.join(""), questions.join(""))
  assert.deepEqual(splitReply("说明。你想听什么？", { split: false }), ["说明。你想听什么？"])
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
