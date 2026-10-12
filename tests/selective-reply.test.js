import test from "node:test"
import assert from "node:assert/strict"
import { messageFromEvent, extractText } from "../lib/trigger.js"
import { buildChatMessages, normalizeChatResponse } from "../lib/prompt-builder.js"
import { ConversationBuffer } from "../lib/conversation-buffer.js"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { evaluateSessionMemory } from "../lib/memory-compressor.js"

const skip = { shouldReply: false, reason: "talking_to_others", reply: "", emotion: "neutral" }
const answer = { shouldReply: true, reason: "direct_address", reply: "你好呀", emotion: "happy" }
const groupEvent = (text = "派蒙，你看呢", extra = {}) => ({
  isGroup: true, group_id: "88", user_id: "1", self_id: "9",
  sender: { nickname: "用户甲", card: "群名片甲" },
  message: [{ type: "text", text }], ...extra,
})

function fixture({ selective = true, responses = [skip], config = {} } = {}) {
  const cfg = {
    enabled: true, trigger: { nicknames: ["派蒙"], privateTrigger: true, ignoreBotSelf: true,
      groupMentionTrigger: true, groupNicknameTrigger: true, ignoreCommandPrefixes: ["#"] },
    groupWhitelist: { enabled: true, groups: ["88"] },
    conversation: { selectiveGroupReply: selective, debounceMs: 100000, activeWindowMs: 90000 },
    deepseek: { apiKey: "test" }, memory: { enabled: false }, reply: { split: false },
    stickers: { enabled: true, sendAfterText: false }, ...config,
  }
  const requests = [], logs = [], sent = [], stickers = []
  const runtime = new PaimonRuntime({
    config: { load: async () => cfg, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async input => { requests.push(input); return { data: responses.shift() } } },
    modelLogger: { write: async (event, data) => logs.push({ event, data }) },
    stickerSender: async () => stickers.push(true), logger: () => {},
  })
  const event = (text, extra) => groupEvent(text, { reply: async value => { sent.push(value); return true }, ...extra })
  return { runtime, cfg, requests, logs, sent, stickers, event }
}

test("群消息保留所有 @ 对象、机器人提及和称谓，不把 @别人当作硬过滤", () => {
  const e = groupEvent("", { message: [
    { type: "at", qq: "9" }, { type: "at", qq: "2", name: "用户乙" },
    { type: "at", qq: "3" }, { type: "at", qq: "2" },
    { type: "text", text: "派蒙，说的对吗" },
  ] })
  const message = messageFromEvent(e, extractText(e), ["派蒙"])
  assert.equal(message.mentionsBot, true)
  assert.deepEqual(message.mentionedUserIds, ["2", "3"])
  assert.deepEqual(message.matchedBotNames, ["派蒙"])
  assert.equal(message.nickname, "群名片甲")
  assert.deepEqual(messageFromEvent(e, "说的对吗", ["派蒙"]).matchedBotNames, ["派蒙"])
})

test("群聊开关控制输出协议，私聊和关闭状态保持原格式", () => {
  for (const [scene, enabled, expected] of [["group", true, true], ["group", false, false], ["private", true, false]]) {
    const messages = buildChatMessages({ session: { scene },
      replyBatchMessages: [messageFromEvent(groupEvent(), "派蒙，你看呢", ["派蒙"])],
      config: { conversation: { selectiveGroupReply: enabled } },
    })
    assert.equal(messages[0].content.includes('"shouldReply"'), expected)
    if (expected) {
      assert.match(messages[0].content, /同一批次混有旁人闲聊/)
      assert.match(messages[1].content, /"matchedBotNames":\["派蒙"\]/)
      assert.doesNotMatch(messages[1].content, /本次需要回复/)
    }
  }
})

test("只接受明确合法的主动沉默，空响应、类型错误及矛盾字段属于异常", () => {
  assert.deepEqual(normalizeChatResponse(skip, { selective: true }), skip)
  assert.deepEqual(normalizeChatResponse(answer, { selective: true }), answer)
  for (const value of [null, [], {}, { reply: "你好" }, { ...skip, shouldReply: "false" },
    { ...skip, reply: "不应发送" }, { ...skip, reply: " " }, { ...skip, emotion: "happy" },
    { ...skip, reason: "unknown" }, { ...skip, reason: "direct_address" }, { ...answer, reply: "" }]) {
    assert.throws(() => normalizeChatResponse(value, { selective: true }))
  }
  assert.throws(() => normalizeChatResponse(skip))
})

test("有效沉默只记 reply_skipped，不发文字或前置/后置表情，继续对话仍可回复", async () => {
  for (const sendAfterText of [false, true]) {
    const f = fixture({ responses: [skip, { ...answer, reason: "answering_paimon" }] })
    f.cfg.stickers.sendAfterText = sendAfterText
    try {
      await f.runtime.handleEvent(f.event("派蒙先听我们说"))
      await f.runtime.buffer.flush("group:88")
      assert.deepEqual(f.sent, [])
      assert.deepEqual(f.stickers, [])
      assert.deepEqual(f.logs.map(item => item.event), ["reply_skipped"])
      assert.equal(f.logs[0].data.decisionSource, "model")
      assert.equal(f.logs[0].data.batchNumber, 1)
      assert.equal(f.runtime.buffer.get("group:88").sessionBatches[0].skipped, true)
      await f.runtime.handleEvent(f.event("有一个，你猜猜看"))
      await f.runtime.buffer.flush("group:88")
      assert.deepEqual(f.sent, ["你好呀"])
      assert.equal(f.requests.length, 2)
      assert.match(f.requests[1].messages[1].content, /派蒙未回复，不代表同意/)
      assert.equal(f.logs[1].event, "reply_sent")
    } finally { await f.runtime.dispose() }
  }
})

test("批次混有 @别人和问派蒙时单次请求统一判断，不整批硬丢弃", async () => {
  const f = fixture({ responses: [answer] })
  try {
    await f.runtime.handleEvent(f.event("派蒙，你看呢"))
    await f.runtime.handleEvent(f.event("嗯", { user_id: "2", message: [{ type: "at", qq: "3" }, { type: "text", text: "嗯" }] }))
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.requests.length, 1)
    const body = f.requests[0].messages[1].content
    assert.match(body, /派蒙，你看呢/)
    assert.match(body, /"mentionedUserIds":\["3"\]/)
    assert.deepEqual(f.sent, ["你好呀"])
  } finally { await f.runtime.dispose() }
})

test("主动沉默开关不扩大白名单、命令、私聊和窗口外触发边界", async () => {
  const f = fixture()
  try {
    assert.equal(await f.runtime.handleEvent(f.event("@用户乙 明天见")), false)
    assert.equal(await f.runtime.handleEvent(f.event("派蒙", { group_id: "99" })), false)
    assert.equal(await f.runtime.handleEvent(f.event("#派蒙")), false)
    assert.equal(await f.runtime.handleEvent(f.event("派蒙", { user_id: "9" })), false)
    f.cfg.trigger.groupMentionTrigger = false
    assert.equal(await f.runtime.handleEvent(f.event("你好", { atBot: true })), false)
    f.cfg.trigger.privateTrigger = false
    assert.equal(await f.runtime.handleEvent(f.event("你好", { isGroup: false, isPrivate: true })), false)
    assert.equal(f.requests.length, 0)
  } finally { await f.runtime.dispose() }
})

test("关闭开关及私聊仍接受旧响应，错误决策不记录为主动沉默", async () => {
  for (const privateChat of [true, false]) {
    const f = fixture({ selective: privateChat, responses: [{ reply: "正常回复", emotion: "happy" }] })
    try {
      await f.runtime.handleEvent(f.event("派蒙", privateChat ? { isGroup: false, isPrivate: true } : {}))
      await f.runtime.buffer.flush(privateChat ? "private:user:1" : "group:88")
      assert.deepEqual(f.sent, ["正常回复"])
    } finally { await f.runtime.dispose() }
  }
  const f = fixture({ responses: [{ ...skip, shouldReply: "false" }] })
  try {
    await f.runtime.handleEvent(f.event())
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.logs.some(item => item.event === "reply_skipped"), false)
    assert.equal(f.logs[0].data.failed, true)
    assert.equal(f.runtime.buffer.get("group:88").sessionBatches[0].skipped, false)
  } finally { await f.runtime.dispose() }
})

function fakeClock() {
  let now = 0
  const timers = new Set()
  return {
    now: () => now,
    setTimer: (fn, ms) => { const timer = { fn, at: now + ms }; timers.add(timer); return timer },
    clearTimer: timer => timers.delete(timer),
    advance: async time => {
      now = time
      for (let i = 0; i < 50; i++) {
        const ready = [...timers].filter(timer => timer.at <= now)
        if (!ready.length) { await Promise.resolve(); if (![...timers].some(timer => timer.at <= now)) return }
        for (const timer of ready) if (timers.delete(timer)) timer.fn()
        await Promise.resolve()
      }
      throw new Error("timer loop")
    },
  }
}

test("首次及连续合法沉默均续90秒窗口，不更新实际回复时间，空闲到期结束一次", async () => {
  for (const firstReply of [true, false]) {
    const clock = fakeClock(), ended = []
    let result = firstReply ? { reply: "你好", sentSegments: ["你好"] } : { ...skip, skipped: true }
    const buffer = new ConversationBuffer({ ...clock, onReplyBatch: async () => result, onSessionEnd: async s => ended.push(s) })
    const add = () => buffer.addMessage({ sessionKey: "group:88", scene: "group", selectiveReply: true,
      message: messageFromEvent(groupEvent(), "派蒙"), debounceMs: 100000 })
    add()
    await clock.advance(1000)
    await buffer.flush("group:88")
    assert.equal(buffer.get("group:88").expiresAt, 91000)
    const lastReplyAt = firstReply ? 1000 : 0
    assert.equal(buffer.get("group:88").lastReplyAt, lastReplyAt)
    result = { ...skip, skipped: true, sentSegments: [] }
    for (const time of [30000, 60000, 89000, 120000]) {
      await clock.advance(time)
      assert.equal(buffer.has("group:88"), true)
      add()
      await buffer.flush("group:88")
      assert.equal(buffer.get("group:88").expiresAt, time + 90000)
      assert.equal(buffer.get("group:88").lastReplyAt, lastReplyAt)
    }
    await clock.advance(209999)
    assert.equal(buffer.has("group:88"), true)
    assert.equal(ended.length, 0)
    await clock.advance(210000)
    assert.equal(buffer.has("group:88"), false)
    assert.equal(ended.length, 1)
    await clock.advance(300000)
    assert.equal(ended.length, 1)
    buffer.dispose()
  }
})

test("截止前入队可完成判断，处理中到期拒绝普通续话，实际回复才重新计时", async () => {
  const clock = fakeClock(), ended = []
  let resolve
  const buffer = new ConversationBuffer({ ...clock, onReplyBatch: () => new Promise(r => { resolve = r }),
    onSessionEnd: async s => ended.push(s) })
  buffer.addMessage({ sessionKey: "group:88", scene: "group", selectiveReply: true,
    message: messageFromEvent(groupEvent(), "派蒙"), debounceMs: 100000 })
  const flushing = buffer.flush("group:88")
  await clock.advance(90001)
  assert.equal(buffer.has("group:88"), false)
  assert.equal(ended.length, 0)
  resolve({ reply: "你好", sentSegments: ["你好"] })
  await flushing
  assert.equal(buffer.has("group:88"), true)
  assert.equal(buffer.get("group:88").expiresAt, 180001)
  await clock.advance(180001)
  assert.equal(ended.length, 1)
  buffer.dispose()
})

test("持续到达的消息不能拖延判断，截止前批次判为沉默后重新计时", async () => {
  const clock = fakeClock(), ended = []
  let calls = 0
  const buffer = new ConversationBuffer({ ...clock, onReplyBatch: async () => { calls++; return { ...skip, skipped: true } },
    onSessionEnd: async s => ended.push(s) })
  const add = () => buffer.addMessage({ sessionKey: "group:88", scene: "group", selectiveReply: true,
    message: messageFromEvent(groupEvent(), "旁人交流"), activeWindowMs: 90, debounceMs: 30 })
  add()
  for (const time of [20, 40, 60, 80]) { await clock.advance(time); add() }
  await clock.advance(90)
  await clock.advance(91)
  assert.equal(calls, 1)
  assert.equal(buffer.has("group:88"), true)
  assert.equal(buffer.get("group:88").expiresAt, 180)
  assert.equal(ended.length, 0)
  await clock.advance(180)
  assert.equal(buffer.has("group:88"), false)
  assert.equal(ended.length, 1)
  buffer.dispose()
})

test("连续沉默跨过初始窗口后，无需点名也能接纳恢复发言并携带原上下文", async () => {
  const f = fixture({ responses: [skip, skip, answer] })
  const clock = fakeClock()
  f.runtime.buffer.dispose()
  f.runtime.buffer = new ConversationBuffer({ ...clock, onReplyBatch: input => f.runtime.replyBatch(input) })
  try {
    await f.runtime.handleEvent(f.event("派蒙先听着，不用回答"))
    await f.runtime.buffer.flush("group:88")
    const sessionId = f.runtime.buffer.get("group:88").id
    await clock.advance(60000)
    assert.equal(await f.runtime.handleEvent(f.event("我们打算去蒙德")), true)
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.runtime.buffer.get("group:88").expiresAt, 150000)
    assert.deepEqual(f.sent, [])
    await clock.advance(100000)
    assert.equal(await f.runtime.handleEvent(f.event("现在可以说话了，你觉得呢")), true)
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.runtime.buffer.get("group:88").id, sessionId)
    assert.equal(f.requests.length, 3)
    assert.match(f.requests[2].messages[1].content, /派蒙先听着，不用回答/)
    assert.match(f.requests[2].messages[1].content, /我们打算去蒙德/)
    assert.deepEqual(f.sent, ["你好呀"])
    assert.equal(f.runtime.buffer.get("group:88").lastReplyAt, 100000)
  } finally { await f.runtime.dispose() }
})

test("沉默批次不进入长期记忆评估，全程沉默不调用记忆API", async () => {
  let requests = 0
  const s = { participants: { 1: { userId: "1" }, 2: { userId: "2" } }, sessionBatches: [
    { skipped: true, messages: [{ userId: "2", text: "旁人的私事" }], reply: "" },
  ] }
  const input = { session: s, config: { memory: { enabled: true, userMemoryEnabled: true } },
    memoryStore: { readMany: async () => ({}), applySessionEvaluation: async () => {} },
    client: { complete: async ({ messages }) => {
      requests++
      const body = JSON.parse(messages[1].content)
      assert.deepEqual(body.participants.map(p => p.userId), ["1"])
      assert.doesNotMatch(body.transcript, /旁人的私事/)
      return { data: { userMemoryUpdates: [] } }
    } },
  }
  assert.equal((await evaluateSessionMemory(input)).reason, "no_replied_batches")
  assert.equal(requests, 0)
  s.sessionBatches.push({ messages: [{ userId: "1", text: "记住我喜欢简短回答" }], reply: "好" })
  await evaluateSessionMemory(input)
  assert.equal(requests, 1)
  assert.equal(s.sessionBatches.length, 2)
})

test("开关热切换按请求快照解析，后续请求使用新协议", async () => {
  const f = fixture({ responses: [{ reply: "旧格式", emotion: "neutral" }] })
  let resolve, began
  const started = new Promise(r => { began = r })
  const originalComplete = f.runtime.client.complete
  f.runtime.client.complete = async () => { began(); return new Promise(r => { resolve = r }) }
  try {
    await f.runtime.handleEvent(f.event())
    const flushing = f.runtime.buffer.flush("group:88")
    await started
    f.cfg.conversation.selectiveGroupReply = false
    resolve({ data: skip })
    await flushing
    assert.equal(f.logs[0].event, "reply_skipped")
    f.runtime.client.complete = originalComplete
    await f.runtime.handleEvent(f.event())
    await f.runtime.buffer.flush("group:88")
    assert.doesNotMatch(f.requests[0].messages[0].content, /"shouldReply"/)
    assert.deepEqual(f.sent, ["旧格式"])
    f.cfg.conversation.selectiveGroupReply = true
    f.runtime.client.complete = async ({ messages }) => {
      assert.match(messages[0].content, /"shouldReply"/)
      return { data: skip }
    }
    await f.runtime.handleEvent(f.event())
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.logs.at(-1).event, "reply_skipped")
  } finally { await f.runtime.dispose() }
})

test("在途沉默决定不会越过热重载白名单检查", async () => {
  const f = fixture()
  let resolve, began
  const started = new Promise(r => { began = r })
  f.runtime.client.complete = async () => { began(); return new Promise(r => { resolve = r }) }
  try {
    await f.runtime.handleEvent(f.event())
    const flushing = f.runtime.buffer.flush("group:88")
    await started
    f.cfg.groupWhitelist.groups = []
    resolve({ data: skip })
    await flushing
    assert.deepEqual(f.sent, [])
    assert.deepEqual(f.stickers, [])
    assert.equal(f.logs.some(item => item.event === "reply_skipped"), false)
    assert.equal(f.runtime.buffer.get("group:88").sessionBatches[0].failed, true)
  } finally { await f.runtime.dispose() }
})

test("到期中的在途请求仍串行收尾，普通消息不再进入，重新呼唤可以重开窗口", async () => {
  const f = fixture()
  const clock = fakeClock()
  f.runtime.buffer.dispose()
  const ended = []
  f.runtime.buffer = new ConversationBuffer({ ...clock,
    onReplyBatch: input => f.runtime.replyBatch(input), onSessionEnd: async s => ended.push(s) })
  let resolve, began, calls = 0
  const started = new Promise(r => { began = r })
  f.runtime.client.complete = async () => {
    calls++
    if (calls === 1) { began(); return new Promise(r => { resolve = r }) }
    return { data: skip }
  }
  try {
    await f.runtime.handleEvent(f.event())
    const flushing = f.runtime.buffer.flush("group:88")
    await started
    await clock.advance(89000)
    assert.equal(await f.runtime.handleEvent(f.event("接着聊")), true)
    await clock.advance(90001)
    assert.equal(await f.runtime.handleEvent(f.event("旁人闲聊")), false)
    assert.equal(calls, 1)
    assert.equal(await f.runtime.handleEvent(f.event("派蒙")), true)
    assert.equal(f.runtime.buffer.get("group:88").expiresAt, 180001)
    resolve({ data: skip })
    await flushing
    await f.runtime.buffer.flush("group:88")
    assert.equal(calls, 2)
    assert.equal(f.runtime.buffer.get("group:88").expiresAt, 180001)
    await clock.advance(180001)
    assert.equal(ended.length, 1)
  } finally { await f.runtime.dispose() }
})

test("API异常不伪装成沉默；没有成功发送时不刷新选择性会话窗口", async () => {
  const f = fixture()
  const clock = fakeClock()
  f.runtime.buffer.dispose()
  f.runtime.buffer = new ConversationBuffer({ ...clock, onReplyBatch: input => f.runtime.replyBatch(input) })
  f.runtime.client.complete = async () => { throw new Error("mock transport error") }
  try {
    await f.runtime.handleEvent(f.event("派蒙", { reply: async () => false }))
    await clock.advance(60000)
    await f.runtime.buffer.flush("group:88")
    const session = f.runtime.buffer.get("group:88")
    assert.equal(session.expiresAt, 90000)
    assert.equal(session.lastReplyAt, 0)
    assert.equal(session.sessionBatches[0].failed, true)
    assert.equal(session.sessionBatches[0].reply, "")
    assert.equal(f.logs[0].event, "reply_sent")
    assert.equal(f.logs[0].data.failed, true)
    await clock.advance(90000)
    assert.equal(f.runtime.hasSession("group:88"), false)
  } finally { await f.runtime.dispose() }
})
