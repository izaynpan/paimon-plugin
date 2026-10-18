import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { RecentContextStore, recentOptions, messageNamespace } from "../lib/recent-context.js"
import { readQuotedMessage } from "../lib/quoted-message.js"
import { WebSearchService, webSearchOptions } from "../lib/web-search.js"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { CacheFile } from "../lib/cache-file.js"
import { buildMemoryEvaluationMessages } from "../lib/memory-compressor.js"

const day = 86400000, epoch = Date.parse("2026-10-18T00:00:00Z")
const config = () => ({ enabled: true, deepseek: { apiKey: "test-key" },
  trigger: { nicknames: ["派蒙"], groupMentionTrigger: true, privateTrigger: true },
  conversation: { debounceMs: 100000, activeWindowMs: 90000, preTrigger: { enabled: false },
    recentContext: { enabled: true, persist: false, retentionMs: day } },
  memory: { enabled: false }, webSearch: { enabled: false },
  reply: { split: false, minDelayMs: 0, maxDelayMs: 0 }, stickers: { enabled: false } })
const session = (id = "old", key = "group:88") => ({ id, sessionKey: key,
  scene: key.startsWith("group:") ? "group" : "private", groupId: key.startsWith("group:") ? key.slice(6) : "",
  participants: {}, sessionBatches: [] })
const message = (text = "我有丝柯克和爱可菲", timestamp = epoch, extra = {}) => ({ text,
  userId: "1", displayName: "用户甲", timestamp, messageId: "m1", namespace: '["OneBotv11","9"]', ...extra })
const record = (timestamp = epoch, extra = {}) => ({ session: session(),
  messages: [message(undefined, timestamp)], replies: [message("可以讨论配队", timestamp, { userId: "9", messageId: "r1" })],
  createdAt: timestamp, ...extra })
const select = (store, cfg, extra = {}) => store.select(cfg, { session: session("new"),
  messages: [message("那莫娜呢", epoch, { messageId: "current" })], ...extra })
async function tempFile(t, name = "cache.json") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-recent-"))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    await fs.rm(dir, { recursive: true, force: true })
  })
  return path.join(dir, name)
}
const nonexistent = file => assert.rejects(fs.stat(file), { code: "ENOENT" })

test("近期衔接默认关闭，默认一天且所有容量受硬上限约束", () => {
  assert.equal(recentOptions({}).enabled, false)
  assert.equal(recentOptions({}).retentionMs, day)
  const cfg = config()
  Object.assign(cfg.conversation.recentContext, { retentionMs: Infinity, maxBatches: 999, maxStoredChars: 99999, maxPromptChars: 99999 })
  assert.equal(recentOptions(cfg).retentionMs, day)
  assert.equal(recentOptions(cfg).maxBatches, 20)
  assert.equal(recentOptions(cfg).maxStoredChars, 16000)
  assert.equal(recentOptions(cfg).maxPromptChars, 6000)
  cfg.conversation.recentContext.retentionMs = 1
  assert.equal(recentOptions(cfg).retentionMs, 300000)
})

test("跨重启恢复原始时间和作者，读取不续期，到期清除磁盘", async t => {
  const file = await tempFile(t), cfg = config(); cfg.conversation.recentContext.persist = true
  let now = epoch
  let store = new RecentContextStore({ file, now: () => now })
  await store.record(cfg, record())
  now += day - 1000
  store = new RecentContextStore({ file, now: () => now })
  let result = await select(store, cfg)
  assert.equal(result.batches[0].createdAt, epoch)
  assert.equal(result.batches[0].messages[0].userId, "1")
  assert.equal(result.batches[0].messages[0].text, "我有丝柯克和爱可菲")
  now += 1000
  assert.deepEqual((await select(store, cfg)).batches, [])
  await nonexistent(file)
})

test("缩短TTL立即淘汰，延长不能恢复；新问答不续旧记录", async () => {
  let now = epoch
  const cfg = config(), store = new RecentContextStore({ file: null, now: () => now })
  await store.record(cfg, record())
  now += 600001
  await store.record(cfg, record(now, { id: "new-record", session: session("later") }))
  cfg.conversation.recentContext.retentionMs = 300000
  assert.equal((await select(store, cfg)).batches.length, 1)
  cfg.conversation.recentContext.retentionMs = day
  assert.equal((await select(store, cfg)).batches[0].createdAt, now)
})

test("群/私聊范围隔离，白名单撤销及关闭功能清除磁盘且重开不复活", async t => {
  for (const mode of ["whitelist", "feature", "plugin", "persist"]) {
    const file = await tempFile(t, mode + ".json"), cfg = config(); cfg.conversation.recentContext.persist = true
    const store = new RecentContextStore({ file, now: () => epoch })
    await store.record(cfg, record())
    assert.equal((await select(store, cfg, { session: session("n", "group:99") })).batches.length, 0)
    assert.equal((await select(store, cfg, { session: session("n", "private:user:1") })).batches.length, 0)
    if (mode === "whitelist") cfg.groupWhitelist = { enabled: true, groups: [] }
    if (mode === "feature") cfg.conversation.recentContext.enabled = false
    if (mode === "plugin") cfg.enabled = false
    if (mode === "persist") cfg.conversation.recentContext.persist = false
    await store.configure(cfg)
    await nonexistent(file)
    const reset = config(); reset.conversation.recentContext.persist = true
    const recovered = new RecentContextStore({ file, now: () => epoch })
    assert.equal((await select(recovered, reset)).batches.length, 0)
  }
})

test("恢复时按当前白名单过滤；损坏、未来时间及超限文件降级为空", async t => {
  const file = await tempFile(t), cfg = config(); cfg.conversation.recentContext.persist = true
  await fs.writeFile(file, "broken-json")
  const logs = []
  let store = new RecentContextStore({ file, now: () => epoch, logger: (...args) => logs.push(args) })
  assert.equal((await select(store, cfg)).batches.length, 0)
  assert.equal(logs.length, 1)
  await store.record(cfg, record())
  cfg.groupWhitelist = { enabled: true, groups: [] }
  store = new RecentContextStore({ file, now: () => epoch })
  await store.configure(cfg); await nonexistent(file)
  delete cfg.groupWhitelist
  await store.record(cfg, record(epoch + day))
  assert.equal((await select(store, cfg)).batches.length, 0)
})

test("原子替换失败保留上一份快照，串行保存以最新写入为准", async t => {
  const file = await tempFile(t), writer = new CacheFile(file)
  await writer.save(["original"], true)
  await fs.mkdir(file + ".tmp")
  await writer.save(["failed"], true)
  assert.deepEqual(await writer.read(), ["original"])
  await fs.rmdir(file + ".tmp")
  await Promise.all([writer.save(["second"], true), writer.save(["third"], true)])
  assert.deepEqual(await writer.read(), ["third"])
})

test("容量提前淘汰，注入上限和引用关联优先，不混淆用户条件", async () => {
  const cfg = config(), store = new RecentContextStore({ file: null, now: () => epoch })
  for (let i = 0; i < 25; i++) await store.record(cfg, record(epoch, { id: "b" + i,
    messages: [message("第" + i + "题：" + "培养条件".repeat(120), epoch, { messageId: "m" + i })],
    replies: [message("建议".repeat(50), epoch, { messageId: "r" + i })] }))
  assert.ok(store.chats.get("group:88").length <= 20)
  assert.ok(JSON.stringify(store.chats.get("group:88")).length <= 16000)
  const quote = await store.quote(cfg, "group:88", message().namespace, "r20")
  const selected = await select(store, cfg, { quote, messages: [message("我想问这个", epoch, { userId: "2" })] })
  assert.ok(selected.batches.length <= 6)
  assert.ok(JSON.stringify(selected.batches).length <= 6000)
  assert.match(JSON.stringify(selected.batches), /第20题/)
  assert.equal(selected.batches.flatMap(b => b.messages).every(m => m.userId === "1"), true)
  for (let i = 0; i < 202; i++) await store.record(cfg, record(epoch, { session: session("s", "group:" + i) }))
  assert.equal(store.chats.size, 200)
})

test("本地引用按范围和连接命名空间定位，原文去重，活跃会话不再次注入旧批次", async () => {
  const cfg = config(), store = new RecentContextStore({ file: null, now: () => epoch })
  await store.record(cfg, record())
  const quote = await store.quote(cfg, "group:88", message().namespace, "r1")
  assert.equal(quote.source, "local")
  assert.equal(await store.quote(cfg, "group:99", message().namespace, "r1"), null)
  assert.equal(await store.quote(cfg, "group:88", '["OneBotv11","10"]', "r1"), null)
  const chosen = await select(store, cfg, { quote, messages: [message("续问", epoch, { messageId: "new" })] })
  assert.equal(chosen.batches[0].replies.length, 0)
  assert.equal((await select(store, cfg, { session: session() })).batches.length, 0)
})

function connection(handler) {
  const ws = new EventEmitter(), adapter = { name: "OneBotv11", echo: new Map() }, requests = []
  ws.readyState = 1
  ws.send = (raw, cb) => {
    const req = JSON.parse(raw); requests.push(req)
    handler?.(req, data => adapter.echo.get(req.echo)?.resolve({ retcode: 0, data }), cb)
  }
  return { bot: { ws, adapter, version: { app_name: "NapCat.Onebot" },
    sendApi: () => { throw new Error("不允许调用框架sendApi") } }, requests }
}
const protocolRow = (extra = {}) => ({ message_id: "quoted", group_id: "88", user_id: "1", message_type: "group",
  sender: { user_id: "1", card: "用户甲" }, time: epoch / 1000,
  message: [{ type: "text", data: { text: "我有丝柯克" } }, { type: "reply", data: { id: "never-read" } }], ...extra })
const quoteEvent = conn => ({ isGroup: true, group_id: "88", user_id: "2", self_id: "9", bot: conn.bot, reply_id: "quoted" })

test("安全单条引用保留原作者，只取文字不递归，可读取一天以前主动引用的消息", async () => {
  const c = connection((req, respond) => respond(protocolRow())), cfg = config()
  const result = await readQuotedMessage({ e: quoteEvent(c), config: cfg,
    store: new RecentContextStore({ file: null }), now: () => epoch + day * 3 })
  assert.equal(result.reason, "protocol")
  assert.equal(result.quote.userId, "1")
  assert.equal(result.quote.text, "我有丝柯克")
  assert.equal(c.requests.length, 1)
  assert.equal(c.requests[0].action, "get_msg")
  assert.equal(c.bot.adapter.echo.size, 0)
})

test("错误群、ID、未来时间、非文本及不明私聊范围不注入", async () => {
  for (const extra of [{ group_id: "99" }, { message_id: "other" }, { time: (epoch + day) / 1000 },
    { message: "CQ string" }, { message_type: "private" }, { message: [] }]) {
    const c = connection((req, respond) => respond(protocolRow(extra)))
    assert.equal((await readQuotedMessage({ e: quoteEvent(c), config: config(),
      store: new RecentContextStore({ file: null }), now: () => epoch })).quote, null)
  }
  const c = connection((req, respond) => respond(protocolRow({ group_id: undefined, message_type: "private",
    user_id: "9", sender: { user_id: "9" } })))
  assert.equal((await readQuotedMessage({ e: { ...quoteEvent(c), isGroup: false, isPrivate: true },
    config: config(), store: new RecentContextStore({ file: null }), now: () => epoch })).quote, null)
})

test("引用超时/取消/不支持正常降级，迟到响应不注入且不关闭共享连接", async () => {
  for (const mode of ["timeout", "abort", "unsupported"]) {
    const c = connection(), controller = new AbortController(), e = quoteEvent(c)
    if (mode === "unsupported") c.bot.adapter.name = "Other"
    const pending = readQuotedMessage({ e, config: config(), store: new RecentContextStore({ file: null }),
      timeoutMs: 5, signal: controller.signal })
    if (mode === "abort") controller.abort()
    const result = await pending
    assert.equal(result.quote, null)
    assert.equal(result.reason, mode === "abort" ? "aborted" : mode)
    assert.equal(c.bot.adapter.echo.size, 0)
    assert.equal(c.bot.ws.readyState, 1)
    assert.equal(c.bot.ws.listenerCount("close"), 0)
  }
})

function runtimeFixture({ cfg = config(), store = new RecentContextStore({ file: null }), conn = connection(),
  complete, reply } = {}) {
  const calls = [], sent = [], logs = []
  let id = 0, sentId = 0
  const runtime = new PaimonRuntime({ config: { load: async () => cfg, getPersona: () => "派蒙", getStickers: () => ({}) },
    recentContextStore: store, webSearchService: new WebSearchService({ budgetFile: null, cacheFile: null }),
    memoryStore: { readMany: async () => { throw Error("不应读取关闭的记忆") } },
    client: { complete: async request => { calls.push(request); return complete ? complete(request) :
      { data: { reply: "试试这个组合", emotion: "neutral", replyKind: "guide" } } } },
    modelLogger: { write: async (event, data) => logs.push({ event, data }) }, stickerSender: async () => {}, logger: () => {} })
  const event = (text = "派蒙，配队怎么选", extra = {}) => ({ isGroup: true, group_id: "88", user_id: "1", self_id: "9",
    message_id: "u" + ++id, time: Date.now() / 1000, bot: conn.bot, sender: { card: "用户甲" },
    message: [{ type: "text", text }], reply: async value => { sent.push(value); return reply ? reply(value) : { message_id: "reply" + ++sentId } }, ...extra })
  return { runtime, cfg, store, conn, calls, sent, logs, event }
}

test("关闭长期记忆仍跨session衔接，旧片段不进入当前session或记忆提取", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event("派蒙，我有丝柯克和爱可菲")); await f.runtime.buffer.flush("group:88")
  await f.runtime.buffer.finish("group:88")
  assert.equal(await f.runtime.handleEvent(f.event("那莫娜呢")), false)
  await f.runtime.handleEvent(f.event("派蒙，那莫娜呢")); await f.runtime.buffer.flush("group:88")
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].messages.at(-1).content, /我有丝柯克和爱可菲/)
  const current = f.runtime.buffer.get("group:88")
  assert.doesNotMatch(JSON.stringify(current), /我有丝柯克和爱可菲/)
  assert.doesNotMatch(buildMemoryEvaluationMessages({ session: current, memories: {}, config: f.cfg })[1].content, /我有丝柯克和爱可菲/)
  assert.equal(f.runtime.followUps.describe("group:88"), null)
  assert.equal(f.logs.filter(l => l.event === "recent_context").at(-1).data.batches, 1)
  assert.doesNotMatch(JSON.stringify(f.logs.filter(l => l.event === "recent_context")), /丝柯克/)
})

test("群友引用派蒙成功发送的消息优先本地读取，不混淆角色持有者", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event("派蒙，我有丝柯克和爱可菲")); await f.runtime.buffer.flush("group:88")
  await f.runtime.buffer.finish("group:88")
  await f.runtime.handleEvent(f.event("派蒙，这个怎么配", { user_id: "2", reply_id: "reply1", sender: { card: "用户乙" } }))
  await f.runtime.buffer.flush("group:88")
  const data = JSON.parse(f.calls[1].messages.at(-1).content.split("\n").slice(1).join("\n")).recentContext
  assert.equal(data.quotedMessage.source, "local")
  assert.equal(data.batches[0].messages[0].userId, "1")
  assert.equal(f.conn.requests.length, 0)
  assert.match(f.calls[1].messages[0].content, /群友甲.*不属于乙/)
})

test("只归档已成功发送片段；沉默、全失败和自动补话不生成近期批次", async t => {
  let count = 0
  const cfg = config(); cfg.reply.split = true
  const f = runtimeFixture({ cfg, complete: async () => ({ data: { reply: "成功部分\n失败部分", emotion: "neutral" } }),
    reply: () => ++count === 1 ? { message_id: "success" } : false })
  t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event()); await f.runtime.buffer.flush("group:88")
  const archived = f.store.chats.get("group:88")
  assert.equal(archived[0].replies[0].text, "成功部分")
  assert.doesNotMatch(JSON.stringify(archived), /失败部分/)
  await f.runtime.buffer.runIdle("group:88", f.runtime.buffer.get("group:88").id,
    async () => ({ sentSegments: ["自动补话"] }))
  assert.doesNotMatch(JSON.stringify(f.store.chats.get("group:88")), /自动补话/)
  const silentCfg = config(); silentCfg.conversation.selectiveGroupReply = true
  const silent = runtimeFixture({ cfg: silentCfg, complete: async () => ({ data:
    { shouldReply: false, reply: "", emotion: "neutral", reason: "talking_to_others" } }) })
  t.after(() => silent.runtime.dispose())
  await silent.runtime.handleEvent(silent.event()); await silent.runtime.buffer.flush("group:88")
  assert.equal(silent.store.chats.size, 0)
})

test("引用不绕过@开关，关闭引用功能不查询；新主题及歧义由同次模型判断", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  f.cfg.trigger.groupMentionTrigger = false
  assert.equal(await f.runtime.handleEvent(f.event("", { atBot: true, reply_id: "quoted" })), false)
  assert.equal(f.conn.requests.length, 0)
  f.cfg.conversation.recentContext.quotedMessage = { enabled: false }
  await f.runtime.handleEvent(f.event("派蒙", { reply_id: "quoted" })); await f.runtime.buffer.flush("group:88")
  assert.equal(f.conn.requests.length, 0)
  assert.match(f.calls[0].messages[0].content, /明确换题则忽略旧主题/)
  assert.match(f.calls[0].messages[0].content, /多个话题都可能匹配/)
  assert.equal(f.calls.length, 1)
})

test("引用优先且与触发前历史共用预算，未重新触发不会读引用", async t => {
  const conn = connection((req, respond) => {
    if (req.action === "get_msg") respond(protocolRow({ time: Date.now() / 1000 }))
    else respond({ messages: [] })
  })
  const f = runtimeFixture({ conn }); t.after(() => f.runtime.dispose())
  f.cfg.conversation.preTrigger.enabled = true
  await f.runtime.handleEvent(f.event("派蒙", { reply_id: "quoted" }))
  assert.deepEqual(conn.requests.map(r => r.action), ["get_msg", "get_group_msg_history"])
  await f.runtime.buffer.flush("group:88")
  assert.match(f.calls[0].messages.at(-1).content, /我有丝柯克/)
  await f.runtime.buffer.finish("group:88")
  assert.equal(await f.runtime.handleEvent(f.event("这个呢", { reply_id: "quoted" })), false)
  assert.equal(conn.requests.length, 2)
})

test("在途引用关闭功能与dispose都阻止迟到原文注入", async () => {
  for (const mode of ["disable", "dispose"]) {
    const f = runtimeFixture()
    const pending = f.runtime.handleEvent(f.event("派蒙", { reply_id: "quoted" }))
    while (!f.conn.requests.length) await new Promise(resolve => setImmediate(resolve))
    if (mode === "dispose") await f.runtime.dispose()
    else {
      f.cfg.conversation.recentContext.enabled = false
      await f.runtime.refreshRetention(f.cfg)
    }
    await pending
    assert.equal(f.conn.bot.adapter.echo.size, 0)
    if (mode === "disable") {
      await f.runtime.buffer.flush("group:88")
      assert.doesNotMatch(JSON.stringify(f.calls), /我有丝柯克/)
      await f.runtime.dispose()
    } else assert.equal(f.runtime.buffer.sessions.size, 0)
  }
})

test("模型已读旧上下文后关闭功能，阻止迟到回答；重新开启不恢复旧记录", async t => {
  let release, block = false
  const f = runtimeFixture({ complete: async () => {
    if (block) await new Promise(resolve => { release = resolve })
    return { data: { reply: "回复", emotion: "neutral" } }
  } }); t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event()); await f.runtime.buffer.flush("group:88"); await f.runtime.buffer.finish("group:88")
  block = true
  await f.runtime.handleEvent(f.event())
  const pending = f.runtime.buffer.flush("group:88")
  while (!release) await new Promise(resolve => setImmediate(resolve))
  f.cfg.conversation.recentContext.enabled = false
  await f.runtime.refreshRetention(f.cfg)
  release(); await pending
  assert.equal(f.sent.length, 1)
  assert.equal(f.store.chats.size, 0)
  f.cfg.conversation.recentContext.enabled = true
  await f.runtime.refreshRetention(f.cfg)
  assert.equal(f.store.chats.size, 0)
})

test("每日重启只恢复资料，不恢复活跃会话、回复或补话计时器", async t => {
  const file = await tempFile(t), cfg = config(); cfg.conversation.recentContext.persist = true
  let f = runtimeFixture({ cfg, store: new RecentContextStore({ file }) })
  await f.runtime.initialize({ watch: false })
  await f.runtime.handleEvent(f.event("派蒙，我有丝柯克")); await f.runtime.buffer.flush("group:88")
  await f.runtime.dispose()
  f = runtimeFixture({ cfg, store: new RecentContextStore({ file }) }); t.after(() => f.runtime.dispose())
  await f.runtime.initialize({ watch: false })
  assert.equal(f.runtime.buffer.sessions.size, 0)
  assert.equal(f.sent.length, 0)
  assert.equal(f.runtime.followUps.describe("group:88"), null)
  await f.runtime.handleEvent(f.event("派蒙，刚才的配队呢", { message_id: "new" })); await f.runtime.buffer.flush("group:88")
  assert.match(f.calls[0].messages.at(-1).content, /我有丝柯克/)
})

test("群白名单不影响私聊引用和私聊近期衔接；对方不同私聊不能读到资料", async t => {
  const conn = connection((req, respond) => respond(protocolRow({ time: Date.now() / 1000,
    group_id: undefined, message_type: "private" })))
  const cfg = config(); cfg.groupWhitelist = { enabled: true, groups: [] }
  const f = runtimeFixture({ cfg, conn }); t.after(() => f.runtime.dispose())
  const privateEvent = (text, extra = {}) => f.event(text, { isGroup: false, isPrivate: true, group_id: undefined, ...extra })
  await f.runtime.handleEvent(privateEvent("这个角色呢", { reply_id: "quoted" }))
  await f.runtime.buffer.flush("private:user:1")
  assert.match(f.calls[0].messages.at(-1).content, /我有丝柯克/)
  assert.equal(f.store.chats.has("private:user:1"), true)
  await f.runtime.buffer.finish("private:user:1")
  await f.runtime.handleEvent(privateEvent("刚才说的呢", { user_id: "2" }))
  await f.runtime.buffer.flush("private:user:2")
  assert.doesNotMatch(JSON.stringify(f.calls[1].messages), /我有丝柯克|这个角色呢/)
})

test("引用超时不再叠加完整历史等待，只有一份1500毫秒补查预算", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  f.cfg.conversation.preTrigger = { enabled: true, historyTimeoutMs: 5000 }
  const start = performance.now()
  await f.runtime.handleEvent(f.event("派蒙", { reply_id: "quoted" }))
  const elapsed = performance.now() - start
  assert.ok(elapsed < 2600, "引用超时后不得再等待5秒历史查询")
  assert.equal(f.conn.requests.length, 1)
  assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
})

test("活跃会话引用已提供原文时只给定位信息，不重复注入正文", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event()); await f.runtime.buffer.flush("group:88")
  await f.runtime.handleEvent(f.event("这个呢", { reply_id: "reply1" })); await f.runtime.buffer.flush("group:88")
  const data = JSON.parse(f.calls[1].messages.at(-1).content.split("\n").slice(1).join("\n")).recentContext
  assert.equal(data.quotedMessage.source, "active_context")
  assert.equal(data.quotedMessage.text, undefined)
})

test("同群不同Bot连接的相同消息ID不碰撞，同连接重传仍去重", async t => {
  const f = runtimeFixture(); t.after(() => f.runtime.dispose())
  await f.runtime.handleEvent(f.event("派蒙，第一条", { message_id: "same", self_id: "9" }))
  await f.runtime.handleEvent(f.event("派蒙，另一连接", { message_id: "same", self_id: "10" }))
  await f.runtime.handleEvent(f.event("派蒙，第一条重传", { message_id: "same", self_id: "9" }))
  assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 2)
  await f.runtime.buffer.flush("group:88")
  assert.match(f.calls[0].messages[1].content, /第一条/)
  assert.match(f.calls[0].messages[1].content, /另一连接/)
  assert.doesNotMatch(f.calls[0].messages[1].content, /重传/)
})

const stats = () => ({ search: 0, fetch: 0, successful: 0, cacheHits: 0, errors: [] })
const webContext = cfg => ({ config: cfg, options: webSearchOptions(cfg), signal: new AbortController().signal,
  allowed: async () => true, revision: "r1|v1", stats: stats() })
const source = { title: "配队依据", url: "https://example.com/guide", content: "丝柯克配队的公开资料", summary: "", date: "" }

test("搜索缓存和会话证据持久化、共享一天TTL，重启命中不收费不续期，无密钥落盘", async t => {
  const file = await tempFile(t), cfg = config(); cfg.webSearch.enabled = true; cfg.webSearch.cacheTtlMs = 60000
  cfg.conversation.recentContext.persist = true
  let now = epoch, calls = 0
  const create = () => new WebSearchService({ cacheFile: file, budgetFile: null, now: () => now,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ results: [source] })) } })
  let service = create()
  const first = await service.lookup("原神 丝柯克", webContext(cfg))
  assert.equal(webSearchOptions(cfg).cacheTtlMs, day)
  const key = await service.saveEvidence({ revision: "r1|v1", sources: first.map(s => ({ ...s, id: "w1" })) }, cfg)
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /test-key|Authorization|原神 丝柯克/)
  now += 3600000
  service = create()
  const ctx = webContext(cfg), second = await service.lookup("原神 丝柯克", ctx)
  assert.equal(calls, 1); assert.equal(ctx.stats.cacheHits, 1)
  assert.equal(second[0].fetchedAt, first[0].fetchedAt)
  assert.equal(second[0].expiresAt, epoch + day)
  assert.equal((await service.readEvidence([key], cfg)).sources[0].fetchedAt, first[0].fetchedAt)
  now = epoch + day
  assert.equal(await service.readEvidence([key], cfg), undefined)
  await service.lookup("原神 丝柯克", webContext(cfg)); assert.equal(calls, 2)
})

test("搜索空结果仍只缓存一分钟，时长缩短与Key/版本隔离在重启后生效", async t => {
  const file = await tempFile(t), cfg = config(); cfg.webSearch.enabled = true; cfg.conversation.recentContext.persist = true
  let now = epoch, calls = 0, empty = true
  const service = new WebSearchService({ cacheFile: file, budgetFile: null, now: () => now,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ results: empty ? [] : [source] })) } })
  await service.lookup("原神 丝柯克", webContext(cfg)); now += 60000
  empty = false
  const sources = await service.lookup("原神 丝柯克", webContext(cfg)); assert.equal(calls, 2)
  const key = await service.saveEvidence({ revision: "r1|v1", sources }, cfg)
  now += 300001; cfg.conversation.recentContext.retentionMs = 300000
  await service.configure(cfg); assert.equal(await service.readEvidence([key], cfg), undefined)
  cfg.conversation.recentContext.retentionMs = day
  await service.lookup("原神 丝柯克", webContext(cfg)); assert.equal(calls, 3)
  cfg.webSearch.apiKey = "different-key"; now += 500
  await service.lookup("原神 丝柯克", webContext(cfg)); assert.equal(calls, 4)
  now += 500
  await service.lookup("原神 丝柯克", { ...webContext(cfg), revision: "r2|v2" }); assert.equal(calls, 5)
  cfg.conversation.recentContext.enabled = false
  await service.configure(cfg); await nonexistent(file)
  assert.equal(webSearchOptions(cfg).cacheTtlMs, 3600000)
})

test("跨session复用关联证据；网页过期但新近问题仍在时可生成具体查询词", async t => {
  const cfg = config(); cfg.webSearch.enabled = true
  const f = runtimeFixture({ cfg }); t.after(() => f.runtime.dispose())
  let calls = 0, toolCalls = 0, now = Date.now()
  f.runtime.webSearchService = new WebSearchService({ budgetFile: null, cacheFile: null, now: () => now,
    fetchImpl: async () => { toolCalls++; return new Response(JSON.stringify({ results: [source] })) } })
  f.runtime.client.complete = async request => {
    f.calls.push(request); calls++
    const evidence = JSON.parse(request.messages.at(-1).content.split("\n").slice(1).join("\n")).webSources
    if (calls === 1 || calls === 4) {
      assert.equal(evidence.length, 0)
      if (calls === 4) assert.match(JSON.stringify(request.messages), /丝柯克/)
      return { data: { action: "search", scope: "teyvat", reason: "missing", query: "原神 丝柯克 配队",
        missingFacts: ["配队依据"] } }
    }
    assert.ok(evidence.length > 0)
    return { data: { action: "answer", reply: "可以继续讨论丝柯克配队", emotion: "neutral" } }
  }
  await f.runtime.handleEvent(f.event("派蒙，丝柯克配队呢")); await f.runtime.buffer.flush("group:88")
  await f.runtime.buffer.finish("group:88")
  await f.runtime.handleEvent(f.event("派蒙，丝柯克的队友换莫娜呢")); await f.runtime.buffer.flush("group:88")
  assert.equal(toolCalls, 1); assert.equal(calls, 3)
  await f.runtime.buffer.finish("group:88")
  now += day
  // Expire only the public evidence clock: a newer retained question still anchors the topic.
  await f.runtime.handleEvent(f.event("派蒙，刚才那队呢")); await f.runtime.buffer.flush("group:88")
  assert.equal(toolCalls, 2); assert.equal(calls, 5)
})
