import test from "node:test"
import assert from "node:assert/strict"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { ReplyPacer } from "../lib/reply-pacer.js"
import { followUpMetadata, followUpOptions, normalizeFollowUpDecision } from "../lib/unanswered-follow-up.js"
import { buildChatMessages } from "../lib/prompt-builder.js"
import { buildMemoryEvaluationMessages } from "../lib/memory-compressor.js"

const question = "旅行者，你想先去哪个地方？"
const proactive = { shouldReply: true, reason: "unanswered_question", reply: "想不出来的话，就先陪我坐一会儿吧。" }

function fixture(t, { group = true, selective = true, enabled = true } = {}) {
  let now = 1000000, seq = 0, serial = 0
  const timers = new Map(), sent = [], logs = [], calls = [], responses = [], autonomous = []
  const setTimer = (fn, delay) => { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id }
  const clearTimer = id => timers.delete(id)
  const cfg = { enabled: true, deepseek: { apiKey: "test", timeoutMs: 60000, maxRetries: 1 },
    trigger: { privateTrigger: true, groupMentionTrigger: true, nicknames: ["派蒙"],
      ignoreCommandPrefixes: ["#"], ignoreBotSelf: true },
    groupWhitelist: { enabled: true, groups: ["88"] },
    conversation: { selectiveGroupReply: selective, debounceMs: 3000, activeWindowMs: 90000,
      preTrigger: { enabled: false }, unansweredFollowUp: { enabled, waitMs: 30000, cooldownMs: 180000 } },
    memory: { enabled: false }, reply: { minDelayMs: 0, maxDelayMs: 0 }, stickers: { enabled: false } }
  const pacer = new ReplyPacer({ now: () => now, sleep: async ms => { now += ms }, random: () => 0.5 })
  const runtime = new PaimonRuntime({ replyPacer: pacer, followUpTimers: { setTimer, clearTimer },
    config: { load: async () => cfg, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async input => {
      calls.push(input)
      const queue = input.trace.type === "unanswered_follow_up" ? autonomous : responses
      const response = queue.shift()
      if (response instanceof Error) throw response
      return typeof response === "function" ? response(input) : { data: response }
    } }, modelLogger: { write: async (event, data) => { logs.push({ event, data }); return true } },
    stickerSender: async () => false, logger: () => {},
  })
  runtime.buffer.setTimer = setTimer
  runtime.buffer.clearTimer = clearTimer
  t.after(async () => { await runtime.dispose(); pacer.dispose() })
  const key = group ? "group:88" : "private:user:1"
  const event = (text = "派蒙", extra = {}) => ({ isGroup: group, isPrivate: !group, group_id: "88",
    user_id: "1", self_id: "9", atBot: true, msg: text, sender: { nickname: "甲" }, message_id: String(++seq),
    reply: async text => { sent.push({ text, at: now }); return true }, ...extra })
  const answer = (extra = {}) => ({ reply: question, emotion: "neutral",
    ...(group && selective ? { shouldReply: true, reason: "direct_address" } : {}),
    followUp: { eligible: true, question, targetUserIds: ["1"] }, pendingQuestion: null, ...extra })
  const turn = async (data = answer(), e = event()) => {
    responses.push(data)
    await runtime.handleEvent(e)
    await runtime.buffer.flush(key)
  }
  const skip = (status, extra = {}) => ({ shouldReply: false, reason: "talking_to_others", reply: "", emotion: "neutral",
    followUp: { eligible: false }, pendingQuestion: { id: runtime.followUps.describe(key)?.id, status }, ...extra })
  const q = () => runtime.followUps.pending.get(key)
  const fire = async () => {
    const pending = q()
    if (pending) { clearTimer(pending.timer); pending.timer = null; await runtime.followUps.fire(pending) }
  }
  return { cfg, runtime, pacer, timers, sent, logs, calls, responses, autonomous, key, event, answer, turn, skip, q, fire,
    advance: ms => { now += ms }, now: () => now }
}

test("补话默认关闭且旧响应兼容，不增加请求或定时器", async t => {
  const f = fixture(t, { enabled: false })
  await f.turn(f.answer({ followUp: undefined }))
  f.advance(40000)
  await f.fire()
  assert.equal(f.q(), undefined)
  assert.equal(f.calls.length, 1)
  assert.doesNotMatch(f.calls[0].messages[0].content, /【询问后等待】/)
})

test("提问后满30秒才判断，补话单条一次、不递归，进入短期上下文", async t => {
  const f = fixture(t)
  await f.turn()
  const q = f.q()
  assert.ok(q?.id)
  f.advance(29999)
  await f.fire()
  assert.equal(f.calls.length, 1)
  f.advance(1)
  f.autonomous.push(proactive)
  await f.fire()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.sent.map(x => x.text), [question, proactive.reply])
  assert.equal(f.q(), undefined)
  const call = f.calls[1]
  assert.equal(call.config.deepseek.maxRetries, 0)
  assert.equal(call.config.deepseek.timeoutMs, 15000)
  assert.match(call.messages[0].content, /不是用户刚刚发来的消息/)
  assert.equal(f.runtime.buffer.get(f.key).sessionBatches.at(-1).origin, "unanswered_follow_up")
  assert.deepEqual(f.runtime.buffer.get(f.key).sessionBatches.at(-1).messages, [])
  assert.equal(f.logs.find(x => x.event === "reply_sent" && x.data.type === "unanswered_follow_up").data.pacing[0].isBatchFirst, false)
  f.advance(30000)
  await f.fire()
  assert.equal(f.calls.length, 2)
})

test("私聊及未开启群主动沉默也能独立启用补话", async t => {
  for (const group of [false, true]) {
    const f = fixture(t, { group, selective: false })
    await f.turn()
    assert.ok(f.q())
    f.advance(30000)
    f.autonomous.push(proactive)
    await f.fire()
    assert.equal(f.sent.length, 2)
  }
})

test("无关消息不取消也不重置30秒，提示包含待回答问题ID", async t => {
  const f = fixture(t)
  await f.turn()
  const q = f.q(), sentAt = q.sentAt
  f.advance(20000)
  await f.turn(f.skip("unrelated"), f.event("旁人的话题", { user_id: "2", atBot: false }))
  assert.equal(f.q(), q)
  assert.equal(f.q().sentAt, sentAt)
  assert.match(f.calls[1].messages[0].content, new RegExp(q.id))
  f.advance(10000)
  f.autonomous.push(proactive)
  await f.fire()
  assert.equal(f.calls.length, 3)
  assert.match(f.calls[2].messages[1].content, /旁人的话题/)
  const context = JSON.parse(f.calls[2].messages[1].content)
  assert.match(context.afterQuestion, /旁人的话题/)
  assert.ok(!context.afterQuestion.includes(question))
})

test("回答、拒绝、换话题、不确定及缺失/错误问题ID都保守结束等待", async t => {
  for (const status of ["answered", "declined", "topic_changed", "uncertain", "invalid", undefined]) {
    const f = fixture(t)
    await f.turn()
    await f.turn(f.skip(status))
    assert.equal(f.q(), undefined)
  }
  const f = fixture(t)
  await f.turn()
  await f.turn(f.skip("unrelated", { pendingQuestion: { id: "stale", status: "unrelated" } }))
  assert.equal(f.q(), undefined)
})

test("要求安静即使模型错误标为无关也取消；正常新发言撤销旧问题", async t => {
  const f = fixture(t)
  await f.turn()
  await f.turn(f.skip("unrelated", { reason: "asked_to_stop" }))
  assert.equal(f.q(), undefined)
  await f.turn()
  await f.turn(f.answer({ reply: "那我们聊别的吧。", followUp: { eligible: false } }))
  assert.equal(f.q(), undefined)
})

test("元数据无效不影响正常回复，不建立虚构问题或任意目标用户", async t => {
  for (const meta of [undefined, { eligible: "true", question, targetUserIds: ["1"] },
    { eligible: true, question: "没有说过的问题？", targetUserIds: ["1"] },
    { eligible: true, question, targetUserIds: ["999"] }, { eligible: true, question, targetUserIds: "1" }]) {
    const f = fixture(t)
    await f.turn(f.answer({ followUp: meta }))
    assert.equal(f.sent.length, 1)
    assert.equal(f.q(), undefined)
  }
})

test("从最后一段文字成功发完计时；部分发送失败不建立补话", async t => {
  for (const fail of [false, true]) {
    const f = fixture(t)
    const e = f.event("派蒙", { reply: async text => {
      if (fail && f.sent.length === 1) return false
      f.advance(5000); f.sent.push({ text, at: f.now() }); return true
    } })
    await f.turn(f.answer({ reply: "先聊一会儿再出发。\n" + question }), e)
    if (fail) assert.equal(f.q(), undefined)
    else {
      assert.equal(f.q().sentAt, f.sent.at(-1).at)
      assert.equal(f.timers.get(f.q().timer).at, f.sent.at(-1).at + 30000)
    }
  }
})

test("用户在原回复发送期间接话，下一批会判断新建立的问题", async t => {
  const f = fixture(t)
  let once = false
  const e = f.event("派蒙", { reply: async text => {
    f.sent.push({ text, at: f.now() })
    if (!once) { once = true; await f.runtime.handleEvent(f.event("我想去城里", { atBot: false })) }
    return true
  } })
  await f.turn(undefined, e)
  assert.ok(f.q())
  assert.equal(f.runtime.buffer.get(f.key).pendingMessages.length, 1)
  f.responses.push(f.skip("answered"))
  await f.runtime.buffer.flush(f.key)
  assert.equal(f.q(), undefined)
})

test("到点优先处理排队消息，无关判断完成才补话；忙碌宽限最多30秒", async t => {
  const f = fixture(t)
  await f.turn()
  f.advance(30000)
  await f.runtime.handleEvent(f.event("随便聊聊", { atBot: false }))
  await f.fire()
  assert.equal(f.calls.length, 1)
  f.responses.push(f.skip("unrelated"))
  await f.runtime.buffer.flush(f.key)
  f.autonomous.push(proactive)
  await f.fire()
  assert.equal(f.sent.length, 2)
  const busy = fixture(t)
  await busy.turn()
  busy.advance(60001)
  await busy.fire()
  assert.equal(busy.q(), undefined)
  assert.equal(busy.calls.length, 1)
})

test("补话API期间新消息使结果作废，正常批次串行等待，不并发调用", async t => {
  const f = fixture(t)
  await f.turn()
  f.advance(30000)
  let resolve, entered
  const ready = new Promise(r => { entered = r })
  f.autonomous.push(() => new Promise(r => { resolve = r; entered() }))
  const flight = f.fire()
  await ready
  await f.runtime.handleEvent(f.event("我选城里", { atBot: false }))
  await f.runtime.buffer.flush(f.key)
  assert.equal(f.calls.length, 2)
  resolve({ data: proactive })
  await flight
  assert.equal(f.sent.length, 1)
  assert.equal(f.q(), undefined)
  f.responses.push(f.answer({ reply: "那就出发吧。", followUp: { eligible: false } }))
  await f.runtime.buffer.flush(f.key)
  assert.equal(f.calls.length, 3)
})

test("补话节奏等待期间新消息到达，也阻止迟到补话", async t => {
  const f = fixture(t)
  await f.turn()
  f.cfg.conversation.unansweredFollowUp.waitMs = 5000
  f.cfg.reply = { minDelayMs: 24000, maxDelayMs: 24000 }
  f.advance(5000)
  f.pacer.sleep = async ms => { f.advance(ms); await f.runtime.handleEvent(f.event("我来啦")) }
  f.autonomous.push(proactive)
  await f.fire()
  assert.equal(f.sent.length, 1)
  assert.equal(f.q(), undefined)
})

test("关闭开关/插件、移出白名单、移除key、结束会话及dispose都取消", async t => {
  const changes = [f => { f.cfg.conversation.unansweredFollowUp.enabled = false },
    f => { f.cfg.enabled = false }, f => { f.cfg.groupWhitelist.groups = [] },
    f => { f.cfg.deepseek.apiKey = "" }]
  for (const change of changes) {
    const f = fixture(t)
    await f.turn(); change(f)
    f.runtime.followUps.revalidate(f.cfg)
    assert.equal(f.q(), undefined)
  }
  for (const method of ["end", "dispose"]) {
    const f = fixture(t)
    await f.turn()
    if (method === "end") await f.runtime.buffer.finish(f.key)
    else await f.runtime.dispose()
    assert.equal(f.q(), undefined)
  }
})

test("等待时间热修改以原成功发送时间为基准，不凭新消息重启倒计时", async t => {
  const f = fixture(t)
  await f.turn()
  const sentAt = f.q().sentAt
  f.advance(10000)
  f.cfg.conversation.unansweredFollowUp.waitMs = 45000
  f.runtime.followUps.revalidate(f.cfg)
  assert.equal(f.timers.get(f.q().timer).at, sentAt + 45000)
  f.cfg.conversation.unansweredFollowUp.waitMs = 5000
  f.runtime.followUps.revalidate(f.cfg)
  assert.equal(f.timers.get(f.q().timer).at, f.now())
})

test("会话已到期不为补话复活；旧定时器不影响新问题", async t => {
  const f = fixture(t)
  await f.turn()
  const old = f.q()
  await f.turn()
  assert.notEqual(f.q().id, old.id)
  await f.runtime.followUps.fire(old)
  assert.ok(f.q())
  f.advance(90001)
  await f.fire()
  assert.equal(f.q(), undefined)
  assert.equal(f.calls.length, 2)
})

test("模型选择不补话、无效输出、请求失败或发送失败均安静结束且不重试", async t => {
  for (const response of [{ shouldReply: false, reason: "not_appropriate", reply: "" },
    { shouldReply: false, reason: "already_answered", reply: "" }, {},
    { ...proactive, reply: "长".repeat(81) }, { ...proactive, reply: "一句\n两句" }, new Error("test")]) {
    const f = fixture(t)
    await f.turn(); f.advance(30000); f.autonomous.push(response)
    await f.fire()
    assert.equal(f.q(), undefined)
    assert.equal(f.sent.length, 1)
    assert.equal(f.calls.length, 2)
  }
  const f = fixture(t)
  let attempts = 0
  await f.turn(undefined, f.event("派蒙", { reply: async () => ++attempts === 1 }))
  f.cfg.reply.sendRetries = 3
  f.advance(30000); f.autonomous.push(proactive)
  await f.fire()
  assert.equal(attempts, 2)
  assert.equal(f.q(), undefined)
})

test("同一聊天补话后3分钟冷却跨session保持，其他群/私聊不受影响", async t => {
  const f = fixture(t)
  await f.turn(); f.advance(30000); f.autonomous.push(proactive); await f.fire()
  await f.runtime.buffer.finish(f.key)
  await f.turn()
  assert.equal(f.q(), undefined)
  f.advance(180000)
  await f.turn()
  assert.ok(f.q())
  assert.equal(f.runtime.followUps.cooldowns.has("group:99"), false)
})

test("主动补话不进入长期记忆材料，生命周期日志不含问题正文", async t => {
  const f = fixture(t)
  await f.turn(); f.advance(30000); f.autonomous.push(proactive); await f.fire()
  const session = f.runtime.buffer.get(f.key)
  const memory = buildMemoryEvaluationMessages({ session, memories: {}, config: f.cfg })
  assert.doesNotMatch(memory[1].content, /想不出来的话/)
  assert.match(memory[1].content, /你想先去哪个地方/)
  const lifecycle = f.logs.filter(x => x.event.startsWith("follow_up_"))
  assert.ok(lifecycle.some(x => x.event === "follow_up_armed"))
  assert.ok(lifecycle.some(x => x.event === "follow_up_sent"))
  assert.ok(lifecycle.every(x => !JSON.stringify(x).includes(question)))
})

test("补话参数有上下限，元数据和主动响应严格校验", () => {
  assert.deepEqual(followUpOptions({}), { enabled: false, waitMs: 30000, cooldownMs: 180000 })
  assert.deepEqual(followUpOptions({ conversation: { unansweredFollowUp: {
    enabled: true, waitMs: 1, cooldownMs: Infinity } } }), { enabled: true, waitMs: 5000, cooldownMs: 180000 })
  assert.throws(() => normalizeFollowUpDecision({ shouldReply: "false", reply: "" }))
  assert.throws(() => normalizeFollowUpDecision({ ...proactive, reply: "[CQ:at,qq=all]" }))
  const metadata = followUpMetadata({ followUp: { eligible: true, question, targetUserIds: [] } },
    { session: { participants: { "1": {} } }, reply: question })
  assert.deepEqual(metadata.candidate.targetUserIds, [])
  const prompt = buildChatMessages({ session: { scene: "private", participants: {} }, replyBatchMessages: [],
    config: { conversation: { unansweredFollowUp: { enabled: true } } } })
  assert.match(prompt[0].content, /与 shouldReply 独立/)
})

test("补话API在途时关开关、取消白名单或dispose，不发送也不复活", async t => {
  for (const action of ["disable", "whitelist", "dispose"]) {
    const f = fixture(t)
    await f.turn(); f.advance(30000)
    let resolve, entered
    const ready = new Promise(r => { entered = r })
    f.autonomous.push(() => new Promise(r => { resolve = r; entered() }))
    const flight = f.fire()
    await ready
    if (action === "dispose") await f.runtime.dispose()
    else if (action === "whitelist") f.cfg.groupWhitelist.groups = []
    else f.cfg.conversation.unansweredFollowUp.enabled = false
    resolve({ data: proactive }); await flight
    assert.equal(f.sent.length, 1)
    assert.equal(f.q(), undefined)
  }
})

test("真正定时器回调只触发一次；补话完冷却计时器和dispose清理引用", async t => {
  const f = fixture(t)
  await f.turn()
  const q = f.q(), timer = f.timers.get(q.timer)
  f.advance(30000)
  f.autonomous.push(proactive)
  timer.fn()
  for (let i = 0; i < 100 && f.q(); i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.sent.length, 2)
  timer.fn()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 2)
  const cooldown = f.runtime.followUps.cooldowns.get(f.key)
  assert.ok(cooldown)
  f.advance(180000)
  f.timers.get(cooldown.timer).fn()
  assert.equal(f.runtime.followUps.cooldowns.size, 0)
  await f.runtime.dispose()
  assert.equal(f.runtime.followUps.pending.size, 0)
})

test("另一会话能在当前补话API等待时正常回复", async t => {
  const f = fixture(t)
  await f.turn(); f.advance(30000)
  let resolve, entered
  const ready = new Promise(r => { entered = r })
  f.autonomous.push(() => new Promise(r => { resolve = r; entered() }))
  const flight = f.fire(); await ready
  f.cfg.groupWhitelist.groups.push("99")
  f.responses.push(f.answer({ followUp: { eligible: false } }))
  await f.runtime.handleEvent(f.event("派蒙", { group_id: "99" }))
  await f.runtime.buffer.flush("group:99")
  assert.equal(f.sent.length, 2)
  resolve({ data: proactive }); await flight
  assert.equal(f.sent.length, 3)
})
