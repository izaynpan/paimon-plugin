import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WebSearchService, webSearchOptions, searchApiKey, publicUrl, safeQuery, excerpt } from "../lib/web-search.js"
import { normalizeKnowledge, readKnowledge } from "../lib/knowledge-provider.js"
import { completeWithResearch } from "../lib/research.js"
import { PaimonRuntime } from "../lib/paimon-runtime.js"
import { splitReply } from "../lib/reply-splitter.js"
import { buildChatMessages } from "../lib/prompt-builder.js"

const answer = { reply: "可以先试试这个组合", emotion: "neutral" }
const search = { action: "search", scope: "teyvat", reason: "missing", query: "原神 角色A 配队", missingFacts: ["配队依据"] }
const cfg = () => ({ enabled: true, deepseek: { apiKey: "test", maxRetries: 1 },
  webSearch: { enabled: true, cacheTtlMs: 3600000 }, knowledge: { enabled: false }, conversation: {} })
const json = data => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
const item = (n, content = "已提供的角色配队正文") => ({ title: "攻略" + n,
  url: "https://example.com/guide/" + n, content, summary: "仅摘要", rerank_score: 3 - n / 10 })
const stats = () => ({ search: 0, fetch: 0, successful: 0, cacheHits: 0, errors: [] })
const context = (config = cfg()) => ({ config, options: webSearchOptions(config), signal: new AbortController().signal,
  allowed: async () => true, revision: "v1", stats: stats() })

function runner(outputs, override = {}) {
  const calls = [], logs = [], lookups = []
  const config = cfg()
  const controller = new AbortController()
  const args = { config, messages: [{ role: "system", content: "原有 JSON 协议" }, { role: "user", content: "新角色配队" }],
    client: { complete: async request => { calls.push(request); return { data: structuredClone(outputs.shift()) } } },
    service: { lookup: async (query, ctx) => { lookups.push(query); ctx.stats.search++;
      return [{ ...item(1), id: "untrusted", fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 3600000 }] } },
    knowledge: { status: "miss" }, provider: async () => ({ status: "miss" }),
    providerArgs: { session: { scene: "private" }, replyBatchMessages: [{ text: "新角色配队" }] },
    signal: controller.signal, allowed: async () => !controller.signal.aborted,
    log: async (event, data) => logs.push({ event, ...data }), ...override }
  return { args, controller, calls, logs, lookups, run: () => completeWithResearch(args) }
}

test("联网默认关闭，预算有硬上限，零额度可禁止请求", () => {
  assert.equal(webSearchOptions({}).enabled, false)
  assert.deepEqual(Object.fromEntries(Object.entries(webSearchOptions({ webSearch: {
    maxSearches: 99, maxFetches: 99, dailyRequestLimit: 0, cacheTtlMs: 0 } }))
    .filter(([key]) => ["maxSearches", "maxFetches", "dailyRequestLimit", "cacheTtlMs"].includes(key))),
  { maxSearches: 2, maxFetches: 3, dailyRequestLimit: 0, cacheTtlMs: 0 })
})

test("搜索和抓取使用专用Key，缺省或空白时沿用聊天Key", async () => {
  for (const key of [undefined, "", "  ", " dedicated-test "]) {
    const config = cfg(); config.webSearch.apiKey = key
    const expected = key?.trim() || config.deepseek.apiKey
    assert.equal(searchApiKey(config), expected)
    const calls = []
    const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async (url, request) => {
      calls.push(url)
      assert.equal(request.headers.Authorization, "Bearer " + expected)
      return json(url.endsWith("search") ? { results: [item(1, "")] } : { content: "完整配队资料" })
    } })
    await service.lookup(search.query, context(config))
    assert.equal(calls.length, 2)
    assert.equal(config.deepseek.apiKey, "test")
  }
})

test("工具缓存按实际搜索Key隔离，换Key不重置每日额度", async () => {
  const config = cfg(); config.webSearch.apiKey = "dedicated-a"; config.webSearch.dailyRequestLimit = 2
  let now = Date.parse("2026-10-17"), calls = 0
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, now: () => now,
    fetchImpl: async () => { calls++; return json({ results: [item(1)] }) } })
  await service.lookup(search.query, context(config))
  config.deepseek.apiKey = "changed-chat"
  await service.lookup(search.query, context(config))
  assert.equal(calls, 1)
  config.webSearch.apiKey = "dedicated-b"; now += 500
  await service.lookup(search.query, context(config))
  assert.equal(calls, 2)
  config.webSearch.apiKey = ""; now += 500
  await assert.rejects(service.lookup(search.query, context(config)), /daily request limit/)
  assert.equal(calls, 2)
})

test("搜索专用Key鉴权失败不会回退聊天Key或自动重试", async () => {
  const config = cfg(); config.webSearch.apiKey = "dedicated-invalid"
  let calls = 0
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async (url, request) => {
    calls++; assert.equal(request.headers.Authorization, "Bearer dedicated-invalid")
    return new Response("", { status: 401 })
  } })
  await assert.rejects(service.lookup(search.query, context(config)), /401/)
  assert.equal(calls, 1)
})

test("知识库旧接口不假定已核验，过期/未来活动不能视为当前适用", () => {
  assert.equal(normalizeKnowledge({ text: "旧资料" }).freshness, "unknown")
  assert.equal(normalizeKnowledge({ status: "complete", text: "活动", freshness: "applicable",
    validUntil: "2026-10-16" }, Date.parse("2026-10-17")).freshness, "outdated")
  assert.equal(normalizeKnowledge({ status: "complete", text: "活动", freshness: "applicable",
    validFrom: "2026-10-18" }, Date.parse("2026-10-17")).freshness, "outdated")
  assert.equal(normalizeKnowledge({ status: "complete", freshness: "applicable" }).status, "miss")
})

test("知识检索异常/超时可降级，不把失败伪装成未命中", async () => {
  assert.equal((await readKnowledge(async () => { throw Error("private detail") }, {})).status, "error")
  assert.equal((await readKnowledge(() => new Promise(() => {}), {}, { timeoutMs: 5 })).status, "error")
})

test("普通回复只调用一次模型，不调用搜索；规划请求无隐藏重试", async () => {
  const r = runner([answer])
  assert.deepEqual((await r.run()).data, answer)
  assert.equal(r.calls.length, 1)
  assert.equal(r.lookups.length, 0)
  assert.equal(r.calls[0].config.deepseek.maxRetries, 0)
  assert.match(r.calls[0].messages[0].content, /世界外技术/)
})

test("联网输出协议在群私聊及沉默/补话组合中区分中间动作与最终回答", async () => {
  const persona = await fs.readFile(new URL("../config/persona.md", import.meta.url), "utf8")
  for (const scene of ["private", "group"]) for (const selective of [false, true]) for (const followUp of [false, true]) {
    const config = cfg()
    config.conversation = { selectiveGroupReply: selective, unansweredFollowUp: { enabled: followUp } }
    const providerArgs = { session: { scene, participants: {}, sessionBatches: [] },
      replyBatchMessages: [{ userId: "1", text: "测试角色甲的配队" }] }
    const messages = buildChatMessages({ ...providerArgs, persona, config })
    const r = runner([search, answer], { config, providerArgs, messages })
    await r.run()
    const prompt = r.calls[0].messages[0].content
    const example = JSON.parse(prompt.match(/完整结构示例：(.*)/)[1])
    assert.equal(example.action, "answer")
    assert.equal("shouldReply" in example, scene === "group" && selective)
    assert.equal("followUp" in example, followUp)
    assert.match(prompt, /字段要求仅适用于最终回复\/澄清\/沉默/)
    assert.match(prompt, /中间 search\/lookup_local.*独立结构/)
    assert.match(prompt, /自己不认识角色.*知识缺口/)
    assert.match(prompt, /先按用户原名.*搜索核实/)
    assert.match(prompt, /上下文无可解析对象.*查证前澄清/)
    assert.match(prompt, /个人持有角色.*不可公开查询/)
    assert.match(prompt, /此联网决策细化人设/)
    assert.doesNotMatch(prompt, /实体或关键条件不清楚时直接提出简短澄清/)
    config.webSearch.enabled = false
    const disabled = buildChatMessages({ ...providerArgs, persona, config })[0].content
    assert.doesNotMatch(disabled, /中间 search\/lookup_local|"action":"answer"|知识库优先与联网协议/)
  }
})

test("续话核实保留前文对象与新补充，查后可澄清，不要求用户先提供公开资料", async () => {
  const config = cfg()
  const providerArgs = { session: { scene: "private", participants: {}, sessionBatches: [
    { messages: [{ userId: "1", text: "测试角色甲的配队" }], reply: "这是哪位角色？" },
  ] }, replyBatchMessages: [{ userId: "1", text: "是刚登场的新角色" }] }
  const messages = buildChatMessages({ ...providerArgs, config })
  const clarification = { action: "clarify", clarifyReason: "unresolved_identity", reply: "能确认一下名字的写法吗？", emotion: "confused" }
  const r = runner([{ ...search, query: "原神 测试角色甲 配队" }, clarification], { config, providerArgs, messages,
    service: { lookup: async () => [] } })
  assert.deepEqual((await r.run()).data, clarification)
  assert.match(r.calls[0].messages[1].content, /测试角色甲/)
  assert.match(r.calls[0].messages[1].content, /是刚登场的新角色/)
  assert.match(r.calls[0].messages[0].content, /先前自己说不知道.*不构成继续追问/)
  assert.match(r.calls[1].messages[0].content, /禁止 search\/lookup_local/)
  assert.match(r.calls[1].messages.at(-1).content, /无可用结果，不代表对象不存在/)
  assert.equal(r.calls.length, 2)
})

test("直接回答/澄清/沉默记录有限决策元数据，旧格式兼容且不多调模型", async () => {
  for (const [data, expected, explicit, reason] of [
    [answer, "answer", false],
    [{ ...answer, action: "answer" }, "answer", true],
    [{ ...answer, action: "clarify", clarifyReason: "ambiguous_reference" }, "clarify", true, "ambiguous_reference"],
    [{ ...answer, action: "clarify", clarifyReason: "private data" }, "clarify", true, "unspecified"],
    [{ action: "skip", shouldReply: false, reply: "", emotion: "neutral" }, "skip", true],
  ]) {
    const r = runner([data]); await r.run()
    const decision = r.logs.find(item => item.event === "search_decision")
    assert.equal(decision.action, expected)
    assert.equal(decision.actionExplicit, explicit)
    assert.equal(decision.clarifyReason, reason)
    assert.equal(decision.knowledgeStatus, "miss")
    assert.equal(r.calls.length, 1); assert.equal(r.lookups.length, 0)
    assert.doesNotMatch(JSON.stringify(r.logs), /private data|可以先试试这个组合/)
  }
})

test("完整适用知识库阻止搜索，部分/过期资料允许查证", async () => {
  for (const [status, freshness, expected] of [["complete", "applicable", 0], ["partial", "applicable", 1],
    ["complete", "outdated", 1], ["error", "unknown", 0]]) {
    const r = runner([search, answer], { knowledge: { text: "资料", status, freshness } })
    await r.run()
    assert.equal(r.lookups.length, expected)
  }
})

test("要求不联网优先；只有真实重新联网要求才能覆盖本地完整资料", async () => {
  for (const [text, count] of [["不要联网，回答新角色配队", 0], ["重新联网核对新角色配队", 1]]) {
    const r = runner([search, answer], { knowledge: { text: "资料", status: "complete", freshness: "applicable" },
      providerArgs: { session: { scene: "private" }, replyBatchMessages: [{ text }] } })
    await r.run()
    assert.equal(r.lookups.length, count)
  }
})

test("合法沉默即使夹带搜索动作也不联网", async () => {
  const r = runner([{ ...search, shouldReply: false, reason: "asked_to_stop", reply: "", emotion: "neutral" }])
  assert.equal((await r.run()).data.shouldReply, false)
  assert.equal(r.lookups.length, 0)
})

test("错误范围、畸形查询、隐私查询、伪造刷新理由均不发工具请求", async () => {
  for (const bad of [{ ...search, scope: "outside" }, { ...search, query: "QQ 123456789" },
    { ...search, query: "a".repeat(129) }, { ...search, missingFacts: [] },
    { ...search, reason: "explicit_refresh" }]) {
    const r = runner([bad, answer]); await r.run(); assert.equal(r.lookups.length, 0)
  }
  assert.equal(safeQuery("sk-supersecret"), null)
  assert.equal(safeQuery("someone@example.com"), null)
})

test("先补本地检索再联网，最多三次模型调用且中间动作不直接当回复", async () => {
  const config = cfg(); config.knowledge.enabled = true
  let localQueries = []
  const r = runner([{ action: "lookup_local", query: "角色别名" }, search, answer], { config,
    provider: async ({ query }) => { localQueries.push(query); return { status: "miss" } } })
  assert.deepEqual((await r.run()).data, answer)
  assert.deepEqual(localQueries, ["角色别名"])
  assert.equal(r.calls.length, 3)
  assert.equal(r.lookups.length, 1)
  assert.match(r.calls[2].messages[0].content, /禁止 search\/lookup_local/)
})

test("知识库关闭时误选补本地仍可继续搜索，不提前封死最后两轮", async () => {
  let localCalls = 0
  const r = runner([{ action: "lookup_local", query: "测试角色乙 圣遗物" },
    { ...search, query: "原神 测试角色乙 圣遗物 属性收益" }, answer], {
    provider: async () => { localCalls++; throw Error("关闭时不能调用知识库") },
    providerArgs: { session: { scene: "private" }, replyBatchMessages: [{ text: "测试角色乙的圣遗物词条影响辅助收益吗" }] },
  })
  assert.deepEqual((await r.run()).data, answer)
  assert.equal(localCalls, 0)
  assert.equal(r.lookups.length, 1)
  assert.equal(r.calls.length, 3)
  assert.doesNotMatch(r.calls[1].messages[0].content, /禁止 search\/lookup_local/)
  assert.match(r.calls[1].messages[0].content, /本轮不提供 lookup_local/)
  assert.match(r.calls[1].messages.at(-1).content, /知识库未启用.*不代表联网不可用/)
  const decision = r.logs.find(l => l.action === "lookup_local")
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, "knowledge_disabled")
  assert.equal(r.logs.at(-1).localLookups, 0)
})

test("只在知识库可补查时提供本地动作，补查未命中后仍允许联网", async () => {
  const config = cfg(); config.knowledge.enabled = true
  const r = runner([{ action: "lookup_local", query: "角色别名" }, search, answer], { config })
  await r.run()
  const data = request => JSON.parse(request.messages.at(-1).content.split("\n").slice(1).join("\n"))
  assert.equal(data(r.calls[0]).localLookupAvailable, true)
  assert.equal(data(r.calls[1]).localLookupAvailable, false)
  assert.match(r.calls[1].messages[0].content, /本轮不提供 lookup_local/)
  assert.doesNotMatch(r.calls[1].messages[0].content, /禁止 search\/lookup_local/)
  assert.equal(r.lookups.length, 1)
})

test("知识库服务异常与未启用分开处理，不把服务错误当资料缺失联网", async () => {
  const config = cfg(); config.knowledge.enabled = true
  const r = runner([{ action: "lookup_local", query: "角色别名" }, answer], {
    config, knowledge: { status: "error" }, provider: async () => { throw Error("不应补查") },
  })
  await r.run()
  assert.equal(r.lookups.length, 0)
  assert.match(r.calls[1].messages[0].content, /禁止 search\/lookup_local/)
  assert.equal(r.logs.find(l => l.action === "lookup_local").reason, "knowledge_error")
})

test("反复选择不可用本地动作仍限制三轮，不偷偷把本地查询改成付费搜索", async () => {
  const local = { action: "lookup_local", query: "测试角色乙 圣遗物" }
  const r = runner([local, local, local])
  assert.match((await r.run()).data.reply, /没确认/)
  assert.equal(r.calls.length, 3)
  assert.equal(r.lookups.length, 0)
})

test("误选不可用本地动作后仍尊重完整知识和用户禁止联网", async () => {
  for (const forbid of [false, true]) {
    const r = runner([{ action: "lookup_local", query: "测试角色乙 圣遗物" }, search, answer], {
      knowledge: { status: "complete", freshness: "applicable", text: "覆盖本题的可靠资料" },
      providerArgs: { session: { scene: "private" }, replyBatchMessages: [{ text: forbid ? "不要联网，聊圣遗物" : "聊圣遗物" }] },
    })
    await r.run()
    assert.equal(r.lookups.length, 0)
    if (!forbid) assert.equal(r.logs.find(l => l.action === "search").reason, "knowledge_sufficient")
  }
})

test("圣遗物具体养成缺少机制依据时先查证，已有可靠资料或只是通用解释不重复搜", async () => {
  const r = runner([answer]); await r.run()
  const prompt = r.calls[0].messages[0].content
  assert.match(prompt, /具体角色的圣遗物.*主副词条.*属性收益/)
  assert.match(prompt, /不必等用户说.*搜一下/)
  assert.match(prompt, /完整适用的本地资料或有效网页.*直接回答/)
  assert.match(prompt, /通用术语解释.*不因出现.*圣遗物.*联网/)
  assert.equal(r.lookups.length, 0)
})

test("连续搜索有轮数限制；最后一轮继续申请工具则保守结束", async () => {
  const r = runner([search, { ...search, query: "原神 角色A 循环" }, { ...search, query: "原神 角色A 数值" }])
  assert.match((await r.run()).data.reply, /没确认/)
  assert.equal(r.calls.length, 3)
  assert.equal(r.lookups.length, 2)
})

test("搜索证据放在数据消息而非系统指令，引用只能映射已有来源", async () => {
  const config = cfg(); config.webSearch.includeSources = true
  const r = runner([search, { ...answer, reply: "参考这个 https://evil.example/invented", sourceIds: ["w1", "fake"] }], { config })
  const reply = (await r.run()).data.reply
  assert.match(reply, /https:\/\/example.com\/guide\/1/)
  assert.doesNotMatch(reply, /evil\.example|fake/)
  assert.doesNotMatch(r.calls[1].messages[0].content, /已提供的角色配队正文/)
  assert.match(r.calls[1].messages.at(-1).content, /已提供的角色配队正文/)
})

test("会话复用有效证据；知识修订或缓存过期不再注入旧网页", async () => {
  const previousContext = { revision: "v1|", sources: [{ ...item(1), id: "w1", fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 10000 }] }
  for (const [revision, expected] of [["v1", true], ["v2", false]]) {
    const r = runner([answer], { knowledge: { revision }, previousContext })
    await r.run()
    assert.equal(r.calls[0].messages.at(-1).content.includes("已提供的角色配队正文"), expected)
  }
  previousContext.sources[0].expiresAt = 0
  const r = runner([answer], { knowledge: { revision: "v1" }, previousContext }); await r.run()
  assert.doesNotMatch(r.calls[0].messages.at(-1).content, /已提供的角色配队正文/)
})

test("查询失败只进入一次最终回答，不循环搜索且日志不存查询正文", async () => {
  const r = runner([search, answer], { service: { lookup: async () => { throw Object.assign(Error("private data"), { code: "http_429" }) } } })
  await r.run()
  assert.equal(r.calls.length, 2)
  assert.match(r.calls[1].messages.at(-1).content, /未完成/)
  assert.doesNotMatch(JSON.stringify(r.logs), /private data|角色A|配队依据/)
})

test("在途查询取消后不调用最终模型，忽略不遵守取消的迟到接口", async () => {
  let started
  const ready = new Promise(resolve => { started = resolve })
  const r = runner([search, answer], { service: { lookup: async () => { started(); return new Promise(() => {}) } } })
  const p = r.run(); await ready; r.controller.abort()
  await assert.rejects(p, /cancelled/)
  assert.equal(r.calls.length, 1)
})

test("总查询超时后降级，允许最终模型说明资料不足", async () => {
  const config = cfg(); config.webSearch.timeoutMs = 1000
  const r = runner([search, answer], { config, service: { lookup: () => new Promise(() => {}) } })
  assert.deepEqual((await r.run()).data, answer)
  assert.equal(r.calls.length, 2)
})

test("URL过滤拒绝IP、凭证和明显内部地址；摘录优先保留相关段落", () => {
  for (const value of ["file:///secret", "http://127.0.0.1", "http://2130706433", "http://[::1]", "http://a.local",
    "https://user:password@example.com", "https://example.com:1234"]) assert.equal(publicUrl(value), null)
  assert.equal(publicUrl("https://example.com/guide#part"), "https://example.com/guide")
  assert.match(excerpt("无关内容".repeat(100) + "\n\n角色A 正确循环", "原神 角色A", 50), /正确循环/)
})

test("Search正文足够不Fetch，重复请求命中缓存且不伪造新的抓取时间", async () => {
  let calls = 0, now = Date.parse("2026-10-17T00:00:00Z")
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, now: () => now,
    fetchImpl: async (url, req) => { calls++; assert.equal(url, "https://api.deepseek.com/v1/tools/search");
      assert.equal(req.redirect, "error"); assert.equal(JSON.parse(req.body).count, 5); return json({ results: [item(1)] }) } })
  const first = await service.lookup(search.query, context())
  now += 500
  const ctx = context(); const second = await service.lookup(search.query, ctx)
  assert.equal(calls, 1)
  assert.equal(ctx.stats.cacheHits, 1)
  assert.equal(second[0].fetchedAt, first[0].fetchedAt)
  const other = context(); other.revision = "v2"
  await service.lookup(search.query, other)
  assert.equal(calls, 2)
})

test("Search无正文只抓前两页；Fetch失败保留带摘要标记的证据", async () => {
  const urls = []
  const service = new WebSearchService({ cacheFile: null, budgetFile: null,
    fetchImpl: async (url, req) => { urls.push(url);
      if (url.endsWith("search")) return json({ results: [item(1, ""), item(2, ""), item(3, "")] })
      if (JSON.parse(req.body).url.endsWith("1")) return new Response("", { status: 404 })
      return json({ content: "抓取后的配队条件" }) } })
  const ctx = context(); const sources = await service.lookup(search.query, ctx)
  assert.equal(ctx.stats.search, 1); assert.equal(ctx.stats.fetch, 2)
  assert.equal(sources[0].summaryOnly, true)
  assert.equal(sources[1].summaryOnly, false)
  assert.equal(sources[2].summaryOnly, true)
  assert.equal(urls.length, 3)
})

test("每日请求预算在发送前落盘，重建服务仍遵守额度，次日重新计数", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-search-"))
  try {
    let now = Date.parse("2026-10-17T00:00:00Z"), calls = 0
    const config = cfg(); config.webSearch.dailyRequestLimit = 1
    const args = { budgetFile: path.join(dir, "budget.json"), now: () => now,
      fetchImpl: async () => { calls++; return json({ results: [] }) } }
    await new WebSearchService({ ...args, cacheFile: null }).lookup("原神 卡池", context(config))
    await assert.rejects(new WebSearchService({ ...args, cacheFile: null }).lookup("原神 新角色", context(config)), /daily request limit/)
    assert.equal(calls, 1)
    now += 86400000
    await new WebSearchService({ ...args, cacheFile: null }).lookup("原神 新角色", context(config))
    assert.equal(calls, 2)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("预算文件损坏时不付费调用；工具错误不自动重试", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-search-"))
  try {
    const file = path.join(dir, "budget.json"); await fs.writeFile(file, "broken")
    const service = new WebSearchService({ cacheFile: null, budgetFile: file, fetchImpl: () => { throw Error("must not call") } })
    await assert.rejects(service.lookup(search.query, context()), /budget unavailable/)
    let calls = 0
    const failing = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async () => { calls++; return new Response("", { status: 500 }) } })
    await assert.rejects(failing.lookup(search.query, context()), /500/)
    assert.equal(calls, 1)
  } finally {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("运行时开关关闭保持一次调用；开启后只发送最终回答，不发送搜索动作", async () => {
  for (const enabled of [false, true]) {
    const config = cfg(); config.webSearch.enabled = enabled
    config.webSearch.apiKey = "dedicated-test"
    config.memory = { enabled: false }; config.reply = { split: false, minDelayMs: 0, maxDelayMs: 0 }
    let calls = 0, lookups = 0
    const sent = []
    const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => "派蒙", getStickers: () => ({}) },
      client: { complete: async request => {
        assert.equal(request.config.deepseek.apiKey, "test")
        return { data: enabled && calls++ === 0 ? search : answer }
      } },
      webSearchService: { lookup: async () => { lookups++; return [] } },
      modelLogger: { write: async () => {} }, stickerSender: async () => false, logger: () => {} })
    try {
      await runtime.replyBatch({ session: { id: "s", scene: "private", sessionKey: "private:1", participants: {}, sessionBatches: [] },
        replyBatchMessages: [{ text: "新角色配队" }], replyEvent: { reply: async value => { sent.push(value); return true } } })
      assert.deepEqual(sent, [answer.reply]); assert.equal(lookups, enabled ? 1 : 0)
      assert.equal(runtime.researchJobs.size, 0)
    } finally { await runtime.dispose() }
  }
})

test("运行时热关搜索/移出白名单/移除key/dispose取消在途查询，不迟到发送", async () => {
  for (const mode of ["switch", "whitelist", "key", "search-key-change", "search-key-clear", "search-key-add", "dispose", "stop"]) {
    const config = cfg(); config.groupWhitelist = { enabled: true, groups: ["88"] }
    if (mode !== "search-key-add") config.webSearch.apiKey = "dedicated-test"
    config.memory = { enabled: false }; config.reply = { split: false, minDelayMs: 0, maxDelayMs: 0 }
    let start; const ready = new Promise(resolve => { start = resolve }); const sent = []
    const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => "派蒙", getStickers: () => ({}) },
      client: { complete: async () => ({ data: search }) },
      webSearchService: { lookup: async () => { start(); return new Promise(() => {}) } },
      modelLogger: { write: async () => {} }, stickerSender: async () => false, logger: () => {} })
    const job = runtime.replyBatch({ session: { id: "s", scene: "group", groupId: "88", sessionKey: "group:88", participants: {}, sessionBatches: [] },
      replyBatchMessages: [{ text: "新角色配队" }], replyEvent: { reply: async value => { sent.push(value); return true } } })
    await ready
    if (mode === "switch") config.webSearch.enabled = false
    if (mode === "whitelist") config.groupWhitelist.groups = []
    if (mode === "key") config.deepseek.apiKey = ""
    if (mode === "search-key-change" || mode === "search-key-add") config.webSearch.apiKey = "dedicated-new"
    if (mode === "search-key-clear") config.webSearch.apiKey = ""
    if (mode === "dispose") await runtime.dispose()
    if (mode === "stop") {
      config.conversation.debounceMs = 100000
      await runtime.handleEvent({ isGroup: true, group_id: "88", self_id: "9", user_id: "1",
        message: [{ type: "at", qq: "9" }, { type: "text", text: "别查了" }], reply: async () => true })
    }
    runtime.revalidateResearch(config)
    assert.equal((await job).failed, true); assert.deepEqual(sent, [])
    await runtime.dispose()
  }
})

test("新一轮搜索的缺口资料不会被上一轮长正文挤出；来源ID不冲突", async () => {
  const config = cfg(); config.webSearch.maxContextChars = 1000
  let count = 0
  const r = runner([search, { ...search, query: "原神 角色A 新队友" }, answer], { config,
    service: { lookup: async () => [{ ...item(++count, count === 1 ? "旧".repeat(6000) : "新队友依据"),
      fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 5000 }] } })
  await r.run()
  const data = JSON.parse(r.calls[2].messages.at(-1).content.split("\n").slice(1).join("\n"))
  assert.match(data.webSources[0].content, /新队友依据/)
  assert.equal(new Set(data.webSources.map(item => item.id)).size, data.webSources.length)
  assert.ok(data.webSources.reduce((n, item) => n + item.content.length, 0) <= 1000)
})

test("概述使用足够的长摘要时省Fetch，详细条件要求可读取原文", async () => {
  let fetches = 0
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async url => {
    if (url.endsWith("search")) return json({ results: [{ ...item(1, ""), summary: "概述".repeat(400) }] })
    fetches++; return json({ content: "详细循环" })
  } })
  const first = await service.lookup(search.query, context())
  assert.equal(fetches, 0); assert.equal(first[0].summaryOnly, true)
  const detailed = await service.lookup(search.query, { ...context(), needDetails: true })
  assert.equal(fetches, 1); assert.equal(detailed[0].summaryOnly, false)
})

test("超过响应大小限制即停止读取，不将整页塞进模型", async () => {
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async () => new Response("x", {
    headers: { "content-length": "2000001" },
  }) })
  await assert.rejects(service.lookup(search.query, context()), /too large/)
})

test("搜索来源链接不会因问号或最大分段字数被切断", () => {
  const url = "https://example.com/" + "a".repeat(200) + "?version=1&character=a"
  assert.deepEqual(splitReply("回答。\n参考1：" + url, { maxSegmentLength: 30 }), ["回答", "参考1：" + url])
})

test("单进程并发请求不会穿透每日额度", async () => {
  let calls = 0
  const config = cfg(); config.webSearch.dailyRequestLimit = 1
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async () => { calls++; return json({ results: [] }) } })
  const results = await Promise.allSettled([service.lookup("原神 配队", context(config)), service.lookup("原神 卡池", context(config))])
  assert.equal(calls, 1)
  assert.equal(results.filter(r => r.status === "rejected").length, 1)
})

test("同一公开查询合并在途请求，取消等待者不影响其他群", async () => {
  let finish, started; let calls = 0
  const ready = new Promise(resolve => { started = resolve })
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async () => {
    calls++; started(); return new Promise(resolve => { finish = () => resolve(json({ results: [item(1)] })) })
  } })
  const first = service.lookup(search.query, context()); await ready
  const controller = new AbortController()
  const second = service.lookup(search.query, { ...context(), signal: controller.signal })
  const thirdCtx = context(); const third = service.lookup(search.query, thirdCtx)
  controller.abort(); await assert.rejects(second, /cancelled/)
  finish(); await first; await third
  assert.equal(calls, 1); assert.equal(thirdCtx.stats.cacheHits, 1)
})

test("空结果短缓存避免连搜；到期后允许重新查证", async () => {
  let now = Date.parse("2026-10-17"), calls = 0
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, now: () => now,
    fetchImpl: async () => { calls++; return json({ results: [] }) } })
  await service.lookup(search.query, context()); await service.lookup(search.query, context())
  assert.equal(calls, 1)
  now += 61000
  await service.lookup(search.query, context()); assert.equal(calls, 2)
})

test("完整知识被截断或时间元数据无效时不冒充完整有效", () => {
  const value = normalizeKnowledge({ text: "x".repeat(20000), status: "complete", freshness: "applicable" })
  assert.equal(value.status, "partial"); assert.equal(value.truncated, true)
  assert.equal(normalizeKnowledge(value).truncated, true)
  assert.equal(normalizeKnowledge({ text: "卡池", status: "complete", freshness: "applicable", validUntil: "坏日期" }).freshness, "unknown")
})

test("最终模型已返回但配置关闭时仍阻止联网答案发送", async () => {
  const config = cfg(); config.reply = { split: false, minDelayMs: 0, maxDelayMs: 0 }; config.memory = { enabled: false }
  let calls = 0; const sent = []
  const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => "派蒙", getStickers: () => ({}) },
    client: { complete: async () => {
      if (calls++ === 0) return { data: search }
      config.webSearch.enabled = false
      return { data: answer }
    } }, webSearchService: { lookup: async () => [] },
    modelLogger: { write: async () => {} }, stickerSender: async () => false, logger: () => {} })
  try {
    const result = await runtime.replyBatch({ session: { id: "s", scene: "private", sessionKey: "private:1", participants: {}, sessionBatches: [] },
      replyBatchMessages: [{ text: "新角色配队" }], replyEvent: { reply: async value => { sent.push(value); return true } } })
    assert.equal(result.failed, true); assert.deepEqual(sent, [])
  } finally { await runtime.dispose() }
})

test("发起共享请求的会话取消后，其他仍获准的会话可以继续自己的查询", async () => {
  let start, calls = 0
  const ready = new Promise(resolve => { start = resolve })
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async () => {
    if (++calls === 1) { start(); return new Promise(() => {}) }
    return json({ results: [item(1)] })
  } })
  const leader = new AbortController()
  const first = service.lookup(search.query, { ...context(), signal: leader.signal }); await ready
  const second = service.lookup(search.query, context())
  leader.abort(); await assert.rejects(first, /cancelled/)
  assert.equal((await second).length, 1); assert.equal(calls, 2)
})
