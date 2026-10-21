import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { StickerCatalog, exactStickerFile, stickerCandidates } from "../lib/sticker-catalog.js"
import { ContextualStickerSelector, validateStickerSelection, chooseStickerSlot } from "../lib/sticker-selector.js"
import { normalizeStickerIntent } from "../lib/sticker-intent.js"
import { buildChatMessages, buildUnansweredFollowUpMessages } from "../lib/prompt-builder.js"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { ReplyPacer } from "../lib/reply-pacer.js"
import { prepareEntry } from "../lib/model-logger.js"

const hash = value => createHash("sha256").update(value).digest("hex")
const intent = (extra = {}) => ({ allowed: true, profiles: ["happy"], intensity: "中", tone: "自然", topics: ["开心"], characters: [], ...extra })
const context = { current: "好开心", reply: "派蒙也高兴", recent: "" }
const cfg = () => ({ enabled: true, deepseek: { apiKey: "test", maxRetries: 3 },
  stickers: { enabled: true, mode: "contextual", probability: 1, selectionTimeoutMs: 1000 } })

function item(name, seq, extra = {}) {
  const relative = `stickers/${seq}-素材/${name}.png`
  return { id: `stk_${hash(relative).slice(0, 16)}`, path: relative, contentHash: hash("image"),
    directorySequence: seq, reviewStatus: "annotated", candidateEligible: true,
    characters: [{ name, role: "primary" }], expressionSubject: [name], paimonSelfExpression: name === "派蒙",
    visibleDescription: "微笑", visibleText: [], emotions: ["开心"], intents: ["表达高兴"],
    semanticProfile: "happy", intensity: "中", tone: "自然", topics: ["开心"],
    suitableContexts: ["轻松分享好消息"], unsuitableContexts: ["不可对难过的人幸灾乐祸"],
    sceneConstraint: "核对微笑含义", notes: [], confidence: { contextualMeaning: "medium" }, ...extra }
}
function catalog(items = [item("派蒙", 1), item("达达利亚", 2), item("其他角色", 9)]) {
  return { items, aliases: { 达达利亚: ["公子"] }, latestDirectories: new Set(["9-素材", "2-素材"]) }
}
const emptySelection = { paimon: null, character: null, recent: null }
function selection(request, overrides = {}) {
  const data = JSON.parse(request.messages[1].content)
  return { data: { ...Object.fromEntries(Object.entries(data.candidates).map(([key, list]) => [key, list[0]?.id || null])), ...overrides } }
}
const fakeCatalog = data => ({ load: async () => data, readImage: async () => Buffer.from("image") })

test("表情意图缺失/坏字段保守跳过，中性回复可提供独立意图", () => {
  for (const value of [undefined, {}, { allowed: false }, intent({ profiles: ["invented"] }),
    intent({ intensity: "极高" }), intent({ topics: [3] }), intent({ characters: ["公子"] })])
    assert.equal(normalizeStickerIntent(value), null)
  assert.deepEqual(normalizeStickerIntent(intent()), intent())
  assert.ok(normalizeStickerIntent(intent({ profiles: ["sleep"], topics: ["睡眠"], intensity: "低" })))
})

test("表情协议仅按语境模式加载，补话不加载，兼容旧情绪字段", () => {
  const session = { scene: "private", participants: {}, sessionBatches: [] }
  const config = cfg()
  const build = () => buildChatMessages({ session, config, replyBatchMessages: [{ text: "你好" }] })[0].content
  assert.match(build(), /stickerIntent/)
  assert.match(build(), /emotion/)
  config.stickers.mode = "legacy"; assert.doesNotMatch(build(), /stickerIntent/)
  config.stickers.mode = "contextual"; config.stickers.enabled = false; assert.doesNotMatch(build(), /stickerIntent/)
  config.stickers.enabled = true
  const follow = buildUnansweredFollowUpMessages({ session, config, question: { sentAt: 1, batchIndex: 0 }, now: 2 })
  assert.doesNotMatch(follow[0].content, /stickerIntent/)
})

test("候选按主体互斥，别名有本轮依据才进入角色池，旧话题不会自动延续", () => {
  const data = catalog()
  const grounded = intent({ characters: [{ name: "公子", source: "current", evidence: "公子" }] })
  const a = stickerCandidates(data, grounded, { ...context, current: "公子今天很开心" })
  assert.equal(a.hasCharacter, true)
  assert.equal(a.pools.paimon.length, 1); assert.equal(a.pools.character.length, 1); assert.equal(a.pools.recent.length, 1)
  assert.equal(new Set(Object.values(a.pools).flat().map(x => x.id)).size, 3)
  const b = stickerCandidates(data, grounded, { ...context, recent: "公子很开心" })
  assert.equal(b.hasCharacter, false); assert.equal(b.pools.character.length, 0)
  const referenced = intent({ characters: [{ name: "公子", source: "recent", evidence: "公子", reference: "他呢" }] })
  assert.equal(stickerCandidates(data, referenced, { ...context, current: "那他呢", recent: "公子很开心" }).hasCharacter, true)
  assert.equal(stickerCandidates(data, referenced, { ...context, current: "换个话题", recent: "公子很开心" }).hasCharacter, false)
  const associated = catalog([item("阿乔", 9, { associatedCharacters: ["基尼奇"] })])
  assert.equal(stickerCandidates(associated, intent({ characters: [{ name: "基尼奇", source: "current", evidence: "基尼奇" }] }),
    { ...context, current: "基尼奇" }).pools.character.length, 0)
})

test("候选保留类别位置且最多18张，强度/具体动作主题不匹配不召回", () => {
  const data = catalog(Array.from({ length: 30 }, (_, n) => item("角色" + n, 9)))
  data.items.push(item("派蒙", 1))
  const pools = stickerCandidates(data, intent(), context).pools
  assert.equal(pools.paimon.length, 1); assert.equal(pools.recent.length, 6)
  assert.equal(stickerCandidates(catalog([item("派蒙", 1, { semanticProfile: "hungry", topics: ["食物"] })]),
    intent({ profiles: ["hungry"], topics: ["开心"] }), context).pools.paimon.length, 0)
  assert.equal(stickerCandidates(catalog([item("派蒙", 1, { semanticProfile: "hungry", topics: ["食物"] })]),
    intent({ profiles: ["hungry"], topics: ["食物"] }), context).pools.paimon.length, 1)
  assert.equal(stickerCandidates(catalog([item("派蒙", 1, { intensity: "高" })]), intent(), context).pools.paimon.length, 0)
  assert.equal(stickerCandidates(catalog([item("派蒙", 1, { semanticProfile: "cry" })]),
    intent({ profiles: ["comfort"] }), context).pools.paimon.length, 0)
})

test("概率槽不重新归一化，空槽只回退派蒙，派蒙空槽不借其他角色凑数", () => {
  const selected = { paimon: item("派蒙", 1), character: item("达达利亚", 2), recent: item("其他", 9) }
  const counts = { paimon: 0, character: 0, recent: 0 }
  for (let n = 0; n < 10000; n++) counts[chooseStickerSlot(selected, true, n / 10000).pool]++
  assert.deepEqual(counts, { paimon: 7500, character: 2000, recent: 500 })
  assert.equal(chooseStickerSlot(selected, false, 0.94).pool, "paimon")
  assert.equal(chooseStickerSlot(selected, false, 0.96).pool, "recent")
  assert.equal(chooseStickerSlot({ ...selected, character: null }, true, 0.8).pool, "paimon")
  assert.equal(chooseStickerSlot({ ...selected, paimon: null }, true, 0.1), null)
  assert.equal(chooseStickerSlot({ ...selected, paimon: null, character: null }, true, 0.8), null)
})

test("选图编号严格归属本轮类别，拒绝任意路径、跨池编号和坏结构", () => {
  const pools = stickerCandidates(catalog(), intent(), context).pools
  assert.ok(validateStickerSelection(emptySelection, pools))
  for (const data of [{}, [], { ...emptySelection, extra: 1 }, { ...emptySelection, paimon: "../secret" },
    { ...emptySelection, paimon: pools.recent[0].id }]) assert.equal(validateStickerSelection(data, pools), null)
})

test("概率未命中/无意图/无素材不调用模型；连续两轮允许同一图片", async () => {
  let requests = 0, sent = 0
  const selector = new ContextualStickerSelector({ catalog: fakeCatalog(catalog()), random: () => 0 })
  const config = cfg()
  const input = { config, rawIntent: intent(), context, allowed: async () => true,
    client: { complete: async request => { requests++; assert.equal(request.config.deepseek.maxRetries, 0);
      assert.equal(request.config.deepseek.thinking.type, "disabled"); return selection(request) } },
    sendImage: async read => { assert.ok(Buffer.isBuffer(await read())); sent++; return true } }
  assert.equal(await selector.send(input), true); assert.equal(await selector.send(input), true)
  assert.equal(requests, 2); assert.equal(sent, 2)
  config.stickers.probability = 0; assert.equal(await selector.send(input), false)
  config.stickers.probability = 1; assert.equal(await selector.send({ ...input, rawIntent: {} }), false)
  selector.catalog = fakeCatalog(catalog([])); assert.equal(await selector.send(input), false)
  assert.equal(requests, 2)
})

test("选图null/非法/异常/超时不发送且不重试；不响应取消的客户端也不会拖住会话", async () => {
  const selector = new ContextualStickerSelector({ catalog: fakeCatalog(catalog()), random: () => 0 })
  let sent = 0, calls = 0
  const input = { config: cfg(), rawIntent: intent(), context, allowed: async () => true, sendImage: async () => { sent++; return true } }
  for (const result of [emptySelection, {}, { ...emptySelection, paimon: "foreign" }]) {
    assert.equal(await selector.send({ ...input, client: { complete: async () => { calls++; return { data: result } } } }), false)
  }
  assert.equal(await selector.send({ ...input, client: { complete: async () => { calls++; throw Error("network") } } }), false)
  const logs = []
  assert.equal(await selector.send({ ...input, log: async (_, data) => logs.push(data),
    client: { complete: () => { calls++; return new Promise(() => {}) } } }), false)
  assert.equal(logs.at(-1).status, "timeout")
  assert.equal(calls, 5); assert.equal(sent, 0)
})

async function diskFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-context-stickers-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const items = [item("派蒙", 1), item("达达利亚", 2), item("其他角色", 9)]
  for (const x of items) { await fs.mkdir(path.dirname(path.join(root, x.path)), { recursive: true }); await fs.writeFile(path.join(root, x.path), "image") }
  const docs = path.join(root, "docs/stickers")
  await fs.mkdir(docs, { recursive: true })
  const save = () => fs.writeFile(path.join(docs, "catalog.json"), JSON.stringify({ schemaVersion: 1, items }))
  await save(); await fs.writeFile(path.join(docs, "character-aliases.json"), JSON.stringify({ aliases: { 达达利亚: ["公子"] } }))
  return { root, items, save, loader: new StickerCatalog({ root }) }
}

test("实际目录数字排序决定最大五组，新建未标注目录占位且不启用未标注图片", async t => {
  const f = await diskFixture(t)
  for (const dir of ["10-素材", "11-素材", "12-空目录", "无序号", "100-file"]) {
    if (dir === "100-file") await fs.writeFile(path.join(f.root, "stickers", dir), "not a directory")
    else await fs.mkdir(path.join(f.root, "stickers", dir))
  }
  const c = await f.loader.load()
  assert.deepEqual([...c.latestDirectories], ["12-空目录", "11-素材", "10-素材", "9-素材", "2-素材"])
  assert.equal(c.items.length, 3)
  await fs.mkdir(path.join(f.root, "stickers", "13-新增"))
  assert.equal((await f.loader.load()).latestDirectories.has("2-素材"), false)
})

test("库存重新加载，排除与低可信度不启用，重复编号拒绝整库", async t => {
  const f = await diskFixture(t)
  assert.equal((await f.loader.load()).items.length, 3)
  f.items[1].reviewStatus = "excluded"; f.items[2].confidence.contextualMeaning = "low"; await f.save()
  assert.equal((await f.loader.load()).items.length, 1)
  f.items.push(f.items[0]); await f.save()
  await assert.rejects(f.loader.load(), /duplicate/)
})

test("原图缺失/内容替换/大小写/越界/符号链接均拒绝，不改图片", async t => {
  const f = await diskFixture(t), x = f.items[0]
  assert.equal((await f.loader.readImage(x)).toString(), "image")
  for (const bad of ["../outside.png", "stickers/../outside.png", x.path.replace("stickers", "Stickers"), x.path.replace(".png", ".PNG")])
    await assert.rejects(exactStickerFile(f.root, bad))
  await fs.writeFile(path.join(f.root, x.path), "replacement")
  await assert.rejects(f.loader.readImage(x), /changed_asset/)
  await fs.unlink(path.join(f.root, x.path)); await assert.rejects(f.loader.readImage(x))
  try { await fs.symlink(path.join(f.root, f.items[1].path), path.join(f.root, x.path)) }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.diagnostic("Windows当前权限不允许创建文件符号链接，其余文件边界已验证"); return } throw error }
  await assert.rejects(f.loader.readImage(x), /linked_asset/)
})

test("发送前再次检查文件摘要，等待期间替换的图不会发送", async t => {
  const f = await diskFixture(t), logs = []
  const selector = new ContextualStickerSelector({ catalog: f.loader, random: () => 0 })
  let sent = false
  const ok = await selector.send({ config: cfg(), context, rawIntent: intent(), allowed: async () => true,
    client: { complete: async request => selection(request) }, log: async (_, data) => logs.push(data),
    sendImage: async read => { await fs.writeFile(path.join(f.root, f.items[0].path), "changed while pacing"); await read(); sent = true } })
  assert.equal(ok, false); assert.equal(sent, false); assert.equal(logs.at(-1).status, "selection_failed")
})

function runtimeFixture(t, extra = {}) {
  const config = { ...cfg(), trigger: { privateTrigger: true, groupMentionTrigger: true },
    groupWhitelist: { enabled: true, groups: ["88"] }, memory: { enabled: false },
    conversation: { debounceMs: 100000, activeWindowMs: 90000, preTrigger: { enabled: false } },
    reply: { split: false, minDelayMs: 0, maxDelayMs: 0, sendRetries: 0 } }
  const sent = [], requests = [], logs = []
  let data = { reply: "派蒙也高兴", emotion: "neutral", stickerIntent: intent() }, select = async request => selection(request)
  const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async request => { requests.push(request); return request.trace.type === "sticker_selection" ? select(request) : { data } } },
    stickerSelector: new ContextualStickerSelector({ catalog: fakeCatalog(catalog()), random: () => 0 }),
    modelLogger: { write: async (event, data) => logs.push({ event, data }) }, knowledgeProvider: async () => ({}),
    logger: () => {}, ...extra })
  t.after(() => runtime.dispose())
  let serial = 0
  const event = (msg = "好开心", reply = async x => { sent.push(x); return true }) => ({ msg, isGroup: true, group_id: "88",
    user_id: "1", self_id: "9", atBot: true, message_id: String(++serial), reply })
  const turn = async e => { await runtime.handleEvent(e || event()); await runtime.buffer.flush("group:88") }
  return { config, sent, requests, logs, runtime, event, turn, respond: x => { data = x }, onSelect: fn => { select = fn } }
}

test("中性文字全部成功后才选图，输入使用实际成功文本，图片失败不会触发聊天兜底", async t => {
  const f = runtimeFixture(t)
  f.onSelect(async request => {
    assert.deepEqual(f.sent, ["派蒙也高兴"])
    assert.equal(JSON.parse(request.messages[1].content).sentReply, "派蒙也高兴")
    return selection(request)
  })
  await f.turn(); assert.equal(f.sent[1].type, "image")
  assert.equal(f.requests.length, 2)
  f.sent.length = 0
  await f.turn(f.event("好开心", async x => { f.sent.push(x); if (typeof x !== "string") throw Error("protocol failed"); return true }))
  assert.equal(f.sent.length, 2)
  assert.equal(f.runtime.buffer.get("group:88").sessionBatches.at(-1).failed, false)
})

test("部分文字发送失败不选图，合法沉默、错误兜底和缺失意图不选图", async t => {
  const f = runtimeFixture(t)
  f.config.reply = { ...f.config.reply, split: true, minSegmentLength: 1, maxSegmentLength: 5 }
  f.respond({ reply: "第一句。第二句。", emotion: "happy", stickerIntent: intent() })
  let n = 0
  await f.turn(f.event("你好", async () => ++n === 1))
  assert.equal(f.requests.length, 1)
  f.config.conversation.selectiveGroupReply = true
  f.respond({ shouldReply: false, reason: "no_response_needed", reply: "", emotion: "neutral", stickerIntent: intent() })
  await f.turn(); assert.equal(f.requests.length, 2)
  f.config.conversation.selectiveGroupReply = false; f.respond({ invalid: true })
  await f.turn(); assert.equal(f.requests.length, 3)
  f.respond({ reply: "普通回答", emotion: "happy" }); await f.turn(); assert.equal(f.requests.length, 4)
})

for (const change of ["new_message", "disabled", "plugin_disabled", "whitelist", "key", "mode", "dispose"]) {
  test(`选图在途 ${change} 取消；忽略signal的迟到结果也不会发送`, async t => {
    const f = runtimeFixture(t)
    let resolveSelection, started
    const ready = new Promise(resolve => { started = resolve })
    f.onSelect(request => new Promise(resolve => { resolveSelection = () => resolve(selection(request)); started() }))
    const turn = f.turn(); await ready
    if (change === "new_message") await f.runtime.handleEvent(f.event("换个话题"))
    else if (change === "dispose") await f.runtime.dispose()
    else {
      if (change === "disabled") f.config.stickers.enabled = false
      if (change === "plugin_disabled") f.config.enabled = false
      if (change === "whitelist") f.config.groupWhitelist.groups = []
      if (change === "key") f.config.deepseek.apiKey = "changed"
      if (change === "mode") f.config.stickers.mode = "legacy"
      f.runtime.revalidateStickers(f.config)
    }
    await turn; resolveSelection(); await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(f.sent, ["派蒙也高兴"])
    assert.equal(f.runtime.stickerJobs.size, 0)
  })
}

test("发送节奏等待期间取消可提前结束等待，不污染成功时钟", async t => {
  let now = 0, waiting
  const ready = new Promise(resolve => { waiting = resolve })
  let calls = 0
  const pacer = new ReplyPacer({ now: () => now, random: () => 0.5, sleep: async (ms, signal) => {
    if (++calls === 1) { now += ms; return }
    waiting()
    await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); if (signal.aborted) resolve() })
  } })
  const f = runtimeFixture(t, { replyPacer: pacer })
  f.config.reply = { split: false, minDelayMs: 10, maxDelayMs: 10 }
  const turn = f.turn(); await ready
  await f.runtime.handleEvent(f.event("换话题")); await turn
  assert.deepEqual(f.sent, ["派蒙也高兴"])
  assert.equal(pacer.states.get("group:88").lastLength, [..."派蒙也高兴"].length)
})

test("语境模式明确迁移先图后文，legacy仍走旧发送顺序", async t => {
  const warnings = []
  const f = runtimeFixture(t, { logger: (_, message) => warnings.push(message),
    stickerSender: async ({ e }) => e.reply({ type: "legacy-image" }) })
  f.config.stickers.sendAfterText = false
  await f.turn(); assert.equal(typeof f.sent[0], "string"); assert.equal(f.sent[1].type, "image")
  assert.ok(warnings.some(x => x.includes("sendAfterText:false")))
  f.sent.length = 0; f.requests.length = 0; f.config.stickers.mode = "legacy"
  await f.turn(); assert.equal(f.sent[0].type, "legacy-image"); assert.equal(typeof f.sent[1], "string")
  assert.equal(f.requests.length, 1)
})

test("选图请求和结果正文沿用既有日志开关，选择元数据不包含语境正文", async () => {
  const logs = [], selector = new ContextualStickerSelector({ catalog: fakeCatalog(catalog()), random: () => 0 })
  await selector.send({ config: cfg(), context, rawIntent: intent(), allowed: async () => true,
    client: { complete: async req => selection(req) }, sendImage: async () => true, log: async (_, data) => logs.push(data) })
  assert.doesNotMatch(JSON.stringify(logs), /好开心|派蒙也高兴/)
  const request = prepareEntry("model_request", { type: "sticker_selection", request: { messages: [{ role: "user", content: "private" }] } }, { includePrompt: false })
  assert.equal(request.request.messages[0].content, "[OMITTED]")
  const response = prepareEntry("model_response", { response: { content: "private", data: { private: true } } }, { includeResponse: false })
  assert.equal(response.response.data, undefined)
})

test("联网中间动作不选图，只对最终已发送文字选择一次", async t => {
  let chats = 0, selections = 0, lookups = 0
  const f = runtimeFixture(t, { webSearchService: { lookup: async () => { lookups++; return [] } },
    client: { complete: async request => {
      if (request.trace.type === "sticker_selection") { selections++; return selection(request) }
      chats++
      return { data: chats === 1 ? { action: "search", scope: "teyvat", reason: "missing", query: "角色机制", missingFacts: ["技能机制"], needDetails: false,
        stickerIntent: intent() } : { action: "answer", reply: "还没查到可靠资料", emotion: "neutral", stickerIntent: intent() } }
    } } })
  f.config.webSearch = { enabled: true }
  await f.turn()
  assert.equal(chats, 2); assert.equal(lookups, 1); assert.equal(selections, 1)
  assert.deepEqual(f.sent.map(x => typeof x === "string" ? x : x.type), ["还没查到可靠资料", "image"])
})

test("指令结果不进入语境选图，命令批次保持原标记", async t => {
  let selections = 0
  const f = runtimeFixture(t, { commandRouter: { prepare: async () => ({ sources: [{}], capabilities: [{}] }),
    invoke: async () => ({ attempts: 1, successes: 1 }), revalidate() {}, dispose() {} },
    stickerSelector: { send: async () => { selections++ } } })
  f.respond({ action: "invoke_command", stickerIntent: intent() })
  await f.turn()
  assert.equal(selections, 0)
  assert.equal(f.runtime.buffer.get("group:88").sessionBatches.at(-1).origin, "command")
})

test("文字发送期间接纳新消息也放弃旧轮表情，仍完整保留已发文字", async t => {
  const f = runtimeFixture(t)
  await f.turn(f.event("好开心", async text => {
    f.sent.push(text)
    await f.runtime.handleEvent(f.event("换个话题"))
    return true
  }))
  assert.deepEqual(f.sent, ["派蒙也高兴"])
  assert.equal(f.requests.length, 1)
  // Also cover a message queued before the sticker job had a chance to register.
  await f.runtime.replyBatch({ session: f.runtime.buffer.get("group:88"),
    replyBatchMessages: [{ text: "旧批次" }], replyEvent: f.event() })
  assert.equal(f.requests.length, 2)
  assert.deepEqual(f.sent, ["派蒙也高兴", "派蒙也高兴"])
})

test("合成语境召回覆盖食物、奖励、吐槽、安慰、攻略说明与晚安", () => {
  const scenes = [
    ["今晚吃好吃的", "hungry", "食物", "中"], ["拿到宝箱啦", "reward", "奖励", "高"],
    ["又要派蒙跑腿呀", "annoyed", "吐槽", "中"], ["派蒙陪着你", "comfort", "安慰", "低"],
    ["配队还要看角色能量需求", "explain", "说明", "低"], ["晚安啦", "sleep", "睡眠", "低"],
  ]
  for (const [reply, profile, topic, intensity] of scenes) {
    const material = item("派蒙", 1, { semanticProfile: profile, topics: [topic], intensity })
    const pools = stickerCandidates(catalog([material]), intent({ profiles: [profile], topics: [topic], intensity }),
      { current: reply, reply, recent: "" }).pools
    assert.equal(pools.paimon[0]?.id, material.id)
  }
})
