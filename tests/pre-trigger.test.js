import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { getPreTriggerHistory, requestHistoryPage, historyOptions } from "../lib/history-provider.js"

const epoch = 1800000000
const config = () => ({
  enabled: true, deepseek: { apiKey: "test" }, memory: { enabled: false },
  trigger: { nicknames: ["派蒙"], groupMentionTrigger: true, groupNicknameTrigger: true,
    privateTrigger: true, ignoreBotSelf: true, ignoreCommandPrefixes: ["#", "＃", "*", "%"] },
  groupWhitelist: { enabled: true, groups: ["88"] },
  conversation: { selectiveGroupReply: true, debounceMs: 100000, activeWindowMs: 90000,
    preTrigger: { enabled: true, historyTimeoutMs: 100 } },
  reply: { split: false }, stickers: { enabled: false },
})
const row = (id, text = "哪里好玩", time = epoch - 5, extra = {}) => ({
  message_id: id, time, group_id: "88", user_id: "1", sender: { card: "小林" },
  message: [{ type: "text", data: { text } }], ...extra,
})
const anchor = () => row("wake", "派蒙", epoch)

function connection(handler) {
  const ws = new EventEmitter()
  ws.readyState = 1
  let terminated = 0
  ws.terminate = () => { terminated++ }
  const adapter = { name: "OneBotv11", echo: new Map() }
  const requests = []
  const respond = (request, messages, extra = {}) => adapter.echo.get(request.echo)?.resolve({
    retcode: 0, data: { messages }, ...extra,
  })
  ws.send = (data, callback) => {
    const request = JSON.parse(data)
    requests.push(request)
    handler?.(request, respond, callback)
  }
  return { bot: { ws, adapter, version: { app_name: "NapCat.Onebot" },
    sendApi: () => { throw new Error("不得调用框架sendApi") } }, ws, requests, respond,
    terminated: () => terminated }
}

function fixture({ handler = (req, respond) => respond(req, [row("before"), anchor()]), selective = true } = {}) {
  const cfg = config(), conn = connection(handler), requests = [], logs = [], sent = []
  cfg.conversation.selectiveGroupReply = selective
  const runtime = new PaimonRuntime({
    config: { load: async () => cfg, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async input => {
      requests.push(input)
      return { data: { reply: "一起去看看吧", emotion: "neutral",
        ...(selective ? { shouldReply: true, reason: "direct_address" } : {}) } }
    } },
    modelLogger: { write: async (event, data) => logs.push({ event, data }) },
    stickerSender: async () => {}, logger: () => {},
  })
  const event = (text = "派蒙", extra = {}) => ({
    isGroup: true, group_id: "88", user_id: "1", self_id: "9", bot: conn.bot,
    message_id: "wake", time: epoch, sender: { card: "小林" }, message: [{ type: "text", text }],
    reply: async value => { sent.push(value); return true }, ...extra,
  })
  return { cfg, conn, runtime, requests, logs, sent, event }
}

test("安全历史传输注册独立echo，成功清理且不影响其他API", async () => {
  const c = connection((req, respond) => respond(req, [anchor()]))
  const other = { resolve: () => {} }
  c.bot.adapter.echo.set("other", other)
  const result = await requestHistoryPage({ bot: c.bot }, { group_id: "88" }, { timeoutMs: 50 })
  assert.equal(result[0].message_id, "wake")
  assert.equal(c.requests[0].action, "get_group_msg_history")
  assert.match(c.requests[0].echo, /^paimon-history-/)
  assert.deepEqual([...c.bot.adapter.echo.keys()], ["other"])
  assert.equal(c.ws.listenerCount("close"), 0)
  assert.equal(c.ws.listenerCount("error"), 0)
  assert.equal(c.terminated(), 0)
})

test("超时、abort、断线、发送错误和接口错误均清理自身资源，不关闭连接", async () => {
  for (const mode of ["timeout", "abort", "close", "error", "throw", "callback", "api", "invalid"]) {
    const controller = new AbortController()
    const c = connection((req, respond, callback) => {
      if (mode === "throw") throw new Error("private error")
      if (mode === "callback") callback(new Error("private error"))
      if (mode === "api") respond(req, [], { retcode: 1200, wording: "private error" })
      if (mode === "invalid") respond(req, null)
    })
    const promise = requestHistoryPage({ bot: c.bot }, {}, { timeoutMs: 5, signal: controller.signal })
    if (mode === "abort") controller.abort()
    if (mode === "close" || mode === "error") c.ws.emit(mode)
    await assert.rejects(promise)
    c.respond(c.requests[0], [row("late")])
    assert.equal(c.bot.adapter.echo.size, 0)
    assert.equal(c.ws.listenerCount("close"), 0)
    assert.equal(c.ws.listenerCount("error"), 0)
    assert.equal(c.terminated(), 0)
  }
})

test("并发历史请求只匹配自己的echo，某个取消不破坏另一个", async () => {
  const c = connection(), controller = new AbortController()
  const first = requestHistoryPage({ bot: c.bot }, {}, { timeoutMs: 50, signal: controller.signal })
  const second = requestHistoryPage({ bot: c.bot }, {}, { timeoutMs: 50 })
  controller.abort()
  await assert.rejects(first, { code: "aborted" })
  assert.equal(c.bot.adapter.echo.size, 1)
  c.respond(c.requests[1], [anchor()])
  assert.equal((await second).length, 1)
  assert.equal(c.bot.adapter.echo.size, 0)
})

test("未触发消息无缓存无查询；呼唤时一次补入协议历史，并使用本次事件回复", async () => {
  for (const selective of [false, true]) {
    const f = fixture({ selective })
    try {
      assert.equal(await f.runtime.handleEvent(f.event("哪里好玩", { message_id: "before" })), false)
      assert.equal(f.runtime.buffer.get("group:88"), null)
      assert.equal(f.runtime.historyInitializations.size, 0)
      assert.equal(f.conn.requests.length, 0)
      assert.equal(f.logs.length, 0)
      await f.runtime.handleEvent(f.event())
      const pending = f.runtime.buffer.get("group:88").pendingMessages
      assert.deepEqual(pending.map(m => m.text), ["哪里好玩", "派蒙"])
      assert.equal(pending[0].preTrigger, true)
      await f.runtime.buffer.flush("group:88")
      assert.equal(f.requests.length, 1)
      assert.match(f.requests[0].messages[0].content, /先说内容后呼唤/)
      assert.deepEqual(f.sent, ["一起去看看吧"])
      const log = f.logs.find(item => item.event === "history_lookup").data
      assert.equal(log.selected, 1)
      assert.doesNotMatch(JSON.stringify(log), /哪里好玩|message|authorization/i)
    } finally { await f.runtime.dispose() }
  }
})

test("只@Bot支持atBot或原始消息段，保留提及开关和自身/白名单限制", async () => {
  for (const extra of [{ atBot: true, message: [] }, { message: [{ type: "at", qq: "9" }] }]) {
    const f = fixture()
    try {
      f.cfg.trigger.groupMentionTrigger = false
      assert.equal(await f.runtime.handleEvent(f.event("", extra)), false)
      f.cfg.trigger.groupMentionTrigger = true
      assert.equal(await f.runtime.handleEvent(f.event("", { ...extra, group_id: "99" })), false)
      assert.equal(await f.runtime.handleEvent(f.event("", { ...extra, user_id: "9" })), false)
      await f.runtime.handleEvent(f.event("", extra))
      const messages = f.runtime.buffer.get("group:88").pendingMessages
      assert.equal(messages.length, 2)
      assert.equal(messages[1].text, "（用户在呼唤你）")
      assert.equal(messages[1].mentionsBot, true)
    } finally { await f.runtime.dispose() }
  }
})

test("以呼唤时间筛同群同用户，排除指令/自身/无文本/缺字段/锚点后的同秒消息", async () => {
  const rows = [row("expired", "过期", epoch - 31), row("boundary", "边界", epoch - 30),
    row("other", "他人", epoch - 20, { user_id: "2" }), row("group", "别群", epoch - 19, { group_id: "99" }),
    row("bot", "自己", epoch - 18, { user_id: "9" }),
    row("cmd", "#命令", epoch - 17), row("cmd2", "＃命令", epoch - 16),
    row("image", "", epoch - 15, { message: [{ type: "image", data: { file: "ignored" } }] }),
    row("no-user", "缺用户", epoch - 14, { user_id: undefined }),
    row("cq", "", epoch - 13, { message: "[CQ:at,qq=9]" }),
    row("before-same-second", "同秒在前", epoch), anchor(), row("after", "同秒在后", epoch)]
  const f = fixture({ handler: (req, respond) => respond(req, rows) })
  try {
    await f.runtime.handleEvent(f.event())
    assert.deepEqual(f.runtime.buffer.get("group:88").pendingMessages.map(m => m.text), ["边界", "同秒在前", "派蒙"])
  } finally { await f.runtime.dispose() }
})

test("有限分页去除跨页重叠并按原时间顺序取最近几条，不比较消息ID大小", async () => {
  const f = fixture({ handler: (req, respond) => {
    const pages = {
      wake: [row("900", "甲", epoch - 3), row("other", "旁人", epoch - 2, { user_id: "2" }), anchor()],
      "900": [row("100", "乙", epoch - 5), row("50", "丙", epoch - 4), row("900", "甲", epoch - 3)],
    }
    respond(req, pages[req.params.message_seq])
  } })
  try {
    f.cfg.conversation.preTrigger.historyPageSize = 3
    await f.runtime.handleEvent(f.event())
    assert.deepEqual(f.runtime.buffer.get("group:88").pendingMessages.map(m => m.text), ["乙", "丙", "甲", "派蒙"])
    assert.equal(f.conn.requests.length, 2)
    assert.equal(f.logs[0].data.scanned, 6)
  } finally { await f.runtime.dispose() }
})

test("游标不推进、空页、缺锚点、乱序、畸形返回均有限停止", async () => {
  for (const rows of [[anchor()], [], [row("missing")], [anchor(), row("older")], null]) {
    const f = fixture({ handler: (req, respond) => respond(req, rows) })
    try {
      f.cfg.conversation.preTrigger.historyPageSize = Array.isArray(rows) ? Math.max(1, rows.length) : 20
      await f.runtime.handleEvent(f.event())
      assert.equal(f.conn.requests.length, 1)
      assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
    } finally { await f.runtime.dispose() }
  }
})

test("多页共用一个超时预算，失败不保留半份历史", async () => {
  const f = fixture()
  let now = 0
  const budgets = []
  const result = await getPreTriggerHistory({ e: f.event(), config: {
    ...f.cfg, conversation: { preTrigger: { historyPageSize: 2, historyTimeoutMs: 100 } } },
    now: () => now,
    requestPage: async (e, params, options) => {
      budgets.push(options.timeoutMs)
      if (budgets.length === 1) { now = 70; return [row("first"), anchor()] }
      now = 101
      return [row("second", "older", epoch - 10), row("first")]
    },
  })
  assert.deepEqual(budgets, [100, 30])
  assert.equal(result.reason, "timeout")
  assert.deepEqual(result.messages, [])
  await f.runtime.dispose()
})

test("历史超时仍正常处理呼唤，晚到响应不补入且不关闭WS", async () => {
  const f = fixture({ handler: () => {} })
  try {
    f.cfg.conversation.preTrigger.historyTimeoutMs = 5
    await f.runtime.handleEvent(f.event())
    assert.equal(f.logs[0].data.reason, "timeout")
    assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
    f.conn.respond(f.conn.requests[0], [row("late"), anchor()])
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.requests.length, 1)
    assert.doesNotMatch(f.requests[0].messages[1].content, /哪里好玩/)
    assert.equal(f.conn.terminated(), 0)
  } finally { await f.runtime.dispose() }
})

test("不支持的适配器、缺锚点、关闭配置、缺key均不查询，正常唤醒或原鉴权路径不变", async () => {
  for (const mode of ["adapter", "version", "ws", "anchor", "time", "disabled", "zero", "key"]) {
    const f = fixture()
    try {
      const e = f.event()
      if (mode === "adapter") e.bot.adapter.name = "Other"
      if (mode === "version") e.bot.version.app_name = "Unknown"
      if (mode === "ws") e.bot.ws.readyState = 3
      if (mode === "anchor") delete e.message_id
      if (mode === "time") delete e.time
      if (mode === "disabled") f.cfg.conversation.preTrigger.enabled = false
      if (mode === "zero") f.cfg.conversation.preTrigger.windowMs = 0
      if (mode === "key") f.cfg.deepseek.apiKey = ""
      await f.runtime.handleEvent(e)
      assert.equal(f.conn.requests.length, 0)
      if (mode !== "key") assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
    } finally { await f.runtime.dispose() }
  }
})

test("历史等待期间同群消息串行合并，重复触发ID只入队一次", async () => {
  const f = fixture({ handler: () => {} })
  try {
    const first = f.runtime.handleEvent(f.event())
    while (!f.conn.requests.length) await Promise.resolve()
    await f.runtime.handleEvent(f.event("补一句", { message_id: "next" }))
    await f.runtime.handleEvent(f.event())
    assert.equal(f.requests.length, 0)
    assert.equal(f.conn.requests.length, 1)
    f.conn.respond(f.conn.requests[0], [row("old"), anchor()])
    await first
    const messages = f.runtime.buffer.get("group:88").pendingMessages
    assert.deepEqual(messages.map(m => m.text), ["哪里好玩", "派蒙", "补一句"])
    await f.runtime.buffer.flush("group:88")
    assert.equal(f.requests.length, 1)
    await f.runtime.handleEvent(f.event("继续", { message_id: "more" }))
    assert.equal(f.conn.requests.length, 1)
  } finally { await f.runtime.dispose() }
})

test("历史期间移出白名单/禁用/去key阻止合并，关闭回看则只放弃历史", async () => {
  for (const mode of ["whitelist", "disabled", "key", "history"]) {
    const f = fixture({ handler: () => {} })
    try {
      const first = f.runtime.handleEvent(f.event())
      while (!f.conn.requests.length) await Promise.resolve()
      if (mode === "whitelist") f.cfg.groupWhitelist.groups = []
      if (mode === "disabled") f.cfg.enabled = false
      if (mode === "key") f.cfg.deepseek.apiKey = ""
      if (mode === "history") f.cfg.conversation.preTrigger.enabled = false
      f.conn.respond(f.conn.requests[0], [row("before"), anchor()])
      await first
      assert.equal(f.logs[0].data.reason, "revoked")
      if (mode === "history") assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
      else assert.equal(f.runtime.buffer.get("group:88"), null)
    } finally { await f.runtime.dispose() }
  }
})

test("dispose取消在途历史并阻止迟到结果创建session", async () => {
  const f = fixture({ handler: () => {} })
  const first = f.runtime.handleEvent(f.event())
  while (!f.conn.requests.length) await Promise.resolve()
  await f.runtime.dispose()
  f.conn.respond(f.conn.requests[0], [row("before"), anchor()])
  await first
  assert.equal(f.runtime.buffer.get("group:88"), null)
  assert.equal(f.runtime.historyInitializations.size, 0)
  assert.equal(f.conn.bot.adapter.echo.size, 0)
})

test("私聊、命令、非白名单和活跃会话不启动历史补查", async () => {
  const f = fixture()
  try {
    for (const e of [f.event("#派蒙"), f.event("派蒙", { group_id: "99" }),
      f.event("派蒙", { user_id: "9" })]) assert.equal(await f.runtime.handleEvent(e), false)
    await f.runtime.handleEvent(f.event("你好", { isGroup: false, isPrivate: true }))
    assert.equal(f.conn.requests.length, 0)
    await f.runtime.handleEvent(f.event())
    await f.runtime.handleEvent(f.event("继续", { message_id: "next" }))
    assert.equal(f.conn.requests.length, 1)
  } finally { await f.runtime.dispose() }
})

test("参数有有限上限，历史排除已接纳ID，文本长度受限且保留@元数据", async () => {
  assert.deepEqual(historyOptions({ conversation: { preTrigger: {
    windowMs: Infinity, maxMessages: 9999, historyPageSize: 9999, historyMaxPages: 9999,
    historyTimeoutMs: -1,
  } } }), { enabled: true, windowMs: 30000, maxMessages: 20, pageSize: 100, maxPages: 5, timeoutMs: 0 })
  const f = fixture()
  const result = await getPreTriggerHistory({ e: f.event(), config: f.cfg, excludedIds: ["seen"],
    requestPage: async () => [row("seen"), row("long", "", epoch - 3, { message: [
      { type: "at", data: { qq: "2" } }, { type: "text", data: { text: "x".repeat(5000) } },
    ] }), anchor()],
  })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].text.length, 4000)
  assert.deepEqual(result.messages[0].mentionedUserIds, ["2"])
  assert.equal(result.messages[0].event, undefined)
  await f.runtime.dispose()
})

test("繁忙群历史分页到上限即停止，不扫描整段群历史", async () => {
  const f = fixture({ handler: (req, respond) => {
    const page = Number(req.params.message_seq === "wake" ? 0 : req.params.message_seq)
    respond(req, [row(String(page + 1), "他人", epoch - page - 1, { user_id: "2" }),
      row(req.params.message_seq, "锚点", epoch - page, { user_id: "2" })])
  } })
  try {
    f.cfg.conversation.preTrigger.historyPageSize = 2
    await f.runtime.handleEvent(f.event())
    assert.equal(f.conn.requests.length, 3)
    assert.equal(f.logs[0].data.reason, "page_limit")
    assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 1)
  } finally { await f.runtime.dispose() }
})

test("初始化队列达到50条后放弃历史，保留已接纳消息并继续正常会话", async () => {
  const f = fixture({ handler: () => {} })
  try {
    const first = f.runtime.handleEvent(f.event())
    while (!f.conn.requests.length) await Promise.resolve()
    for (let i = 1; i <= 50; i++)
      await f.runtime.handleEvent(f.event("续话" + i, { message_id: "next-" + i }))
    await first
    const messages = f.runtime.buffer.get("group:88").pendingMessages
    assert.equal(messages.length, 51)
    assert.equal(messages.at(-1).text, "续话50")
    assert.equal(f.runtime.historyInitializations.size, 0)
    assert.equal(f.conn.bot.adapter.echo.size, 0)
    assert.equal(f.conn.requests.length, 1)
  } finally { await f.runtime.dispose() }
})

test("历史初始化最多8个群并行，其他群不等待历史，dispose清理全部请求", async () => {
  const f = fixture({ handler: () => {} })
  f.cfg.groupWhitelist.enabled = false
  f.cfg.conversation.preTrigger.historyTimeoutMs = 1000
  const pending = Array.from({ length: 8 }, (_, i) => f.runtime.handleEvent(f.event("派蒙", { group_id: String(i) })))
  while (f.conn.requests.length < 8) await Promise.resolve()
  assert.equal(await f.runtime.handleEvent(f.event("派蒙", { group_id: "extra" })), true)
  assert.equal(f.runtime.buffer.get("group:extra").pendingMessages.length, 1)
  assert.equal(f.conn.requests.length, 8)
  await f.runtime.dispose()
  await Promise.all(pending)
  assert.equal(f.conn.bot.adapter.echo.size, 0)
  assert.equal(f.conn.ws.listenerCount("close"), 0)
})

test("回看时限热缩短后按新范围筛选，昵称清洗仅影响本次呼唤，保留前文原称谓", async () => {
  const f = fixture({ handler: () => {} })
  try {
    f.cfg.trigger.stripTriggerName = true
    const first = f.runtime.handleEvent(f.event("派蒙你说呢"))
    while (!f.conn.requests.length) await Promise.resolve()
    f.cfg.conversation.preTrigger.windowMs = 3000
    f.conn.respond(f.conn.requests[0], [row("too-old"), row("recent", "派大王会喜欢吗", epoch - 1), anchor()])
    await first
    assert.deepEqual(f.runtime.buffer.get("group:88").pendingMessages.map(m => m.text), ["派大王会喜欢吗", "你说呢"])
  } finally { await f.runtime.dispose() }
})

test("模型调用期间重传同一消息不重复入队，已回复批次也按消息ID去重", async () => {
  const f = fixture()
  let resolve, began
  const started = new Promise(r => { began = r })
  f.runtime.client.complete = async () => { began(); return new Promise(r => { resolve = r }) }
  try {
    await f.runtime.handleEvent(f.event())
    const flushing = f.runtime.buffer.flush("group:88")
    await started
    await f.runtime.handleEvent(f.event())
    assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 0)
    resolve({ data: { shouldReply: true, reason: "direct_address", reply: "好", emotion: "neutral" } })
    await flushing
    await f.runtime.handleEvent(f.event())
    assert.equal(f.runtime.buffer.get("group:88").pendingMessages.length, 0)
    assert.equal(f.conn.requests.length, 1)
  } finally { await f.runtime.dispose() }
})
