import test from "node:test"
import assert from "node:assert/strict"
import { ReplyPacer, guideDelayScale } from "../lib/reply-pacer.js"
import { sendReplySegments } from "../lib/reply-splitter.js"
import { PaimonRuntime } from "../lib/paimon-runtime.js"

function clock(t, hooks = {}) {
  let time = 1000000
  const waits = [], sent = [], trace = []
  const pacer = new ReplyPacer({ now: () => time, random: () => 0.5,
    sleep: async ms => { waits.push(ms); time += ms; await hooks.afterWait?.() } })
  t.after(() => pacer.dispose())
  const reply = async value => { sent.push({ value, at: time }); return true }
  const send = (text, extra = {}) => sendReplySegments({ e: { reply }, text, pacer,
    key: "group:1", onTiming: item => trace.push(item), ...extra })
  return { pacer, waits, sent, trace, reply, send, advance: ms => { time += ms } }
}

test("首条按接收时间计时，跨API批次的20/40/60字间隔与同批分段一致", async t => {
  for (const [length, gap] of [[20, 8000], [40, 14800], [60, 21600]]) {
    const f = clock(t)
    const startedAt = f.pacer.now()
    f.advance(4000) // debounce + API, already elapsed from the user's perspective
    const text = "甲".repeat(length)
    await f.send(text, { startedAt, options: { split: false } })
    assert.equal(f.sent[0].at - startedAt, gap)
    const nextStartedAt = f.pacer.now()
    f.advance(4000)
    await f.send(text, { startedAt: nextStartedAt, options: { split: false } })
    await f.send(text + "\n" + text)
    assert.deepEqual(f.sent.slice(1).map((item, i) => item.at - f.sent[i].at), [gap, gap, gap])
    assert.deepEqual(f.waits, [gap - 4000, gap - 4000, gap, gap])
    assert.equal(f.trace[1].previousLength, length)
    assert.equal(f.trace[1].actualGapMs, gap)
  }
})

test("慢API与长时间停顿只会拉长间隔，不额外叠加完整等待", async t => {
  const f = clock(t), startedAt = f.pacer.now()
  f.advance(30000)
  await f.send("甲".repeat(60), { startedAt })
  const nextStartedAt = f.pacer.now()
  f.advance(30000)
  await f.send("乙".repeat(20), { startedAt: nextStartedAt })
  assert.deepEqual(f.waits, [])
  assert.equal(f.trace[0].firstLatencyMs, 30000)
  assert.equal(f.trace[1].actualGapMs, 30000)
})

test("跨轮长句后的短句仍按上一条阅读长度等待", async t => {
  const f = clock(t)
  await f.send("甲".repeat(60))
  f.advance(4000)
  await f.send("乙".repeat(20))
  assert.equal(f.sent[1].at - f.sent[0].at, 21600)
  assert.equal(f.waits[1], 17600)
})

test("跨轮随机抖动仍为±10%，短句下限4秒、长句上限24秒", async t => {
  for (const [sample, length, gap] of [[0, 40, 13320], [1, 40, 16280], [0, 1, 4000], [1, 180, 24000]]) {
    const f = clock(t)
    f.pacer.random = () => sample
    await f.send("甲".repeat(length))
    await f.send("乙".repeat(length))
    assert.deepEqual(f.waits, [gap, gap])
  }
})

test("关闭拆分及结构保护的单条回复也等待，旧预算不会压缩长回复", async t => {
  const f = clock(t)
  await f.send("甲".repeat(60), { options: { split: false, maxTotalDelayMs: 0 } })
  await f.send("{\"text\":\"" + "乙".repeat(60) + "\"}")
  await f.send(Array(6).fill("丙".repeat(80)).join("\n"), { options: { maxTotalDelayMs: 30000 } })
  assert.equal(f.sent.length, 8)
  assert.equal(f.waits[0], 21600)
  assert.ok(f.waits.slice(1).every(ms => ms === 24000))
})

test("同一会话并发发送串行限速，不同群私聊各自计时", async t => {
  const f = clock(t)
  await Promise.all([f.send("甲".repeat(20)), f.send("乙".repeat(20))])
  assert.equal(f.sent[1].at - f.sent[0].at, 8000)
  await f.send("丙", { key: "group:2" })
  await f.send("丁", { key: "private:1" })
  assert.deepEqual(f.waits, [8000, 8000, 4000, 4000])
})

test("协议确认完成后才更新时钟；发送失败和重试不会伪造最近发言", async t => {
  const f = clock(t)
  await f.send("甲".repeat(20), { e: { reply: async value => {
    f.advance(500)
    return f.reply(value)
  } } })
  let attempts = 0
  const failed = await f.send("乙".repeat(40), { e: { reply: async () => { attempts++; return false } },
    options: { sendRetries: 1 } })
  assert.deepEqual(failed, [])
  assert.equal(attempts, 2)
  const previous = f.pacer.states.get("group:1")
  assert.equal(previous.lastSentAt, f.sent[0].at)
  assert.equal(previous.lastLength, 20)
  await f.send("丙".repeat(20))
  assert.equal(f.trace[2].previousSentAt, f.sent[0].at)
  assert.equal(f.trace[2].waitMs, 8000)
  assert.equal(f.trace[2].firstLatencyMs, 8000)
})

test("等待中撤销允许或dispose，不再发消息、不更新发送记录", async t => {
  for (const dispose of [false, true]) {
    let allowed = true
    const f = clock(t, { afterWait: () => { allowed = false; if (dispose) f.pacer.dispose() } })
    assert.deepEqual(await f.send("甲".repeat(20), { canSend: () => allowed }), [])
    assert.deepEqual(f.sent, [])
    assert.equal(f.trace[0].success, false)
    assert.equal(f.trace[0].sentAt, null)
  }
})

test("dispose能立即取消真实定时器，清理会话状态和排队发送", async () => {
  const pacer = new ReplyPacer({ random: () => 0.5 })
  let replies = 0
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  const input = { key: "g", value: "甲", reply: async () => { replies++; return true },
    canSend: () => { entered(); return true } }
  const first = pacer.send(input), second = pacer.send(input)
  await ready
  pacer.dispose()
  assert.deepEqual(await Promise.all([first, second]), [false, false])
  assert.equal(replies, 0)
  assert.equal(pacer.states.size, 0)
})

function runtimeFixture(t, f, { stickers = false, before = false } = {}) {
  const cfg = { enabled: true, deepseek: { apiKey: "test" }, memory: { enabled: false },
    trigger: { privateTrigger: true },
    conversation: { debounceMs: 100000, activeWindowMs: 90000 },
    reply: { split: false }, stickers: { enabled: stickers, mode: "legacy", sendAfterText: !before } }
  const logs = []
  let response = { reply: "甲".repeat(20), emotion: "happy" }
  const runtime = new PaimonRuntime({ replyPacer: f.pacer,
    config: { load: async () => cfg, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async () => { f.advance(1000); return { data: response } } },
    modelLogger: { write: async (event, data) => logs.push({ event, data }) },
    stickerSender: async ({ e }) => stickers && e.reply({ type: "image" }), logger: () => {},
  })
  t.after(() => runtime.dispose())
  const e = { isGroup: false, isPrivate: true, user_id: "1", self_id: "9", msg: "派蒙", reply: f.reply }
  const turn = async (event = e) => {
    await runtime.handleEvent(event)
    f.advance(3000)
    await runtime.buffer.flush(event.isGroup ? "group:" + event.group_id : "private:user:1")
  }
  return { cfg, logs, runtime, e, turn, respond: value => { response = value } }
}

test("真实runtime跨批次计时，消息合并/API耗时计入，结束session后仍记得上一条", async t => {
  const f = clock(t), r = runtimeFixture(t, f)
  await r.turn()
  await r.turn()
  await r.runtime.buffer.finish("private:user:1")
  await r.turn()
  assert.deepEqual(f.sent.map(x => x.at), [1008000, 1016000, 1024000])
  assert.deepEqual(f.waits, [4000, 4000, 4000])
  const records = r.logs.filter(x => x.event === "reply_sent").map(x => x.data.pacing[0])
  assert.deepEqual(records.map(x => x.waitMs), [4000, 4000, 4000])
  assert.equal(records[1].actualGapMs, 8000)
  assert.equal(records[0].firstLatencyMs, 8000)
})

test("主动沉默不重置最近成功发送时间", async t => {
  const f = clock(t), r = runtimeFixture(t, f)
  r.cfg.trigger.groupMentionTrigger = true
  r.cfg.conversation.selectiveGroupReply = true
  const event = { ...r.e, isGroup: true, isPrivate: false, group_id: "88", atBot: true }
  const answer = { shouldReply: true, reason: "direct_address", reply: "甲".repeat(40), emotion: "neutral" }
  r.respond(answer)
  await r.turn(event)
  const sentAt = f.sent[0].at
  r.respond({ shouldReply: false, reason: "talking_to_others", reply: "", emotion: "neutral" })
  await r.turn(event)
  assert.equal(f.pacer.states.get("group:88").lastSentAt, sentAt)
  r.respond(answer)
  await r.turn(event)
  assert.equal(f.sent[1].at - sentAt, 18800)
  assert.equal(r.logs.at(-1).data.pacing[0].firstLatencyMs, 14800)
  assert.ok(r.logs.some(x => x.event === "reply_skipped"))
})

test("表情包也使用同一发送时钟，前置或后置都不会紧贴文字", async t => {
  for (const before of [true, false]) {
    const f = clock(t), r = runtimeFixture(t, f, { stickers: true, before })
    await r.turn()
    await r.turn()
    assert.equal(f.sent.length, 4)
    assert.deepEqual(f.sent.slice(1).map((x, i) => x.at - f.sent[i].at),
      before ? [8000, 7200, 8000] : [7200, 8000, 7200])
    assert.ok(r.logs[0].data.pacing.some(x => x.kind === "sticker"))
  }
})

test("runtime等待期间白名单撤销或关闭插件，不会发送迟到回复", async t => {
  for (const revokeGroup of [true, false]) {
    let r
    const f = clock(t, { afterWait: () => {
      if (revokeGroup) r.cfg.groupWhitelist.groups = []
      else r.cfg.enabled = false
    } })
    r = runtimeFixture(t, f)
    r.cfg.groupWhitelist = { enabled: true, groups: ["88"] }
    r.cfg.trigger.groupMentionTrigger = true
    r.cfg.conversation.preTrigger = { enabled: false }
    await r.turn({ ...r.e, isGroup: true, group_id: "88", atBot: true })
    assert.deepEqual(f.sent, [])
    assert.equal(r.logs.find(x => x.event === "reply_sent").data.failed, true)
  }
})

test("错误兜底也遵循跨轮节奏并记录实际间隔", async t => {
  const f = clock(t), r = runtimeFixture(t, f)
  await r.turn()
  r.runtime.client.complete = async () => { f.advance(1000); throw new Error("test error") }
  await r.turn()
  assert.equal(f.sent[1].at - f.sent[0].at, 7200)
  const record = r.logs.at(-1).data
  assert.equal(record.failed, true)
  assert.equal(record.pacing[0].kind, "fallback")
  assert.equal(record.pacing[0].actualGapMs, 7200)
})

test("异步权限检查期间dispose，也不会绕过取消继续发送", async t => {
  const f = clock(t)
  const sent = await f.send("甲", { canSend: async () => { f.pacer.dispose(); return true } })
  assert.deepEqual(sent, [])
  assert.deepEqual(f.sent, [])
  assert.deepEqual(f.waits, [])
})

test("用户停顿后再问，每批首条仍从新消息算20/40/60字反应时间", async t => {
  for (const [length, gap] of [[20, 8000], [40, 14800], [60, 21600]]) {
    const f = clock(t), r = runtimeFixture(t, f)
    r.respond({ reply: "甲".repeat(length), emotion: "neutral" })
    await r.turn()
    f.advance(34000)
    const receivedAt = f.pacer.now()
    await r.turn()
    assert.equal(f.sent[1].at - receivedAt, gap)
    const timing = r.logs.at(-1).data.pacing[0]
    assert.equal(timing.isBatchFirst, true)
    assert.equal(timing.reactionStartedAt, receivedAt)
    assert.equal(timing.reactionTargetMs, gap)
    assert.equal(timing.firstLatencyMs, gap)
    assert.equal(timing.waitMs, gap - 4000)
  }
})

test("批次合并以最后一条用户消息接收时间为准，不使用第一条或协议历史时间", async t => {
  const f = clock(t), r = runtimeFixture(t, f)
  await r.runtime.handleEvent({ ...r.e, time: 1 })
  f.advance(5000)
  const lastReceivedAt = f.pacer.now()
  await r.runtime.handleEvent({ ...r.e, time: 1, msg: "再补充一句" })
  f.advance(3000)
  await r.runtime.buffer.flush("private:user:1")
  assert.equal(f.sent[0].at - lastReceivedAt, 8000)
  assert.equal(r.logs.at(-1).data.pacing[0].reactionStartedAt, lastReceivedAt)
  const messages = r.runtime.buffer.get("private:user:1").sessionBatches[0].messages
  assert.equal(messages.length, 2)
  assert.ok(messages.every(message => !("receivedAt" in message)))
})

test("首条反应时间与连续间隔取较晚期限，不相加；后续分段不重算反应时间", async t => {
  const f = clock(t)
  await f.send("甲".repeat(20))
  const previousSentAt = f.sent[0].at
  f.advance(1000)
  const startedAt = f.pacer.now()
  f.advance(4000)
  await f.send("乙".repeat(60) + "\n" + "丙".repeat(20), { startedAt })
  assert.equal(f.sent[1].at - startedAt, 21600)
  assert.equal(f.sent[1].at - previousSentAt, 22600)
  assert.equal(f.sent[2].at - f.sent[1].at, 21600)
  assert.deepEqual(f.trace.map(x => x.isBatchFirst), [true, true, false])
  assert.equal(f.trace[2].reactionTargetMs, null)
  assert.equal(f.trace[2].firstLatencyMs, null)
})

test("攻略倍率只接受guide分类，旧格式/非法分类保持普通节奏，倍率有界", () => {
  for (const kind of [undefined, null, "chat", "GUIDE", "search", { guide: true }])
    assert.equal(guideDelayScale({ guideDelayScale: 0.5 }, kind), 1)
  assert.equal(guideDelayScale(undefined, "guide"), 0.5)
  for (const value of [null, "", "bad", false, NaN, Infinity])
    assert.equal(guideDelayScale({ guideDelayScale: value }, "guide"), 0.5)
  for (const [value, expected] of [[0, 0.1], [-2, 0.1], [2, 1], [1, 1], ["0.75", 0.75]])
    assert.equal(guideDelayScale({ guideDelayScale: value }, "guide"), expected)
})

test("攻略首条和分段目标减半，包括抖动及上下限，保留自定义延时配置", async t => {
  for (const [sample, length, gap] of [[0.5, 20, 4000], [0.5, 40, 7400], [0.5, 60, 10800],
    [0, 40, 6660], [1, 40, 8140], [0, 1, 2000], [1, 180, 12000]]) {
    const f = clock(t); f.pacer.random = () => sample
    await f.send("甲".repeat(length), { delayScale: 0.5 })
    await f.send("乙".repeat(length), { delayScale: 0.5 })
    assert.deepEqual(f.waits, [gap, gap])
    assert.equal(f.trace[0].reactionTargetMs, gap)
    assert.equal(f.trace[1].delayScale, 0.5)
  }
  const f = clock(t)
  await f.send("甲", { delayScale: 0.5, options: { minDelayMs: 6000, maxDelayMs: 6000 } })
  assert.deepEqual(f.waits, [3000])
})

test("攻略慢API已超过目标时不补等，不将API耗时或剩余等待直接减半", async t => {
  const f = clock(t), startedAt = f.pacer.now()
  f.advance(5000)
  await f.send("甲".repeat(40), { delayScale: 0.5, startedAt })
  assert.deepEqual(f.waits, [2400])
  const next = f.pacer.now(); f.advance(15000)
  await f.send("乙".repeat(40), { delayScale: 0.5, startedAt: next })
  assert.deepEqual(f.waits, [2400])
  assert.equal(f.trace[1].firstLatencyMs, 15000)
})

test("runtime攻略多段加速，切回闲聊恢复原节奏且仍共用成功发送时钟", async t => {
  const f = clock(t), r = runtimeFixture(t, f)
  r.cfg.reply.split = true
  r.respond({ reply: "甲".repeat(40) + "\n" + "乙".repeat(20), emotion: "neutral", replyKind: "guide" })
  await r.turn()
  assert.deepEqual(f.waits, [3400, 7200])
  const guide = r.logs.at(-1).data
  assert.equal(guide.replyKind, "guide")
  assert.deepEqual(guide.pacing.map(x => x.delayScale), [0.5, 0.5])
  const previousSentAt = f.sent.at(-1).at
  r.respond({ reply: "丙".repeat(20), emotion: "neutral", replyKind: "chat" })
  await r.turn()
  const chat = r.logs.at(-1).data
  assert.equal(chat.replyKind, "chat")
  assert.equal(chat.pacing[0].delayScale, 1)
  assert.equal(chat.pacing[0].previousSentAt, previousSentAt)
  assert.equal(f.sent.at(-1).at - previousSentAt, 8000)
  // New batches consume the current config; 1 disables acceleration.
  r.cfg.reply.guideDelayScale = 1
  r.respond({ reply: "丁".repeat(20), emotion: "neutral", replyKind: "guide" })
  await r.turn()
  assert.equal(r.logs.at(-1).data.pacing[0].targetGapMs, 8000)
})

test("攻略加速不依赖联网：知识库直接答与搜索后最终回答都应用倍率", async t => {
  for (const web of [false, true]) {
    const f = clock(t), r = runtimeFixture(t, f)
    r.cfg.webSearch = { enabled: web }
    r.cfg.knowledge = { enabled: true }
    let calls = 0, lookups = 0
    r.runtime.knowledgeProvider = async () => web ? { status: "miss" } :
      { status: "complete", freshness: "applicable", text: "合成攻略依据" }
    r.runtime.webSearchService = { lookup: async () => { lookups++; f.advance(1000); return [] } }
    r.runtime.client.complete = async () => {
      f.advance(1000)
      if (web && calls++ === 0) return { data: { action: "search", scope: "teyvat", reason: "missing",
        query: "原神 配队", missingFacts: ["角色机制"] } }
      return { data: { reply: "甲".repeat(40), emotion: "neutral", replyKind: "guide" } }
    }
    await r.turn()
    const timing = r.logs.find(x => x.event === "reply_sent").data.pacing[0]
    assert.equal(timing.delayScale, 0.5)
    assert.equal(timing.firstLatencyMs, 7400)
    assert.equal(lookups, web ? 1 : 0)
  }
})

test("攻略同批表情同步加速，之后错误兜底仍用普通节奏", async t => {
  const f = clock(t), r = runtimeFixture(t, f, { stickers: true })
  r.respond({ reply: "甲".repeat(40), emotion: "happy", replyKind: "guide" })
  await r.turn()
  assert.deepEqual(r.logs.at(-1).data.pacing.map(x => x.targetGapMs), [7400, 7200])
  r.runtime.client.complete = async () => { throw Error("test error") }
  await r.turn()
  assert.equal(r.logs.at(-1).data.pacing[0].delayScale, 1)
})
