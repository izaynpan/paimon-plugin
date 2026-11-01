import test from 'node:test'
import assert from 'node:assert/strict'
import { completeWithResearch } from '../lib/research.js'
import { publicBuildQuery } from '../lib/build-analysis-prompt.js'
import { buildGames } from '../lib/build-games.js'
import { WebSearchService } from '../lib/web-search.js'

const source = { url: 'https://example.com/build', title: '公开培养资料', content: '公开机制与条件' }
function fixture(game = 'gs') {
  const controller = new AbortController(), logs = [], calls = [], requests = []
  const args = { buildGame: game, combineBuildSources: true, publicQuery: (_kind, round) => publicBuildQuery('测试角色', round, game),
    config: { enabled: true, deepseek: { apiKey: 'test' }, webSearch: { enabled: true, includeSources: true }, knowledge: { enabled: true, provider: 'local' } },
    knowledge: { status: 'miss' }, provider: async () => ({ status: 'miss' }),
    messages: [{ role: 'system', content: '按只读面板、评分和本地套装效果分析。' }, { role: 'user', content: 'PRIVATE_PANEL 不得搜索' }],
    providerArgs: { session: { scene: 'private' }, replyBatchMessages: [{ text: '分析个人面板' }] },
    signal: controller.signal, allowed: async () => true,
    client: { complete: async input => { calls.push(input); return { data: { action: 'answer', reply: '结合两类资料分析。', sourceIds: ['w1'] } } } },
    service: { lookup: async (query, context) => { requests.push({ query, context }); context.stats.search++; return [{ ...source }] } },
    log: async (event, data) => logs.push({ event, ...data }) }
  return { args, controller, logs, calls, requests, run: () => completeWithResearch(args) }
}

test('三游戏分析即使模型直接回答也先检索；本地命中、未命中或异常均不排斥公开证据', async () => {
  for (const game of ['gs', 'sr', 'zzz']) for (const status of ['miss', 'partial', 'complete', 'error']) {
    const f = fixture(game)
    f.args.knowledge = { status, text: '本地可用资料', freshness: 'applicable', revision: 'test' }
    const response = await f.run()
    assert.equal(f.requests.length, 1); assert.equal(f.calls.length, 1)
    assert.match(response.data.reply, /https:\/\/example.com\/build/)
    const prompt = JSON.stringify(f.calls[0].messages)
    assert.match(prompt, /本地可用资料/); assert.match(prompt, /公开机制与条件/)
    assert.equal(f.requests[0].query, publicBuildQuery('测试角色', 0, game))
    assert.doesNotMatch(f.requests[0].query, /PRIVATE_PANEL/)
    assert.equal(f.requests[0].context.needDetails, true)
    assert.equal(f.logs.find(x => x.event === 'search_decision').reason, 'combined_evidence')
  }
})

test('联合分析仍尊重用户不联网、关闭和单题零额度；默认普通聊天不主动搜索', async () => {
  for (const mode of ['forbid', 'disabled', 'zero', 'ordinary', 'no_public_query']) {
    const f = fixture()
    if (mode === 'forbid') f.args.providerArgs.replyBatchMessages[0].text += '，不用联网'
    if (mode === 'disabled') f.args.config.webSearch.enabled = false
    if (mode === 'zero') f.args.config.webSearch.maxSearches = 0
    if (mode === 'ordinary') delete f.args.buildGame
    if (mode === 'no_public_query') delete f.args.publicQuery
    await f.run()
    assert.equal(f.requests.length, 0, mode); assert.equal(f.calls.length, 1)
  }
})

test('预检索与模型补搜共享两次搜索、三轮模型与总时限，不重置预算或泄露模型查询', async () => {
  const f = fixture(), contexts = []; let round = 0
  f.args.knowledge = { status: 'complete', freshness: 'applicable', text: '本地机制' }
  f.args.client.complete = async () => ({ data: ++round < 3
    ? { action: 'search', scope: 'teyvat', reason: 'partial', query: 'PRIVATE_PANEL 123456789', missingFacts: ['循环条件'] }
    : { action: 'answer', reply: '有限结论' } })
  f.args.service.lookup = async (query, context) => { contexts.push(context); assert.doesNotMatch(query, /PRIVATE|123456789/); context.stats.search++; return [{ ...source }] }
  await f.run()
  assert.equal(round, 3); assert.equal(contexts.length, 2)
  assert.equal(contexts[0].stats, contexts[1].stats); assert.equal(contexts[1].stats.search, 2)
  assert.equal(contexts[0].options.maxFetches, 3)
  assert.equal(f.logs.find(x => x.event === 'search_summary').modelCalls, 3)

  const timed = fixture(); let now = 1000, model = 0
  timed.args.now = () => now; timed.args.config.webSearch.timeoutMs = 1000
  timed.args.client.complete = async () => {
    if (++model === 1) { now += 1001; return { data: { action: 'search', scope: 'teyvat', reason: 'partial', missingFacts: ['机制'] } } }
    return { data: { reply: '依据已有证据。' } }
  }
  await timed.run()
  assert.equal(timed.requests.length, 1) // The elapsed first window is not renewed for a supplement.
})

test('联网失败或空结果仍把本地证据交给最终分析，取消期间不会开始模型请求', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); f.args.knowledge = { text: '可靠本地机制', status: 'partial' }
    f.args.service.lookup = async () => { if (fail) throw Error('network'); return [] }
    await f.run()
    const prompt = JSON.stringify(f.calls[0].messages)
    assert.match(prompt, /可靠本地机制/); assert.match(prompt, /搜索无可用结果|联网未完成/)
    assert.match(prompt, /只允许最终回答/)
  }
  const f = fixture(); let release, started
  const ready = new Promise(r => { started = r })
  f.args.service.lookup = async () => { started(); return new Promise(r => { release = r }) }
  const pending = f.run(); await ready; f.controller.abort(); release([{ ...source }])
  await assert.rejects(pending); assert.equal(f.calls.length, 0)
})

test('预检索不绕过真实服务每日额度，缓存命中不会再次收费，用户重搜才绕缓存', async () => {
  let external = 0
  const service = new WebSearchService({ cacheFile: null, budgetFile: null, fetchImpl: async url => {
    external++
    return new Response(JSON.stringify(url.endsWith('search') ? { results: [{ ...source, summary: '攻略摘要' }] } : { content: '公开机制正文' }),
      { headers: { 'content-type': 'application/json' } })
  } })
  const f = fixture(); f.args.service = service
  await f.run(); const first = external
  assert.ok(first > 0); await f.run(); assert.equal(external, first)
  f.args.config.webSearch.dailyRequestLimit = 0
  f.args.providerArgs.replyBatchMessages[0].text = '重新联网核对'
  await f.run(); assert.equal(external, first)
  assert.match(JSON.stringify(f.calls.at(-1).messages), /联网未完成或受预算限制/)
})

test('模型补充的跨游戏scope仍被拒绝；程序预检索仅查询已确认游戏', async () => {
  const f = fixture('sr'); let round = 0
  f.args.client.complete = async () => ({ data: ++round === 1
    ? { action: 'search', scope: 'teyvat', reason: 'partial', missingFacts: ['机制'] } : { reply: '已有证据。' } })
  await f.run(); assert.equal(f.requests.length, 1)
  assert.ok(f.requests[0].query.startsWith(buildGames.sr.name))
  assert.ok(f.logs.some(x => x.reason === 'invalid_decision'))
})
