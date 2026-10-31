import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BuildAnalysis } from '../lib/build-analysis.js'
import { MiaoProfileProvider, profileFacts } from '../lib/miao-profile-provider.js'
import { CommandBridge } from '../lib/command-bridge.js'
import { CommandRouter } from '../lib/command-router.js'
import { commandCatalog } from '../lib/command-catalog.js'
import { PanelTargets } from '../lib/panel-request.js'
import { createCommandLoader } from './helpers/command-loader.js'
import { PaimonRuntime } from '../lib/paimon-runtime.js'
import { ModelLogger } from '../lib/model-logger.js'
import { CommandEntities } from '../lib/command-entities.js'

const config = () => ({ enabled: true, buildAnalysis: { enabled: true }, commandRouting: { enabled: true, cooldownMs: 0 },
  deepseek: { apiKey: 'test' }, webSearch: { enabled: true, includeSources: true }, logging: { enabled: true },
  trigger: { nicknames: ['派蒙'], privateTrigger: true, ignoreCommandPrefixes: ['#', '*', '%'] },
  conversation: { debounceMs: 100000, activeWindowMs: 90000 }, reply: { minDelayMs: 0, maxDelayMs: 0 }, memory: { enabled: false } })
let serial = 0
const event = (text = '我的芙宁娜还能怎么提升', extra = {}) => {
  const sent = []
  return { user_id: '10001', self_id: '20002', group_id: '30003', isGroup: true, isPrivate: false,
    message_type: 'group', post_type: 'message', sender: { nickname: '请求者', role: 'member' },
    message_id: String(++serial), msg: text, message: [{ type: 'text', text }], sent,
    reply: async value => { sent.push(value); return { message_id: 'out' } }, ...extra }
}
const entities = {
  inText: async (game, _kind, text) => game === 'gs' ? Object.entries({ 芙宁娜: '芙宁娜', 水神: '芙宁娜', 刻晴: '刻晴' }).filter(([a]) => text.includes(a)) : [],
  resolve: async (game, _kind, text) => game === 'gs' ? ({ 芙宁娜: '芙宁娜', 水神: '芙宁娜', 刻晴: '刻晴' })[text] : null,
}
const facts = { character: '芙宁娜', level: 90, weapon: { name: '西风剑', refinement: 3 },
  score: { total: 201, weights: { hpPct: 90, recharge: 100 } }, updatedAt: '2026-01-02T00:00:00.000Z' }
function setup(overrides = {}) {
  const cfg = config(), calls = [], logs = []
  const bridge = { available: async () => true, execute: async args => { calls.push(args); return { status: 'responded', attempts: 1, successes: 1 } } }
  const commands = new CommandRouter({ getConfig: async () => cfg, bridge, entities,
    targets: new PanelTargets({ request: async () => [{ user_id: '40004', card: '测试群友', nickname: '测试昵称' }] }) })
  const provider = { read: async () => ({ status: 'ready', snapshot: { facts: structuredClone(facts), uid: '123456789' } }),
    render: async ({ e, onReply, allowed }) => { if (await allowed()) { const value = await e.reply({ type: 'image', file: 'test' }); onReply?.(value) } } }
  Object.assign(provider, overrides)
  const analysis = new BuildAnalysis({ commands, getConfig: async () => cfg, profileProvider: provider,
    log: async (type, data, config) => { logs.push({ type, data, config }) } })
  return { cfg, commands, provider, analysis, calls, logs }
}
async function run(s, e = event(), opts = {}) {
  const request = await s.analysis.request(e, s.cfg)
  assert.ok(request, e.msg)
  s.analysis.admit(e, request)
  const selection = s.analysis.select([{ userId: e.user_id }], [e])
  return s.analysis.run({ selection, config: s.cfg,
    client: { complete: async () => ({ data: { action: 'answer', reply: '优先改善充能循环，再考虑替换词条。' } }) },
    service: { lookup: async () => [] }, knowledgeProvider: async () => ({}),
    sendText: async (source, text, allowed) => await allowed() && source.reply(text), sessionAllowed: async () => true, ...opts })
}

test('养成入口：本人、别名、明确分析、普通看图和公开攻略分流', async () => {
  const s = setup()
  for (const text of ['我的芙宁娜还能怎么提升', '派蒙，帮我分析一下水神面板', '好，派蒙，分析我的芙宁娜',
    '只用本地资料分析我的芙宁娜', '看看我的芙宁娜练度', '分析芙宁娜', '换成芙宁娜分析', '我的水神怎么培养'])
    assert.equal((await s.analysis.request(event(text), s.cfg))?.character, '芙宁娜', text)
  for (const text of ['看芙宁娜面板', '芙宁娜怎么培养', '帮我分析芙宁娜的技能机制', '分析芙宁娜命座抽取价值',
    '芙宁娜圣遗物攻略', '#芙宁娜面板', '不要分析我的芙宁娜', '他说“我的芙宁娜还能怎么提升”', '如果分析我的水神'])
    assert.equal(await s.analysis.request(event(text), s.cfg), null, text)
  assert.ok((await s.analysis.request(event('分析我的芙宁娜和刻晴'), s.cfg)).hint)
  assert.ok((await s.analysis.request(event('星铁面板怎么提升'), s.cfg)).hint)
  const off = config(); off.buildAnalysis.enabled = false
  assert.equal(await s.analysis.request(event(), off), null)
})

test('分析的群名片、QQ昵称、真实@目标解析与重名澄清', async () => {
  const s = setup()
  for (const name of ['测试群友', '测试昵称'])
    assert.equal((await s.analysis.request(event(`分析${name}的芙宁娜面板`), s.cfg)).targetUserId, '40004')
  const e = event('分析芙宁娜面板')
  e.message.unshift({ type: 'at', qq: '50005', name: '目标用户' })
  assert.equal((await s.analysis.request(e, s.cfg)).targetUserId, '50005')
  assert.ok((await s.analysis.request(event('分析陌生人的芙宁娜面板'), s.cfg)).hint)
  s.commands.targets = new PanelTargets({ request: async () => [{ user_id: '40004', card: '重名' }, { user_id: '40005', card: '重名' }] })
  assert.ok((await s.analysis.request(event('分析重名的芙宁娜面板'), s.cfg)).hint)
})

test('不依赖主动沉默/长期记忆；白名单、私聊关闭、禁用能力行仍有效', async () => {
  const s = setup(), e = event()
  s.cfg.conversation.selectiveGroupReply = false
  assert.ok(await s.analysis.request(e, s.cfg))
  s.cfg.groupWhitelist = { enabled: true, groups: [] }
  assert.equal(await s.analysis.request(e, s.cfg), null)
  e.isGroup = false; e.isPrivate = true; s.cfg.trigger.privateTrigger = false
  assert.equal(await s.analysis.request(e, s.cfg), null)
  s.cfg.trigger.privateTrigger = true; s.cfg.commandRouting.disabledRows = ['C04']
  assert.equal(await s.analysis.request(e, s.cfg), null)
})

test('分析不发铺垫；同一快照发图和给建议；会话返回仅含无装备细节摘要', async () => {
  const s = setup(), e = event(); let read = 0, seen
  const snapshot = { facts, uid: '123456789' }
  s.provider.read = async () => { read++; return { status: 'ready', snapshot } }
  s.provider.render = async args => { assert.equal(args.snapshot, snapshot); args.onReply(await args.e.reply({ type: 'image' })) }
  const result = await run(s, e, { client: { complete: async input => { seen = input; return { data: { reply: '生命值与循环要结合队伍判断。' } } } } })
  assert.equal(read, 1); assert.equal(e.sent.length, 2); assert.equal(e.sent[0].type, 'image')
  assert.match(e.sent[1], /生命/); assert.equal(result.origin, 'command')
  assert.doesNotMatch(result.reply, /生命|201|西风/)
  assert.equal(seen.config.logging.includePrompt, false); assert.equal(seen.config.logging.includeResponse, false)
  const messages = JSON.stringify(seen.messages)
  for (const privateValue of ['123456789', '10001', '20002', '30003', '请求者']) assert.ok(!messages.includes(privateValue))
  assert.match(messages, /201/); assert.match(messages, /不是伤害|伤害百分比/)
})

test('搜索/补本地只能用程序公开查询；最多三轮且继续复用研究预算与来源', async () => {
  const s = setup(), e = event(); let model = 0, network = 0
  const response = await run(s, e, {
    client: { complete: async input => {
      assert.equal(input.config.deepseek.maxRetries, 0)
      model++
      return { data: model < 3 ? { action: 'search', query: '测试昵称123456789 私人面板201', scope: 'teyvat', reason: 'missing', missingFacts: ['公开机制'], needDetails: true }
        : { action: 'answer', reply: '应先保证循环。', sourceIds: ['w1'] } }
    } }, service: { lookup: async (query, options) => {
      network++; assert.match(query, /^原神 芙宁娜 /); assert.doesNotMatch(query, /123456789|测试昵称|201/)
      assert.equal(options.options.maxSearches, 2); assert.equal(options.options.maxFetches, 3)
      return [{ url: 'https://example.com/guide', title: '公开攻略', content: '可靠条件', fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 10000 }]
    } },
  })
  assert.equal(model, 3); assert.equal(network, 2); assert.equal(response.failed, false)
  assert.match(e.sent.at(-1), /https:\/\/example.com\/guide/)
  assert.equal(s.logs.find(l => l.type === 'search_summary').data.modelCalls, 3)
})

test('不联网约束和功能关闭阻止联网；模型提议泄露私人本地查询也被替换', async () => {
  for (const mode of ['user', 'config', 'searchMode']) {
    const s = setup(), e = event(mode === 'user' ? '我的芙宁娜还能怎么提升，不用联网' : undefined)
    if (mode === 'config') s.cfg.webSearch.enabled = false
    if (mode === 'searchMode') s.cfg.buildAnalysis.searchMode = 'off'
    let calls = 0
    await run(s, e, { client: { complete: async () => ({ data: ++calls === 1 ?
      { action: 'search', query: '原神', scope: 'teyvat', reason: 'missing', missingFacts: ['机制'] } : { action: 'answer', reply: '仅根据现有面板分析。' } }) },
    service: { lookup: async () => assert.fail('不应联网') } })
    assert.match(e.sent.at(-1), /现有面板/)
  }
  const s = setup(); s.cfg.knowledge = { enabled: true, provider: 'local' }; let calls = 0, query
  await run(s, event(), { client: { complete: async () => ({ data: ++calls === 1 ? { action: 'lookup_local', query: '私人昵称123456789' } : { action: 'answer', reply: '依据本地资料。' } }) },
    knowledgeProvider: async args => { query = args.query || query; return {} } })
  assert.equal(query, '原神 芙宁娜 技能机制 圣遗物 主副词条 养成攻略')
})

test('无绑定/无面板不给模型编造；渲染失败或搜索失败仍可给有限建议', async () => {
  for (const status of ['unbound', 'missing', 'disabled', 'context_busy', 'unavailable']) {
    const s = setup({ read: async () => ({ status }), render: async () => assert.fail('不应渲染') }), e = event()
    await run(s, e, { client: { complete: async () => assert.fail('无快照不能分析') } })
    assert.equal(e.sent.length, 1)
    if (status === 'missing') assert.match(e.sent[0], /#米游社更新面板/)
  }
  const s = setup({ render: async () => { throw Error('renderer missing') } }), e = event(); let calls = 0
  await run(s, e, { client: { complete: async () => ({ data: ++calls === 1 ?
    { action: 'search', query: '原神', scope: 'teyvat', reason: 'missing', missingFacts: ['机制'] } : { reply: '未确认最新攻略，仅给面板内能支持的建议。' } }) },
    service: { lookup: async () => { throw Error('network') } } })
  assert.equal(e.sent.length, 1); assert.match(e.sent[0], /未确认/)
})

test('显式更新使用米游社入口再读；回复成功不等于数据刷新成功', async () => {
  const s = setup(); let reads = 0, prompt
  s.provider.read = async () => { reads++; return { status: 'ready', snapshot: { facts } } }
  await run(s, event('更新面板再分析芙宁娜'), { client: { complete: async args => {
    prompt = args.messages; return { data: { reply: '使用已有快照。' } }
  } } })
  assert.equal(reads, 2); assert.equal(s.calls[0].capability.id, 'gs.panel.refreshMys')
  assert.match(JSON.stringify(prompt), /refreshConfirmed\\":false/)
  assert.equal(s.calls.length, 1)
})

test('同用户短期分析指代可承接；其他用户、过期和换角色不继承', async () => {
  const s = setup(); await run(s)
  assert.equal((await s.analysis.request(event('这套哪里要改'), s.cfg)).character, '芙宁娜')
  assert.equal((await s.analysis.request(event('我的刻晴这套哪里要改'), s.cfg)).character, '刻晴')
  assert.ok((await s.analysis.request(event('这套哪里要改', { user_id: '50005' }), s.cfg)).hint)
  s.analysis.cancel(event('看刻晴面板'))
  assert.ok((await s.analysis.request(event('这套哪里要改'), s.cfg)).hint)
  await run(s); s.analysis.now = () => Date.now() + 120001
  assert.ok((await s.analysis.request(event('这套哪里要改'), s.cfg)).hint)
})

test('新请求/取消/撤白/换key/关功能/dispose阻止迟到图片与分析；另一用户不取消', async () => {
  for (const reason of ['new', 'cancel', 'whitelist', 'key', 'disable', 'dispose', 'other']) {
    const s = setup(), e = event(); let release, started
    const ready = new Promise(r => { started = r })
    s.cfg.buildAnalysis.includePanelImage = false
    const pending = run(s, e, { client: { complete: async () => { started(); return new Promise(r => { release = r }) } } })
    await ready
    if (reason === 'new' || reason === 'cancel') s.analysis.cancel(e)
    if (reason === 'other') s.analysis.cancel(event('', { user_id: '50005' }))
    if (reason === 'whitelist') s.cfg.groupWhitelist = { enabled: true, groups: [] }
    if (reason === 'key') s.cfg.deepseek.apiKey = 'changed-key'
    if (reason === 'disable') s.cfg.buildAnalysis.enabled = false
    if (reason === 'dispose') s.analysis.dispose()
    s.analysis.revalidate(s.cfg)
    release({ data: { reply: '迟到建议' } }); await pending
    assert.deepEqual(e.sent, reason === 'other' ? ['迟到建议'] : [], reason)
  }
})

test('同一消息重复入队只执行一次；旧分析撤销后不回落普通聊天', async () => {
  const s = setup(), e = event(); let reads = 0
  s.provider.read = async () => { reads++; return { status: 'missing' } }
  await run(s, e); await run(s, e); assert.equal(reads, 1)
  const old = event(); s.analysis.admit(old, await s.analysis.request(old, s.cfg)); s.analysis.cancel(old)
  assert.ok(s.analysis.select([{ userId: old.user_id }], [old]))
  for (const extra of [{ preTrigger: true }, { source: 'history' }, { origin: 'pre_trigger' }, { userId: 'not-the-sender' }])
    assert.equal(s.analysis.select([{ userId: old.user_id, ...extra }], [old]), null)
})

test('重发消息不会取消原分析；用户明确重新联网保留刷新意图且仍仅公开查询', async () => {
  const s = setup(), e = event('重新联网分析我的芙宁娜'); let release, started, searched = false, calls = 0
  const ready = new Promise(r => { started = r })
  const pending = run(s, e, { client: { complete: async () => {
    if (++calls === 1) { started(); return new Promise(r => { release = r }) }
    return { data: { reply: '已核对公开攻略。' } }
  } }, service: { lookup: async (query, options) => {
    searched = true; assert.equal(options.bypassCache, true); assert.match(query, /^原神 芙宁娜 /)
    return []
  } } })
  await ready
  const repeated = event(e.msg, { message_id: e.message_id })
  s.analysis.admit(repeated, await s.analysis.request(repeated, s.cfg))
  release({ data: { action: 'search', scope: 'teyvat', reason: 'explicit_refresh', query: '不可信查询', missingFacts: ['当前配装'] } })
  await pending
  assert.equal(searched, true); assert.equal(e.sent.length, 2); assert.deepEqual(repeated.sent, [])
})

// Synthetic data in the verified Miao Avatar/Artis shape; no production accounts.
function avatar(raw) {
  Object.assign(this, structuredClone(raw))
  this.game = 'gs'; this.name = '芙宁娜'; this.isProfile = true
  this.attr = { hp: 33000, recharge: 160, cpct: 70, cdmg: 140, staticAttr: { private: true } }
  this.base = { hp: 15000 }
  this.talent = { a: { original: 1, level: 1 }, e: { original: 9, level: 12 }, q: { original: 10, level: 10 } }
  this.artis = { forEach: fn => fn({ name: '花', set: '黄金剧团', level: 20, main: { key: 'hpPlus', value: 4780 },
    attrs: [{ key: 'cpct', value: 10.5 }, { key: 'unknown', value: 99 }] }, 1) }
  this.getArtisMark = () => ({ _mark: 123 + this.weapon.affix, markClass: 'S', classTitle: '动态权重', charWeight: { recharge: 90, cpct: 100 },
    artis: { 1: { _mark: 40, pMax: 60, markClass: 'S', name: '花', set: '黄金剧团' } } })
}
function nativeFixture({ disabled = false, missing = false } = {}) {
  const raw = { id: 10000089, level: 90, cons: 2, weapon: { name: '西风剑', level: 90, affix: 3 }, _source: 'mys', _time: 1760000000000 }
  const seen = [], loaded = [], sentProfile = []
  class Handler { async panel(e) { sentProfile.push(e._profile); return e.reply({ type: 'image', file: 'native' }) } }
  const dependencies = createCommandLoader({ init: async e => { e.runtime = { e }; e.user = { realSender: e.user_id } } })
  dependencies.loader.priority = [{ key: 'miao-plugin', class: Handler,
    plugin: { name: '面板', event: 'message', rule: [{ reg: /^#.+面板$/, fnc: 'panel' }] } }]
  const bridge = new CommandBridge({ root: path.resolve('synthetic-root'), dependencies, importModule: async url => {
    loaded.push(url)
    if (url.endsWith('/Avatar.js')) return { default: avatar }
    if (url.endsWith('/Character.js')) return { default: { get: () => ({ id: raw.id, game: 'gs', isRelease: true }) } }
    if (url.endsWith('/Common.js')) return { default: { cfg: () => !disabled } }
    if (url.endsWith('/ProfileCommon.js')) return { getTargetUid: async e => { seen.push(e); return e.at === '40004' ? '234567890' : '123456789' } }
    assert.fail(url)
  } })
  const files = []
  const provider = new MiaoProfileProvider({ bridge, readFile: async file => { files.push(file); return JSON.stringify({ uid: 'private', _ck: 'SECRET', avatars: missing ? {} : { [raw.id]: raw } }) } })
  return { raw, bridge, provider, seen, sentProfile, files, loaded, dependencies }
}

test('原框架分发下只读隔离快照，实际评分方法，目标@保留真实发送者，同一快照原图', async () => {
  const f = nativeFixture(), e = event()
  const args = { e, request: { character: '芙宁娜', targetUserId: '40004' },
    capability: commandCatalog.find(c => c.id === 'gs.panel.show'), allowed: async () => true }
  const result = await f.provider.read(args)
  assert.equal(result.status, 'ready'); assert.deepEqual(e.sent, []); assert.equal(f.sentProfile.length, 0)
  assert.equal(f.seen[0].user_id, e.user_id); assert.equal(f.seen[0].at, '40004')
  assert.match(f.files[0], /234567890\.json$/)
  const snapshot = result.snapshot
  assert.equal(snapshot.facts.score.total, 126); assert.deepEqual(snapshot.facts.score.weights, { recharge: 90, cpct: 100 })
  assert.equal(snapshot.facts.attributes.find(a => a.key === 'recharge').value, 160)
  assert.equal(snapshot.facts.artifacts[0].substats[0].unit, 'percent_points')
  assert.equal(snapshot.facts.artifacts[0].main.unit, 'points')
  assert.equal(snapshot.facts.talents.e.original, 9); assert.equal(snapshot.facts.talents.e.level, 12)
  assert.equal(Object.isFrozen(snapshot.facts.weapon), true)
  assert.doesNotMatch(JSON.stringify(snapshot.facts), /SECRET|234567890|uid|staticAttr|unknown/)
  f.raw.weapon.affix = 5
  await f.provider.render({ ...args, snapshot })
  assert.equal(f.sentProfile[0], snapshot.profile); assert.equal(snapshot.profile.weapon.affix, 3)
  assert.equal(f.files.length, 1); assert.equal(e.sent.length, 1); assert.equal(e._profile, undefined)
})

test('读面板遵循原框架权限/禁用，适配缺失安全降级；不影响普通指令', async () => {
  for (const change of ['disabled', 'missing', 'blacklist', 'owner', 'unavailable', 'mute', 'onlyAt', 'interactive', 'groupDisabled']) {
    const f = nativeFixture({ disabled: change === 'disabled', missing: change === 'missing' })
    const e = event()
    if (change === 'blacklist') f.dependencies.loader.checkBlack = () => false
    if (change === 'owner') f.dependencies.loader.priority[0].plugin.rule[0].permission = 'master'
    if (change === 'unavailable') f.bridge.importModule = async () => { throw Error('changed interface') }
    if (change === 'mute') e.group = { mute_left: 10 }
    if (change === 'onlyAt') f.dependencies.cfg.getGroup = () => ({ onlyReplyAt: 1, botAlias: ['机器人'] })
    if (change === 'interactive') f.dependencies.loader.priority[0].plugin.getContext = () => ({ pending: true })
    if (change === 'groupDisabled') f.dependencies.cfg.getGroup = () => ({ disable: ['面板'] })
    const result = await f.provider.read({ e, request: { character: '芙宁娜' },
      capability: commandCatalog.find(c => c.id === 'gs.panel.show'), allowed: async () => true })
    assert.notEqual(result.status, 'ready', change)
    assert.equal(f.sentProfile.length, 0)
  }
  const data = new avatar({ weapon: { affix: 3 } })
  assert.equal(profileFacts(data, null).score, null)
})

test('真实词典单字别名边界支持分析；昵称含游戏名不会误判游戏', async () => {
  const s = setup()
  const reader = new CommandEntities({})
  reader.cache = { at: Date.now(), value: new Map([['gs:character', new Map([['琴', '琴'], ['芙宁娜', '芙宁娜']])]]) }
  s.commands.entities = reader
  for (const text of ['我的琴还能怎么提升', '分析琴', '我的琴练度怎么样'])
    assert.equal((await s.analysis.request(event(text), s.cfg)).character, '琴', text)
  s.commands.targets = new PanelTargets({ request: async () => [{ user_id: '40004', card: '星铁玩家' }, { user_id: '50005', card: '原神玩家' }] })
  assert.equal((await s.analysis.request(event('分析星铁玩家的芙宁娜面板'), s.cfg)).targetUserId, '40004')
  assert.equal((await s.analysis.request(event('分析原神玩家的芙宁娜面板'), s.cfg)).targetUserId, '50005')
})

test('原生渲染开始后撤销拦截迟到图片，不重新发送', async () => {
  const f = nativeFixture(), e = event(); let live = true, started, release
  const ready = new Promise(r => { started = r }), gate = new Promise(r => { release = r })
  f.dependencies.loader.priority[0].class = class { async panel(event) { started(); await gate; return event.reply({ type: 'image' }) } }
  const args = { e, request: { character: '芙宁娜' }, capability: commandCatalog.find(c => c.id === 'gs.panel.show'), allowed: async () => live }
  const loaded = await f.provider.read(args)
  const pending = f.provider.render({ ...args, snapshot: loaded.snapshot })
  await ready; live = false; release(); await pending
  assert.deepEqual(e.sent, [])
})

test('读取期间原处理器被替换或权限撤销时丢弃快照', async () => {
  for (const mode of ['replace', 'permission']) {
    const f = nativeFixture(), read = f.provider.readFile
    f.provider.readFile = async file => {
      const data = await read(file)
      if (mode === 'replace') f.dependencies.loader.priority[0].class = class {}
      else f.dependencies.loader.priority[0].plugin.rule[0].permission = 'master'
      return data
    }
    const result = await f.provider.read({ e: event(), request: { character: '芙宁娜' },
      capability: commandCatalog.find(c => c.id === 'gs.panel.show'), allowed: async () => true })
    assert.equal(result.status, 'cancelled'); assert.equal(result.snapshot, undefined)
  }
})

test('更新后时间确有变化才能确认刷新；评分和图片缺失作有限分析', async () => {
  const s = setup({ render: async () => { throw Error('no renderer') } }); let reads = 0, prompt
  s.provider.read = async () => ({ status: 'ready', snapshot: { facts: { ...facts, score: null,
    updatedAt: ++reads === 1 ? facts.updatedAt : new Date().toISOString() } } })
  const e = event('更新面板再分析芙宁娜')
  await run(s, e, { client: { complete: async args => { prompt = args.messages; return { data: { reply: '评分不可用，只根据已有属性分析。' } } } } })
  assert.match(JSON.stringify(prompt), /refreshConfirmed\\":true/)
  assert.match(JSON.stringify(prompt), /score\\":null/)
  assert.match(e.sent.at(-1), /图片没能发出来/)
})

test('运行时同批后到的他人闲聊不替换分析请求者，取消后不再转普通聊天', async () => {
  const s = setup(); let calls = 0
  const runtime = new PaimonRuntime({ config: { load: async () => s.cfg, getPersona: () => '派蒙', getStickers: () => ({}) },
    commandRouter: s.commands, buildAnalysis: s.analysis, client: { complete: async () => { calls++; return { data: { reply: '你的建议。' } } } },
    modelLogger: { write: async () => {} }, knowledgeProvider: async () => ({}), logger: () => {} })
  try {
    const e = event(), other = event('今天挺好的', { user_id: '50005' })
    await runtime.handleEvent(e); await runtime.handleEvent(other); await runtime.buffer.flush('group:30003')
    assert.equal(e.sent.length, 2); assert.deepEqual(other.sent, []); assert.equal(calls, 1)
    const cancelled = event(), stop = event('取消分析')
    await runtime.handleEvent(cancelled); await runtime.handleEvent(stop); await runtime.buffer.flush('group:30003')
    assert.deepEqual(cancelled.sent, []); assert.equal(calls, 1)
    const replaced = event(), nextPanel = event('看刻晴面板')
    await runtime.handleEvent(replaced); await runtime.handleEvent(nextPanel); await runtime.buffer.flush('group:30003')
    assert.equal(calls, 1); assert.deepEqual(replaced.sent, [])
    assert.equal(s.calls.at(-1).capability.id, 'gs.panel.show'); assert.equal(s.calls.at(-1).args.character, '刻晴')
  } finally { await runtime.dispose() }
})

test('模型日志强制省略私人面板请求/回答正文', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-analysis-log-'))
  try {
    const logger = new ModelLogger({ root }), cfg = { logging: { enabled: true, includePrompt: false, includeResponse: false } }
    await logger.write('model_request', { type: 'build_analysis', request: { messages: [{ role: 'user', content: 'PRIVATE_PANEL' }] } }, cfg)
    await logger.write('model_response', { type: 'build_analysis', response: { content: 'PRIVATE_ADVICE', data: { reply: 'PRIVATE_ADVICE' } } }, cfg)
    assert.doesNotMatch(await fs.readFile(path.join(root, 'data/logs/deepseek.jsonl'), 'utf8'), /PRIVATE_/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('运行时无需点名唤醒分析；面板单图不变；分析不进入近期档案或长期记忆正文', async () => {
  const s = setup(), seen = []
  const runtime = new PaimonRuntime({ config: { load: async () => s.cfg, getPersona: () => '派蒙', getStickers: () => ({}) },
    commandRouter: s.commands, buildAnalysis: s.analysis,
    client: { complete: async args => { seen.push(args); return { data: { reply: 'PRIVATE_EQUIPMENT_ADVICE' } } } },
    modelLogger: { write: async () => {} }, knowledgeProvider: async () => ({}), logger: () => {} })
  try {
    const e = event(); assert.equal(await runtime.handleEvent(e), true)
    await runtime.buffer.flush('group:30003')
    assert.equal(e.sent[0].type, 'image'); assert.equal(e.sent[1], 'PRIVATE_EQUIPMENT_ADVICE'); assert.equal(seen.length, 1)
    const batches = runtime.buffer.get('group:30003').sessionBatches
    assert.equal(batches[0].origin, 'command'); assert.doesNotMatch(JSON.stringify(batches), /PRIVATE_EQUIPMENT/)
    const panel = event('看芙宁娜面板'); await runtime.handleEvent(panel); await runtime.buffer.flush('group:30003')
    assert.equal(seen.length, 1); assert.equal(s.calls.at(-1).capability.id, 'gs.panel.show')
  } finally { await runtime.dispose() }
})
