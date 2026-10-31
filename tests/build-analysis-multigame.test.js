import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { BuildAnalysis, buildAnalysisOptions } from '../lib/build-analysis.js'
import { buildGames } from '../lib/build-games.js'
import { CommandRouter } from '../lib/command-router.js'
import { CommandBridge } from '../lib/command-bridge.js'
import { commandCatalog } from '../lib/command-catalog.js'
import { MiaoProfileProvider, profileFacts } from '../lib/miao-profile-provider.js'
import { ZzzProfileProvider, zzzProfileFacts, zzzStat } from '../lib/zzz-profile-provider.js'
import { completeWithResearch } from '../lib/research.js'
import { PaimonRuntime } from '../lib/paimon-runtime.js'
import { createCommandLoader } from './helpers/command-loader.js'

const cfg = () => ({ enabled: true, buildAnalysis: { enabled: true }, commandRouting: { enabled: true, cooldownMs: 0 },
  trigger: { nicknames: ['派蒙'], privateTrigger: true }, deepseek: { apiKey: 'test' }, webSearch: { enabled: true },
  knowledge: { enabled: true, provider: 'local' }, reply: { minDelayMs: 0, maxDelayMs: 0 },
  conversation: { debounceMs: 100000, activeWindowMs: 90000 } })
let seq = 0
function event(text, extra = {}) {
  const sent = []
  return { user_id: '10001', self_id: '20002', group_id: '30003', isGroup: true, isPrivate: false,
    message_id: String(++seq), sender: { nickname: '请求者', role: 'member' }, post_type: 'message', message_type: 'group',
    msg: text, message: [{ type: 'text', text }], sent, reply: async value => { sent.push(value); return { message_id: 'sent' } }, ...extra }
}
const names = { gs: { 芙宁娜: '芙宁娜', 水神: '芙宁娜', 共用别名: '芙宁娜' },
  sr: { 流萤: '流萤', 共用别名: '流萤', 三月七: '三月七' }, zzz: { 蕾米: '蕾米埃尔', 蕾米埃尔: '蕾米埃尔' } }
const entities = { inText: async (game, _kind, text) => Object.entries(names[game] || {}).filter(([key]) => text.includes(key)),
  resolve: async (game, _kind, text) => names[game]?.[text] }
function setup(provider) {
  const config = cfg(), executions = [], reads = [], renders = []
  const bridge = { available: async () => true, execute: async input => { executions.push(input); return { status: 'responded', attempts: 1, successes: 1 } } }
  const commands = new CommandRouter({ getConfig: async () => config, entities, bridge })
  const profileProvider = provider || {
    read: async args => { reads.push(args); return { status: 'ready', snapshot: { uid: '123456789', facts: {
      game: args.request.game, character: args.request.character, weapon: { name: '公开装备', level: 60 }, score: { total: 200 }, updatedAt: null } } } },
    render: async args => { renders.push(args); if (await args.allowed()) args.onReply(await args.e.reply({ type: 'image' })) },
  }
  const analysis = new BuildAnalysis({ commands, profileProvider, getConfig: async () => config })
  return { analysis, commands, config, reads, renders, executions }
}
async function execute(s, e, options = {}) {
  const request = await s.analysis.request(e, s.config)
  assert.ok(request, e.msg)
  s.analysis.admit(e, request)
  return s.analysis.run({ selection: s.analysis.select([{ userId: e.user_id }], [e]), config: s.config,
    client: { complete: async () => ({ data: { reply: '按当前装备优化。' } }) }, knowledgeProvider: async () => assert.fail('不得读取原神知识库'),
    service: { lookup: async () => [] }, sendText: async (source, text, allowed) => await allowed() && source.reply(text),
    sessionAllowed: async () => true, ...options })
}

test('三游戏角色别名与显式游戏消歧；games和单项权限开关生效', async () => {
  const s = setup()
  for (const [text, game, character] of [['我的流萤还能怎么提升', 'sr', '流萤'], ['我的铁道流萤还能怎么提升', 'sr', '流萤'],
    ['派蒙，分析我的蕾米面板', 'zzz', '蕾米埃尔'], ['分析我的绝区零蕾米', 'zzz', '蕾米埃尔'], ['分析星铁共用别名', 'sr', '流萤']]) {
    const request = await s.analysis.request(event(text), s.config)
    assert.equal(request.game, game, text); assert.equal(request.character, character, text)
  }
  assert.ok((await s.analysis.request(event('我的共用别名怎么提升'), s.config)).hint)
  s.config.buildAnalysis.games = ['gs']
  assert.equal(await s.analysis.request(event('分析我的铁道流萤'), s.config), null)
  s.config.buildAnalysis.games = ['sr', 'zzz']; s.config.commandRouting.disabledRows = ['E02']
  assert.equal(await s.analysis.request(event('我的流萤怎么提升'), s.config), null)
  assert.equal((await s.analysis.request(event('我的蕾米怎么提升'), s.config)).game, 'zzz')
  assert.deepEqual(buildAnalysisOptions({ buildAnalysis: { games: ['gs', 'sr', 'sr', 'zzz', 'bad'] } }).games, ['gs', 'sr', 'zzz'])
})

test('三游戏命令入口、缺面板引导与同用户续话带游戏，不混用更新指令', async () => {
  for (const [name, game] of [['流萤', 'sr'], ['蕾米', 'zzz']]) {
    const s = setup(), e = event(`更新面板再分析${name}`)
    await execute(s, e)
    assert.equal(s.executions[0].capability.id, buildGames[game].refreshId)
    assert.equal(s.reads[0].request.game, game); assert.equal(s.renders[0].capability.id, `${game}.panel.show`)
    assert.equal((await s.analysis.request(event('这套哪里要改'), s.config)).game, game)
    s.analysis.provider.read = async () => ({ status: 'missing' })
    const missing = event(`我的${name}还能怎么提升`); await execute(s, missing)
    assert.ok(missing.sent[0].includes(buildGames[game].updateCommand))
    assert.equal(missing.sent.length, 1)
  }
})

test('铁道/绝区零只检索本游戏公开主题，三轮上限和私人数据隔离保持', async () => {
  for (const [name, game] of [['流萤', 'sr'], ['蕾米', 'zzz']]) {
    const s = setup(), e = event(`我的${name}还能怎么提升`); let model = 0, searches = 0
    await execute(s, e, { client: { complete: async args => {
      model++; const prompt = JSON.stringify(args.messages)
      assert.match(prompt, new RegExp(buildGames[game].name)); assert.doesNotMatch(prompt, /123456789|10001|请求者/)
      assert.equal(args.config.knowledge.enabled, false); assert.equal(args.config.logging.includePrompt, false)
      if (model < 3) assert.ok(prompt.includes(buildGames[game].scope))
      return { data: model < 3 ? { action: 'search', scope: buildGames[game].scope, reason: 'missing',
        query: '私人面板10001攻击4567', missingFacts: ['角色机制'] } : { action: 'answer', reply: '优化当前配置。', sourceIds: ['w1'] } }
    } }, service: { lookup: async query => {
      searches++; assert.ok(query.startsWith(buildGames[game].name + ' ')); assert.doesNotMatch(query, /10001|4567|原神|圣遗物/)
      return [{ url: 'https://example.com/build', title: '本游戏攻略', content: '公开机制', fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 10000 }]
    } } })
    assert.equal(model, 3); assert.equal(searches, 2); assert.equal(e.sent[0].type, 'image')
    assert.match(e.sent.at(-1), /https:\/\/example.com\/build/)
  }
})

test('联网域由程序限定，普通聊天不能借模型scope扩展，分析也拒绝跨游戏scope', async () => {
  for (const [buildGame, scope] of [[undefined, 'star_rail'], ['sr', 'teyvat'], ['zzz', 'star_rail']]) {
    let calls = 0
    await completeWithResearch({ buildGame, config: cfg(), messages: [{ role: 'system', content: '派蒙' }], knowledge: {},
      client: { complete: async () => ({ data: ++calls === 1 ? { action: 'search', scope, reason: 'missing', query: '公开主题', missingFacts: ['机制'] } : { reply: '有限建议' } }) },
      service: { lookup: async () => assert.fail('跨域不能联网') }, providerArgs: { replyBatchMessages: [{ text: '分析' }], session: { scene: 'group' } },
      signal: new AbortController().signal, allowed: async () => true })
    assert.equal(calls, 2)
  }
})

test('铁道/绝区零不联网和单游戏撤销在途任务仍生效', async () => {
  for (const [name, game] of [['流萤', 'sr'], ['蕾米', 'zzz']]) {
    const s = setup(), e = event(`我的${name}还能怎么提升，不用联网`); let calls = 0
    await execute(s, e, { client: { complete: async () => ({ data: ++calls === 1 ? { action: 'search', scope: buildGames[game].scope,
      query: '公开查询', reason: 'missing', missingFacts: ['机制'] } : { reply: '仅依面板分析' } }) }, service: { lookup: async () => assert.fail('禁止联网') } })
    assert.match(e.sent.at(-1), /面板分析/)
    s.config.buildAnalysis.includePanelImage = false
    let started, release
    const ready = new Promise(r => { started = r }), current = event(`我的${name}还能怎么提升`)
    const pending = execute(s, current, { client: { complete: async () => { started(); return new Promise(r => { release = r }) } } })
    await ready; s.config.buildAnalysis.games = ['gs']; s.analysis.revalidate(s.config)
    release({ data: { reply: '已撤销，不能发送' } }); await pending
    assert.deepEqual(current.sent, [])
  }
})

function srFixture() {
  const seen = [], files = [], images = [], char = { id: 8007, game: 'sr', isTrailblazer: true, isRelease: true }
  let marked = 0
  const raw = { id: 8008, level: 80, cons: 6, name: '同谐开拓者', weapon: { name: '公开光锥', level: 80, affix: 5 }, _source: 'homo', _time: 1760000000000 }
  class Avatar {
    constructor(data, game) {
      Object.assign(this, data); this.game = game; this.isProfile = true
      this.attr = { hp: 4500, atk: 2000, speed: 145.2, stance: 210, effPct: 50, effDef: 20, recharge: 119.4 }
      this.base = { hp: 2000, speed: 102 }; this.trees = ['8007101', '8007201']; this.talent = { t: { original: 10, level: 12 }, me: { original: 6, level: 7 } }
      this.artis = { forEach: fn => fn({ name: '遗器', level: 15, star: 5, main: { key: 'hp', value: 43.2 }, attrs: [{ key: 'speed', value: 7.8 }] }, 6) }
    }
    getArtisMark() { marked++; return { _mark: 225.6, markClass: 'ACE', charWeight: { stance: 100, speed: 100 }, artis: { 6: { _mark: 45, pMax: 55, name: '饰品', set: '公开位面套装' } } } }
  }
  class Panel { async panel(e) { images.push(e._profile); return e.reply({ type: 'image' }) } }
  const dependencies = createCommandLoader({ init: async e => { e.runtime = { e } } })
  dependencies.loader.priority = [{ key: 'miao-plugin', class: Panel, plugin: { name: '喵喵面板', event: 'message', rule: [{ reg: /^#星铁.+面板$/, fnc: 'panel' }] } }]
  const bridge = new CommandBridge({ root: path.resolve('fixture'), dependencies, importModule: async file => {
    if (file.endsWith('/Avatar.js')) return { default: Avatar }
    if (file.endsWith('/Character.js')) return { default: { get: (_name, game) => { assert.equal(game, 'sr'); return char } } }
    if (file.endsWith('/Common.js')) return { default: { cfg: () => true } }
    if (file.endsWith('/ProfileCommon.js')) return { getTargetUid: async e => { seen.push(e); return '123456789' } }
    assert.fail(file)
  } })
  const provider = new MiaoProfileProvider({ bridge, readFile: async file => { files.push(file); return JSON.stringify({ avatars: { 8008: raw } }) } })
  const args = { e: event('分析同谐开拓者'), request: { game: 'sr', character: '同谐开拓者', targetUserId: '40004' },
    capability: commandCatalog.find(c => c.id === 'sr.panel.show'), allowed: async () => true }
  return { provider, args, raw, seen, images, files, char, marked: () => marked }
}

test('喵喵铁道独立快照、实际评分调用、六件遗器、额外行迹及同命途性别映射', async () => {
  const f = srFixture(), result = await f.provider.read(f.args)
  assert.equal(result.status, 'ready'); assert.equal(f.marked(), 1)
  assert.match(f.files[0], /PlayerData[\\/]sr[\\/]123456789.json$/)
  assert.equal(f.seen[0].user_id, '10001'); assert.equal(f.seen[0].at, '40004'); assert.equal(f.seen[0].game, 'sr')
  const facts = result.snapshot.facts
  assert.equal(facts.game, 'sr'); assert.equal(facts.score.total, 225.6); assert.equal(facts.artifacts[0].position, 6)
  assert.equal(facts.talents.t.level, 12); assert.equal(facts.talents.me.original, 6); assert.equal(facts.source, 'Mihomo')
  assert.equal(facts.attributes.find(a => a.key === 'speed').unit, 'points')
  assert.equal(facts.attributes.find(a => a.key === 'stance').unit, 'percent_points')
  assert.equal(facts.attributes.find(a => a.key === 'hp').unit, 'points')
  assert.equal(facts.artifacts[0].main.unit, 'percent_points'); assert.equal(facts.artifacts[0].substats[0].value, 7.8)
  f.raw.weapon.affix = 1
  await f.provider.render({ ...f.args, snapshot: result.snapshot })
  assert.equal(f.images[0], result.snapshot.profile); assert.equal(f.images[0].weapon.affix, 5)
  f.char.id = 8005
  assert.equal((await f.provider.read(f.args)).status, 'missing') // Never use Harmony data for Preservation.
  f.char.game = 'gs'
  assert.equal((await f.provider.read(f.args)).status, 'unsupported')
})

test('原神和铁道装备百分比大生命/攻击/防御，与最终面板同名属性分开处理', () => {
  for (const game of ['gs', 'sr']) {
    const facts = profileFacts({ game, attr: { hp: 30000, atk: 2000, def: 800 }, artis: { forEach: fn => fn({
      main: { key: 'hp', value: 46.6 }, attrs: [{ key: 'atk', value: 10.5 }, { key: 'def', value: 20.4 }, { key: 'hpPlus', value: 500 }] }, 4) } }, null)
    assert.equal(facts.attributes[0].unit, 'points'); assert.equal(facts.artifacts[0].main.unit, 'percent_points')
    assert.deepEqual(facts.artifacts[0].substats.map(a => a.unit), ['percent_points', 'percent_points', 'points'])
  }
})

function zzzFixture() {
  let formats = 0, business = 0
  const rendered = [], files = [], identities = [], settings = { query: { others: true } }
  const prop = (property_id, property_name, value) => ({ property_id, property_name, base: value, final: value })
  const raw = { id: 1551, name_mi18n: '蕾米埃尔', level: 60, rank: 2, avatar_profession: 3,
    weapon: { name: '公开音擎', level: 60, star: 3 }, skills: [{ skill_type: 5, level: 6 }],
    properties: [prop(11102, '生命值', '12000'), prop(31203, '异常精通', '300'), prop(31403, '异常掌控', '150'),
      prop(20103, '暴击率', '24.5%'), prop(30501, '能量自动回复', '1.56')],
    equip: [{ equipment_type: 6, name: '驱动盘', equip_suit: { name: '公开套装' }, rarity: 'S', level: 15,
      main_properties: [prop(31402, '异常掌控', '30%')], properties: [prop(31203, '异常精通', '36')] }] }
  class Panel {
    async getUID() { identities.push(this.e.user_id); if (this.e.at) this.e.user_id = this.e.at; return this.e.at ? '23456789' : '12345678' }
    async handleRule() { business++; throw Error('不能重新读取/更新/发铺垫') }
    async render(template, data) { rendered.push({ template, data, sender: this.e.user_id }); return { type: 'image', file: 'native' } }
  }
  const dependencies = createCommandLoader({ init: async e => { e.runtime = { e } } })
  dependencies.loader.priority = [{ key: 'ZZZ-Plugin', class: Panel,
    plugin: { name: '[ZZZ-Plugin]Panel', event: 'message', rule: [{ reg: /^#绝区零.+面板$/, fnc: 'handleRule' }] } }]
  const bridge = new CommandBridge({ root: path.resolve('fixture'), dependencies, importModule: async file => {
    if (file.endsWith('/lib/avatar.js')) return { formatPanelData: input => {
      formats++
      input.weightRule = '原插件动态规则'; input.scoreWeight = { 31203: 1.2 }
      input.equip.forEach(e => { e.score = 48.5; e.comment = 'MAX' }); input.equip_score = 48.5; input.equip_comment = 'C'
      input.get_detail_assets = async () => {}
      return input
    } }
    if (file.endsWith('/lib/convert.js')) return { char: { aliasToId: () => 1551 } }
    if (file.endsWith('/lib/convert/property.js')) return { idToName: () => '异常精通' }
    if (file.endsWith('/lib/settings.js')) return { default: { getConfig: () => settings } }
    assert.fail(file)
  } })
  const provider = new ZzzProfileProvider({ bridge, readFile: async file => { files.push(file); return JSON.stringify([raw]) } })
  const args = { e: event('分析蕾米'), request: { game: 'zzz', character: '蕾米埃尔', targetUserId: '40004' },
    capability: commandCatalog.find(c => c.id === 'zzz.panel.show'), allowed: async () => true }
  return { provider, args, raw, bridge, dependencies, rendered, files, identities, settings, formats: () => formats, business: () => business }
}

test('ZZZ原生格式化评分和模板共享实例，真实请求者权限，快照不重读且无查询铺垫', async () => {
  const f = zzzFixture(), loaded = await f.provider.read(f.args)
  assert.equal(loaded.status, 'ready'); assert.equal(f.formats(), 1); assert.equal(f.business(), 0)
  assert.match(f.files[0], /ZZZ-Plugin[\\/]data[\\/]panel[\\/]23456789.json$/)
  assert.deepEqual(f.identities, ['10001']); assert.deepEqual(f.args.e.sent, [])
  const facts = loaded.snapshot.facts
  assert.equal(facts.score.total, 48.5); assert.equal(facts.score.weights[0].name, '异常精通')
  assert.equal(facts.attributes.find(a => a.name === '暴击率').value, 24.5)
  assert.equal(facts.attributes.find(a => a.name === '能量自动回复').unit, 'per_second')
  assert.equal(facts.attributes.find(a => a.name === '异常精通').unit, 'points')
  assert.equal(facts.artifacts[0].main[0].unit, 'percent_points'); assert.equal(facts.updatedAt, null)
  assert.doesNotMatch(JSON.stringify(facts), /23456789|10001|uid/); assert.ok(Object.isFrozen(facts.artifacts))
  f.raw.weapon.star = 5
  await f.provider.render({ ...f.args, snapshot: loaded.snapshot })
  assert.equal(f.rendered[0].data.charData, loaded.snapshot.profile); assert.equal(f.rendered[0].data.charData.weapon.star, 3)
  assert.equal(f.rendered[0].template, 'panel/card.html'); assert.equal(f.rendered[0].sender, '10001')
  assert.equal(f.formats(), 1); assert.equal(f.files.length, 1); assert.equal(f.args.e.sent.length, 1)
})

test('ZZZ保留query.others与框架权限；拒绝时不偷偷读本人的面板', async () => {
  for (const mode of ['others', 'master', 'mute', 'at', 'disabled', 'context']) {
    const f = zzzFixture()
    if (mode === 'others') f.settings.query.others = false
    if (mode === 'master') f.dependencies.loader.priority[0].plugin.rule[0].permission = 'master'
    if (mode === 'mute') f.args.e.group = { mute_left: 10 }
    if (mode === 'at') f.dependencies.cfg.getGroup = () => ({ onlyReplyAt: 1, botAlias: ['机器人'] })
    if (mode === 'disabled') f.dependencies.cfg.getGroup = () => ({ disable: ['[ZZZ-Plugin]Panel'] })
    if (mode === 'context') f.dependencies.loader.priority[0].plugin.getContext = () => ({ pending: true })
    const loaded = await f.provider.read(f.args)
    assert.notEqual(loaded.status, 'ready', mode); assert.equal(f.files.length, 0)
  }
  const f = zzzFixture(), loaded = await f.provider.read(f.args)
  f.settings.query.others = false
  assert.equal(loaded.snapshot.authorized(), false)
  await f.provider.render({ ...f.args, snapshot: loaded.snapshot })
  assert.deepEqual(f.args.e.sent, [])
})

test('ZZZ无数据、未绑定及评分故障降级，不能假装零分/最新快照', async () => {
  const f = zzzFixture()
  const module = f.bridge.importModule
  f.bridge.importModule = async file => file.endsWith('/lib/avatar.js') ? { formatPanelData: () => { throw Error('score unavailable') } } : module(file)
  const partial = await f.provider.read(f.args)
  assert.equal(partial.status, 'ready'); assert.equal(partial.snapshot.facts.score, null)
  assert.equal(partial.snapshot.facts.updatedAt, null)
  assert.equal((await f.provider.render({ ...f.args, snapshot: partial.snapshot })).status, 'unavailable')
  f.provider.readFile = async () => '[]'
  assert.equal((await f.provider.read(f.args)).status, 'missing')
  f.dependencies.loader.priority[0].class.prototype.getUID = async () => { throw Error('no binding') }
  assert.equal((await f.provider.read(f.args)).status, 'unbound')
  assert.equal(zzzStat({ property_id: 1, final: '1.5abc' }), null)
  assert.equal(zzzStat({ property_id: 1, final: '0.5%' }).value, 0.5)
  assert.equal(zzzProfileFacts({ ...f.raw, equip: [] }, '蕾米埃尔', () => '').score, null)
})

test('ZZZ渲染期间取消或撤销他人查询，禁止迟到图片', async () => {
  for (const mode of ['cancel', 'others']) {
    const f = zzzFixture(), loaded = await f.provider.read(f.args)
    let started, release, live = true
    const ready = new Promise(r => { started = r })
    loaded.snapshot.profile.get_detail_assets = async () => { started(); await new Promise(r => { release = r }) }
    const pending = f.provider.render({ ...f.args, snapshot: loaded.snapshot, allowed: async () => live })
    await ready; if (mode === 'cancel') live = false; else f.settings.query.others = false
    release(); await pending
    assert.deepEqual(f.args.e.sent, [])
    assert.equal(f.rendered.length, 0)
  }
})

test('运行时铁道和绝区零无需点名可串行分析，默认适配器按游戏分开', async () => {
  const s = setup(), seen = []
  const runtime = new PaimonRuntime({ config: { load: async () => s.config, getPersona: () => '派蒙', getStickers: () => ({}) },
    commandRouter: s.commands, buildAnalysis: s.analysis, client: { complete: async args => { seen.push(args.trace.game); return { data: { reply: '针对这套装备的建议' } } } },
    modelLogger: { write: async () => {} }, knowledgeProvider: async () => assert.fail('不应检索原神资料'), logger: () => {} })
  try {
    for (const text of ['我的流萤还能怎么提升', '我的蕾米还能怎么提升']) {
      const e = event(text); assert.equal(await runtime.handleEvent(e), true); await runtime.buffer.flush('group:30003')
      assert.equal(e.sent[0].type, 'image'); assert.equal(e.sent.length, 2)
    }
    assert.deepEqual(seen, ['sr', 'zzz'])
  } finally { await runtime.dispose() }
  const real = new BuildAnalysis({ commands: s.commands, getConfig: async () => s.config })
  assert.ok(real.provider instanceof MiaoProfileProvider); assert.ok(real.zzzProvider instanceof ZzzProfileProvider)
})
