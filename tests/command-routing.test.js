import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { commandCatalog, selectedRows, approvedCapabilities, commandText } from '../lib/command-catalog.js'
import { CommandBridge, commandSynthetic, deriveCommandEvent } from '../lib/command-bridge.js'
import { createCommandLoader } from './helpers/command-loader.js'
import { CommandEntities, validateArguments } from '../lib/command-entities.js'
import { CommandRouter, normalizeCommand } from '../lib/command-router.js'
import { messageFromEvent } from '../lib/trigger.js'
import { PaimonRuntime } from '../lib/paimon-runtime.js'
import { completeWithResearch } from '../lib/research.js'
import { buildMemoryEvaluationMessages } from '../lib/memory-compressor.js'

const rules = JSON.parse(await fs.readFile(new URL('./fixtures/command-rules.json', import.meta.url), 'utf8'))
const commandManifest = JSON.parse(await fs.readFile(new URL('./fixtures/command-targets.json', import.meta.url), 'utf8'))
const contracts = JSON.parse(await fs.readFile(new URL('./fixtures/command-contracts.json', import.meta.url), 'utf8'))
const cap = id => commandCatalog.find(c => c.id === id)
const cfg = () => ({ enabled: true, commandRouting: { enabled: true, cooldownMs: 0 },
  trigger: { nicknames: ['派蒙'], privateTrigger: true, groupMentionTrigger: true, groupNicknameTrigger: true, ignoreCommandPrefixes: ['#', '*', '%'] },
  deepseek: { apiKey: 'test' }, conversation: { debounceMs: 100000, activeWindowMs: 90000 },
  reply: { split: false, minDelayMs: 0, maxDelayMs: 0 } })
let sequence = 0
function event(text = '派蒙看看芙宁娜面板', extra = {}) {
  const sent = []
  return { self_id: 'bot', user_id: 'a', group_id: 'group', isGroup: true, isPrivate: false,
    post_type: 'message', message_type: 'group', message_id: String(++sequence), sender: { nickname: 'A', role: 'member' },
    message: [{ type: 'text', text }], msg: text, sent, reply: async value => { sent.push(value); return { message_id: 'out' } }, ...extra }
}
const dictionary = {
  'gs:character': { 芙宁娜: '芙宁娜', 水神: '芙宁娜', 刻晴: '刻晴' }, 'sr:character': { 三月七: '三月七' },
  'zzz:character': { 艾莲: '艾莲', 蕾米埃尔: '蕾米埃尔', 蕾米: '蕾米埃尔' }, 'gs:weapon': { 雾切: '雾切之回光' }, 'gs:artifact': { 黄金剧团: '黄金剧团' },
}
const entities = {
  resolve: async (game, kind, text) => dictionary[`${game}:${kind}`]?.[text] || null,
  inText: async (game, kind, text) => Object.entries(dictionary[`${game}:${kind}`] || {}).filter(([alias]) => text.includes(alias)),
  suggest: async (game, kind, text) => Object.entries(dictionary[`${game}:${kind}`] || {}).filter(([alias]) =>
    alias.length === text.length && [...alias].filter((char, i) => char !== text[i]).length === 1),
}
function router(config = cfg(), extra = {}) {
  const calls = []
  const bridge = { available: async () => true, recognizes: async () => false,
    execute: async input => { calls.push(input); return { status: 'responded', attempts: 1, successes: 1 } } }
  const result = new CommandRouter({ getConfig: async () => config, bridge, entities, ...extra })
  return { router: result, calls, config, bridge }
}
function fakeBridge(id = 'gs.panel.show', handle = async e => e.reply('image'), opts = {}) {
  const c = cap(id), target = commandManifest.targets[contracts[c.id].targets[0]]
  const fnc = target.method
  class Handler { constructor() { this.rule = [] } async [fnc](e) { return handle(e, this) } }
  const entry = { key: target.owner === 'example' ? 'example/卡池信息查询.js' : target.owner,
    name: target.name, class: Handler, plugin: { name: target.name, event: 'message', rule: (rules[contracts[c.id].targets[0]] || []).map(r => ({ reg: new RegExp(r.source, r.flags), fnc })) } }
  const dependencies = createCommandLoader({ init: async e => { e.runtime = { e }; e.user = { owner: e.user_id, game: e.game } } })
  const loader = dependencies.loader
  Object.assign(loader, { priority: [entry] }, opts.loader)
  return { bridge: new CommandBridge({ dependencies, ...opts }), entry, loader, capability: c }
}
const decision = (id, key = 'c0', args = {}) => ({ action: 'invoke_command', capabilityId: id, sourceMessageKey: key, args })
async function prepare(r, es, config) { return r.prepare(es.map(e => messageFromEvent(e, e.msg, ['派蒙'])), es, config) }

test('人工结果列精确覆盖；n 项没有进入能力目录；默认关闭', async () => {
  const md = await fs.readFile(new URL('../docs/SERVER_COMMAND_CATALOG_2026-10-18.md', import.meta.url), 'utf8')
  const selected = [...md.matchAll(/^\| ([A-I]\d{2}) \| y[^|]*\|/gm)].map(m => m[1]).sort()
  assert.deepEqual(selectedRows, selected)
  assert.equal(new Set(commandCatalog.map(c => c.id)).size, commandCatalog.length)
  assert.equal(approvedCapabilities({}).length, 0)
  assert.equal(commandCatalog.some(c => /体力|重启|十连|stoken/i.test(c.template)), false)
  assert.equal(approvedCapabilities({ commandRouting: { enabled: true, disabledRows: ['C04'] } }).some(c => c.row === 'C04'), false)
})

test('全部模板及每个枚举选项符合服务器独立提取的目标规则', () => {
  for (const c of commandCatalog) {
    const args = Object.fromEntries(Object.entries(c.slots).map(([key, s]) => [key, s.default ?? (s.entity ? '角色名字' : s.pattern ? '5.1' : s.min)]))
    const variants = [args]
    for (const [key, slot] of Object.entries(c.slots)) for (const value of slot.values || []) variants.push({ ...args, [key]: value })
    for (const a of variants) {
      const cmd = commandText(c, a)
      assert.ok(contracts[c.id].targets.some(t => (rules[t] || []).some(r => new RegExp(r.source, r.flags).test(
        contracts[c.id].prepare === 'wiki' && t.startsWith('miao') ? '#喵喵WIKI' : cmd))), `${c.id}: ${cmd}`)
    }
  }
})

test('参数校验：已知实体和别名、整数、枚举、未知字段与命令注入', async () => {
  assert.deepEqual(await validateArguments(cap('gs.panel.show'), { character: '水神' }, entities), { character: '芙宁娜' })
  for (const args of [{ character: '未知角色' }, { character: '芙宁娜\n#重启' }, { character: '芙宁娜', user_id: 'owner' }, []])
    assert.equal(await validateArguments(cap('gs.panel.show'), args, entities), null)
  assert.equal(await validateArguments(cap('gs.panel.changeCons'), { character: '芙宁娜', constellation: 7 }, entities), null)
  assert.equal(await validateArguments(cap('gs.panel.changeCons'), { character: '芙宁娜', constellation: '6' }, entities), null)
  assert.equal(await validateArguments(cap('gs.news'), { kind: '删除公告' }, entities), null)
  assert.equal(await validateArguments(cap('gs.pool.version'), { version: '5.1;#更新' }, entities), null)
})

test('公开资源索引缺失不启动插件，实体字典可从 JSON/YAML 只读加载', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-entities-'))
  try {
    const dir = path.join(root, 'plugins/ZZZ-Plugin/resources/map')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'PartnerId2Data.json'), JSON.stringify({ 1: { name: '艾莲', full_name: '艾莲·乔' } }))
    const e = new CommandEntities({ root, deps: async () => ({ loader: { priority: [] } }), importModule: () => { throw Error('不应导入') } })
    assert.equal(await e.resolve('zzz', 'character', '艾莲·乔'), '艾莲')
    assert.equal(await e.resolve('gs', 'character', '艾莲'), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('错指令只提醒，保留游戏前缀；全角前缀可识别', async () => {
  for (const [text, expected] of [['＃芙宁娜攻路', '#芙宁娜攻略'], ['%艾莲面版', '%艾莲面板'], ['*三月七行记', '*三月七行迹'], ['#日力', '#日历']]) {
    const { router: r, calls } = router()
    const e = event(text)
    await r.observe(e)
    assert.equal(await r.suggest(e), true, text)
    assert.ok(e.sent[0].includes(expected), e.sent[0])
    assert.equal(calls.length, 0)
  }
  assert.equal(normalizeCommand('%艾莲面版').game, 'zzz')
})

test('已回复后放行、已观察发送失败、重复事件、无观察入口不重复纠错', async () => {
  for (const fail of [false, true]) {
    const { router: r } = router()
    const e = event('#芙宁娜攻路', fail ? { reply: async () => { throw Error('send') } } : {})
    await r.observe(e)
    await e.reply('原插件回复').catch(() => {})
    assert.equal(await r.suggest(e), false)
  }
  const { router: r } = router(), e = event('#芙宁娜攻路')
  assert.equal(await r.suggest(e), false)
  await r.observe(e)
  assert.equal(await r.suggest(e), true)
  assert.equal(await r.suggest(e), false)
})

test('合法命令、面版别名、未知角色、n 项和白名单外不纠错', async () => {
  for (const text of ['#芙宁娜面板', '#完全未知攻路', '#体立', '#重起', '#十连', '#绑定子账号']) {
    const { router: r } = router(), e = event(text)
    await r.observe(e)
    assert.equal(await r.suggest(e), false, text)
  }
  const { bridge } = fakeBridge(), { router: r } = router(cfg(), { bridge })
  const e = event('#芙宁娜面版')
  await r.observe(e)
  assert.equal(await r.suggest(e), false)
  const c = cfg(); c.groupWhitelist = { enabled: true, groups: [] }
  const denied = router(c).router
  await denied.observe(e)
  assert.equal(await denied.suggest(e), false)
})

test('特殊结果列的绑定/凭证/刷新入口仅引导扫码；失效提示保留并附加引导', async () => {
  for (const text of ['#绑定123456789', '*绑定uid', '#ck帮助', '#检查ck状态', '#我的ck', '#删除stoken', '#刷新ck']) {
    const { router: r, calls } = router(), e = event(text)
    await r.observe(e)
    assert.equal(await r.loginGuide(e), true, text)
    assert.match(e.sent[0], /私聊.*#扫码登录/)
    assert.equal(calls.length, 0)
  }
  const { router: r } = router(), e = event('#原石')
  await r.observe(e)
  await e.reply('米游社Cookie已失效，请重新绑定')
  assert.match(e.sent[0], /^米游社Cookie已失效.*\n.*#扫码登录/)
  assert.equal(await r.suggest(e), false)
})

test('源消息与真实请求者绑定，后发言者不替换调用身份', async () => {
  const { router: r, calls, config } = router()
  const a = event(), b = event('随便聊聊', { user_id: 'b' })
  const prepared = await prepare(r, [a, b], config)
  assert.deepEqual(prepared.sources.map(s => s.key), ['c0'])
  await r.invoke(decision('gs.panel.show', 'c0', { character: '芙宁娜' }), prepared, config, async () => true)
  assert.equal(calls[0].original, a)
  assert.equal((await r.invoke(decision('gs.panel.show', 'c1', { character: '芙宁娜' }), prepared, config, async () => true)).status, 'rejected')
})

test('未接纳的续话、否定解释引用、提到他人、历史和合成事件不能独立调用', async () => {
  for (const text of ['看看芙宁娜面板', '派蒙不要查芙宁娜面板', '派蒙面板是什么', '派蒙如果查面板会怎样', '派蒙他说看看芙宁娜面板', '派蒙```看看面板```']) {
    const { router: r, config } = router()
    assert.equal(await prepare(r, [event(text)], config), null, text)
  }
  const { router: r, config } = router(), e = event()
  assert.equal(await r.prepare([{ userId: 'a', text: e.msg, messageId: 'history-id' }], [e], config), null)
  assert.equal(await prepare(r, [event(undefined, { [commandSynthetic]: true })], config), null)
  const at = event(); at.message.push({ type: 'at', qq: 'other' })
  assert.equal(await prepare(r, [at], config), null)
  const multi = await prepare(r, [event(), event('派蒙查原神深渊', { user_id: 'b' })], config)
  assert.equal(multi.sources.length, 0)
  assert.match(multi.prompt, /澄清/)
})

test('游戏歧义保留候选并要求澄清；明确游戏仅提供该游戏；私聊/引用前提受限', async () => {
  const { router: r, config } = router()
  const prepared = await prepare(r, [event('派蒙查面板')], config)
  assert.ok(new Set(prepared.capabilities.map(c => c.game)).size > 1)
  assert.match(prepared.prompt, /不凭人设默认原神/)
  const zzz = await prepare(r, [event('派蒙查绝区零面板')], config)
  assert.ok(zzz.capabilities.every(c => c.game === 'zzz'))
  assert.equal(r.contextAllowed(cap('gs.gacha.export'), event()), false)
  assert.equal(Boolean(r.contextAllowed(cap('gs.picture.original'), event())), false)
  assert.equal(r.contextAllowed(cap('gs.picture.original'), event('', { source: { seq: 1 } })), true)
})

test('单事件去重、冷却、关闭后再开仍取消旧选择、删除 key 和撤白', async () => {
  const { router: r, calls, config } = router(), e = event()
  const p = await prepare(r, [e], config), d = decision('gs.panel.show', 'c0', { character: '芙宁娜' })
  await r.invoke(d, p, config, async () => true)
  assert.equal((await r.invoke(d, p, config, async () => true)).status, 'duplicate')
  assert.equal(calls.length, 1)
  const p2 = await prepare(r, [event()], config)
  config.commandRouting.enabled = false; r.revalidate(config)
  config.commandRouting.enabled = true; r.revalidate(config)
  assert.equal((await r.invoke(d, p2, config, async () => true)).status, 'cancelled')
  const p3 = await prepare(r, [event()], config)
  config.groupWhitelist = { enabled: true, groups: [] }
  assert.equal((await r.invoke(d, p3, config, async () => true)).status, 'cancelled')
  const c = cfg(); c.commandRouting.cooldownMs = 30000
  const rr = router(c)
  for (const expected of ['responded', 'cooldown']) {
    const p = await prepare(rr.router, [event()], c)
    assert.equal((await rr.router.invoke(d, p, c, async () => true)).status, expected)
  }
})

test('派生事件彻底替换文本、隔离 Runtime/目标用户；保留当前 Bot 和引用', () => {
  const original = event('', { runtime: { secret: true }, user: { owner: 'other' }, at: 'victim', source: { seq: 5 } })
  const e = deriveCommandEvent(original, '#星铁三月七面板', 'sr')
  assert.equal(e.user_id, 'a'); assert.equal(e.self_id, 'bot'); assert.equal(e.at, undefined)
  assert.equal(e.runtime, undefined); assert.equal(e.user, undefined)
  assert.equal(e.source, original.source)
  assert.equal(e.isSr, true); assert.equal(e.isGs, false)
  assert.equal(e.message[0].text, e.original_msg)
  e.sender.nickname = 'changed'
  assert.equal(original.sender.nickname, 'A')
})

test('目标处理器由原用户发送原始图片/转发，false 后已回复也不再分发', async () => {
  const image = [{ type: 'image', file: 'fixture.png' }]
  const { bridge, capability } = fakeBridge('gs.panel.show', async e => {
    assert.equal(e.runtime.e, e); assert.equal(e.user.owner, 'a')
    await e.reply(image); return false
  })
  const original = event()
  const result = await bridge.execute({ capability, args: { character: '芙宁娜' }, original, allowed: async () => true })
  assert.equal(result.status, 'responded'); assert.equal(result.successes, 1)
  assert.equal(original.sent[0], image)
})

test('未 await 的原插件渲染仍等待并发送，不把返回 undefined 当结束', async () => {
  const target = fakeBridge('zzz.buddy', async (e, instance) => { instance.renderImg('image') })
  target.entry.class.prototype.renderImg = async function (image) {
    await new Promise(resolve => setTimeout(resolve, 5))
    return this.e.reply(image)
  }
  const original = event('', { isPrivate: true, isGroup: false })
  const result = await target.bridge.execute({ capability: target.capability, args: {}, original, allowed: async () => true })
  assert.equal(result.status, 'responded')
  assert.deepEqual(original.sent, ['image'])
})

test('处理器无输出/异常/权限拒绝/卸载不能冒充成功', async () => {
  for (const [handler, status] of [[async () => undefined, 'no_response'], [async () => { throw Error('api') }, 'failed']]) {
    const { bridge, capability } = fakeBridge('gs.panel.show', handler)
    const result = await bridge.execute({ capability, args: { character: '芙宁娜' }, original: event(), allowed: async () => true })
    assert.equal(result.status, status)
    assert.equal(result.successes, 0)
  }
  const { bridge, entry, loader, capability } = fakeBridge()
  entry.plugin.rule[0].permission = 'master'
  const denied = event()
  const result = await bridge.execute({ capability, args: { character: '芙宁娜' }, original: denied, allowed: async () => true })
  assert.match(denied.sent[0], /暂无权限/)
  assert.equal(result.status, 'responded')
  loader.priority = []
  const missing = event()
  assert.equal((await bridge.execute({ capability, args: { character: '芙宁娜' }, original: missing, allowed: async () => true })).status, 'no_response')
  assert.deepEqual(missing.sent, [])
})

test('超时、撤销和目标热卸载均拦截迟到发送，不自动重试', async () => {
  let release, entered
  const started = new Promise(r => { entered = r })
  const { bridge, capability } = fakeBridge('gs.panel.show', async e => { entered(); await new Promise(r => { release = r }); await e.reply('late') })
  const original = event()
  const running = bridge.execute({ capability: { ...capability, timeoutMs: 10 }, args: { character: '芙宁娜' }, original, allowed: async () => true })
  await started
  assert.equal((await running).status, 'timeout')
  release(); await new Promise(r => setTimeout(r, 5))
  assert.deepEqual(original.sent, [])
  const target = fakeBridge('gs.panel.show', async e => { target.loader.priority = []; await e.reply('unloaded') })
  const e = event()
  await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
  assert.deepEqual(e.sent, [])
})

test('wiki 准备只在目标实例运行，内部指令必须有已解析角色和模式', async () => {
  let accepted = 0
  const target = fakeBridge('gs.character.talent', async e => { assert.equal(e.msg, '#喵喵WIKI'); return e.reply('talent') })
  target.entry.class.prototype.accept = async e => { accepted++; e.msg = '#喵喵WIKI'; e.char = { name: '芙宁娜' }; e.wikiMode = 'talent' }
  target.entry.plugin.accept = target.entry.class.prototype.accept
  const original = event()
  assert.equal((await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original, allowed: async () => true })).status, 'responded')
  assert.equal(accepted, 1); assert.equal(original.msg, '派蒙看看芙宁娜面板')
})

test('完整会话合并：A 调用 B 续话不串号，不发普通聊天/表情/补话，命令批次单独标记', async () => {
  const config = cfg(), calls = []
  const target = fakeBridge('gs.panel.show', async e => { calls.push(e.user_id); await e.reply({ type: 'image', file: 'panel' }) })
  const cr = new CommandRouter({ getConfig: async () => config, bridge: target.bridge, entities })
  let modelCalls = 0
  const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => '派蒙', getStickers: () => ({}) }, commandRouter: cr,
    client: { complete: async ({ messages }) => { modelCalls++; assert.match(messages[0].content, /invoke_command/); return { data: decision('gs.panel.show', 'c0', { character: '芙宁娜' }) } } },
    modelLogger: { write: async () => {} }, knowledgeProvider: async () => ({}), logger: () => {},
    stickerSender: async () => { throw Error('command must not send stickers') } })
  const a = event(), b = event('今天挺好', { user_id: 'b' })
  try {
    await runtime.handleEvent(a); await runtime.handleEvent(b)
    await runtime.buffer.flush('group:group')
    assert.deepEqual(calls, ['a']); assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 0)
    const batch = runtime.buffer.get('group:group').sessionBatches[0]
    assert.equal(batch.origin, 'command'); assert.equal(batch.failed, false)
    assert.equal(modelCalls, 1)
    assert.equal(runtime.followUps.pending.size, 0)
  } finally { await runtime.dispose() }
})

test('搜索首轮可以选择调用，工具资料后的轮次不能调用', async () => {
  const config = cfg(), { router: r } = router(config), e = event()
  const commandContext = await prepare(r, [e], config)
  const base = { config, messages: [{ role: 'system', content: 'system' }], knowledge: {}, commandContext,
    providerArgs: { session: { scene: 'group' }, replyBatchMessages: [{ text: e.msg }] },
    signal: new AbortController().signal, allowed: async () => true }
  const data = decision('gs.panel.show', 'c0', { character: '芙宁娜' })
  assert.equal((await completeWithResearch({ ...base, client: { complete: async () => ({ data }) } })).data.action, 'invoke_command')
  let round = 0
  const answer = await completeWithResearch({ ...base, config: { ...config, knowledge: { enabled: true } },
    provider: async () => ({}), client: { complete: async ({ messages }) => {
      round++
      if (round === 1) return { data: { action: 'lookup_local', query: '公开资料' } }
      assert.doesNotMatch(messages[0].content, /已批准的游戏能力/)
      return { data }
    } } })
  assert.notEqual(answer.data.action, 'invoke_command')
  assert.equal(round, 2)
})

test('缺参只给格式，已知角色单错字给建议，多错字不猜', async () => {
  for (const [text, expected] of [['#命座', '<名称>命座'], ['#芙宁那攻略', '#芙宁娜攻略']]) {
    const { router: r, calls } = router(), e = event(text)
    await r.observe(e)
    assert.equal(await r.suggest(e), true)
    assert.ok(e.sent[0].includes(expected))
    assert.equal(calls.length, 0)
  }
  const { router: r } = router(), e = event('#芙明那攻略')
  await r.observe(e)
  assert.equal(await r.suggest(e), false)
  const target = fakeBridge('gs.guide')
  const actual = router(cfg(), { bridge: target.bridge }).router
  const typo = event('#芙宁那攻略')
  await actual.observe(typo)
  assert.equal(await actual.suggest(typo), true, '宽业务规则命中不等于角色真实存在')
})

test('程序拒绝猜游戏、补造角色和混合游戏，即使模型给出了合法能力 ID', async () => {
  for (const text of ['派蒙看看我的面板', '派蒙看看刻晴面板', '派蒙看看原神和星铁的面板']) {
    const { router: r, config, calls } = router(), e = event(text)
    const p = await prepare(r, [e], config)
    assert.equal((await r.invoke(decision('gs.panel.show', 'c0', { character: '芙宁娜' }), p, config, async () => true)).status, 'rejected')
    assert.equal(calls.length, 0)
  }
})

test('引用图片可调用原图，但引用正文不会替代当前请求；多段失效提示只追加引导', async () => {
  const { router: r, config } = router(), e = event('派蒙看看原神这张原图', { source: { seq: 5 } })
  const p = await prepare(r, [e], config)
  assert.ok(p.capabilities.some(c => c.id === 'gs.picture.original'))
  assert.equal((await r.invoke(decision('gs.picture.original'), p, config, async () => true)).status, 'responded')
  const incoming = event('#原石')
  await r.observe(incoming)
  const image = { type: 'image', file: 'fixture' }
  await incoming.reply([{ type: 'text', text: '米游社Cookie已失效' }, image])
  assert.equal(incoming.sent[0][1], image)
  assert.match(incoming.sent[0][2], /#扫码登录/)
})

test('取消只撤销当前请求者的待调用选择；dispose 后的选择不可复活', async () => {
  const { router: r, config, calls } = router(), e = event()
  const p = await prepare(r, [e], config), d = decision('gs.panel.show', 'c0', { character: '芙宁娜' })
  r.cancel('group:group', 'b')
  assert.equal((await r.invoke(d, p, config, async () => true)).status, 'responded')
  const p2 = await prepare(r, [event()], config)
  r.cancel('group:group', 'a')
  assert.equal((await r.invoke(d, p2, config, async () => true)).status, 'cancelled')
  const p3 = await prepare(r, [event()], config)
  r.dispose()
  assert.equal((await r.invoke(d, p3, config, async () => true)).status, 'cancelled')
  assert.equal(calls.length, 1)
})

test('文件导出发送通道有同样的生命周期检查；不借用其他账号通道', async () => {
  const files = [], original = event('', { isPrivate: true, isGroup: false, group_id: undefined,
    friend: { owner: 'a', sendFile(file) { assert.equal(this.owner, 'a'); files.push(file); return true } } })
  const { bridge, capability } = fakeBridge('gs.gacha.export', async e => e.friend.sendFile('only-this-user.json'))
  const result = await bridge.execute({ capability, args: {}, original, allowed: async () => true })
  assert.equal(result.status, 'responded')
  assert.deepEqual(files, ['only-this-user.json'])
  assert.equal(original.sent.length, 0)
})

test('命令批次及插件结果不进入长期记忆评估', () => {
  const messages = buildMemoryEvaluationMessages({ session: { id: 's', participants: { a: { userId: 'a' } }, sessionBatches: [
    { messages: [{ userId: 'a', text: '我喜欢甜食' }], reply: '记住啦' },
    { origin: 'command', messages: [{ userId: 'a', text: '请查私人战绩' }], reply: '插件回复了战绩' },
  ] }, memories: {}, config: { memory: {} } })
  const text = JSON.stringify(messages)
  assert.match(text, /甜食/)
  assert.doesNotMatch(text, /私人战绩|插件回复了战绩/)
})

test('目录不锁版本；已回退的派蒙星铁更新能力不恢复', async () => {
  const { bridge, capability, loader } = fakeBridge()
  assert.equal(bridge.compatible, undefined)
  assert.equal(bridge.revisionMatches, undefined)
  assert.equal(await bridge.available(capability, event()), true)
  loader.deal = undefined
  assert.equal(await bridge.available(capability, event()), false)
  assert.equal(commandCatalog.some(c => c.id === 'sr.gacha.refresh'), false)
})

test('处理插件/类名/方法改名后，仍由当前标准指令规则接管', async () => {
  const target = fakeBridge()
  let called = 0
  class Updated {
    async newPanel(e) { called++; assert.equal(e.msg, '#芙宁娜面板'); return e.reply('新版结果') }
  }
  Object.assign(target.entry, { key: 'replacement-plugin', name: '新版面板', class: Updated,
    plugin: { name: '新版面板', event: 'message', rule: [{ reg: /^#芙宁娜面板$/, fnc: 'newPanel' }] } })
  target.bridge.importModule = () => { throw Error('不能绕过正常入口导入业务模块') }
  const e = event()
  const result = await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
  assert.equal(result.status, 'responded'); assert.equal(called, 1)
  assert.deepEqual(e.sent, ['新版结果'])
  assert.equal(target.capability.targets, undefined)
})

test('正常 dispatch 运行 accept 和插件自带分发，不直接导入旧 export', async () => {
  const target = fakeBridge('gs.gacha.refresh')
  let accepted = 0
  class Updated {
    async accept(e) { accepted++; e.prepared = true; return false }
    async dispatch(e) { assert.equal(e.prepared, true); return e.reply('原插件冷却提示') }
  }
  target.entry.class = Updated
  target.entry.plugin.accept = Updated.prototype.accept
  target.entry.plugin.rule = [{ reg: /^#更新抽卡记录$/, fnc: 'dispatch' }]
  target.bridge.importModule = () => { throw Error('no business import') }
  const e = event()
  assert.equal((await target.bridge.execute({ capability: target.capability, args: {}, original: e, allowed: async () => true })).status, 'responded')
  assert.equal(accepted, 1); assert.deepEqual(e.sent, ['原插件冷却提示'])
})

test('星铁 accept 看到规范化原指令；处理器内部可复用另一个注册方法', async () => {
  const target = fakeBridge('sr.character.talent')
  class Updated {
    accept(e) {
      e.original_msg ||= e.msg
      assert.equal(e.original_msg, '#星铁三月七行迹')
      e.msg = '#内部资料'
      return true
    }
    async wiki(e) { return this.helper(e) }
    async helper(e) { return e.reply('资料') }
  }
  target.entry.class = Updated
  target.entry.plugin.accept = Updated.prototype.accept
  target.entry.plugin.rule = [{ reg: /^#内部资料$/, fnc: 'wiki' }, { reg: /^#另一个指令$/, fnc: 'helper' }]
  const e = event('派蒙看看三月七行迹')
  assert.equal((await target.bridge.execute({ capability: target.capability, args: { character: '三月七' }, original: e, allowed: async () => true })).status, 'responded')
  assert.deepEqual(e.sent, ['资料'])
})

test('框架只解析一次三游戏前缀，保留发送者；不重复入站统计/冷却/包装回复', async () => {
  for (const [id, args, command, game] of [['gs.panel.show', { character: '芙宁娜' }, '#芙宁娜面板', 'gs'],
    ['sr.panel.show', { character: '三月七' }, '#星铁三月七面板', 'sr'],
    ['zzz.panel.show', { character: '艾莲' }, '#绝区零艾莲面板', 'zzz']]) {
    const target = fakeBridge(id, async e => {
      assert.equal(e.msg, command); assert.equal(e.game, game)
      assert.equal(e.user.owner, 'a'); assert.equal(e.runtime.e, e)
      return e.reply('ok')
    })
    for (const key of ['count', 'checkLimit', 'setLimit', 'reply']) target.loader[key] = () => { throw Error('duplicate ingress') }
    const original = event()
    assert.equal((await target.bridge.execute({ capability: target.capability, args, original, allowed: async () => true })).status, 'responded')
    assert.equal(original.msg, '派蒙看看芙宁娜面板')
    assert.equal(original.runtime, undefined)
  }
})

test('黑名单、群禁用、禁言、只响应@仍生效；管理员以原发送者权限为准', async () => {
  for (const block of ['black', 'disabled', 'mute', 'at', 'permission']) {
    let executions = 0
    const target = fakeBridge('gs.panel.show', async e => { executions++; return e.reply('business') })
    const e = event('', { member: { is_admin: false, is_owner: false } })
    if (block === 'black') target.loader.checkBlack = () => false
    if (block === 'disabled') target.bridge.dependencies.cfg.getGroup = () => ({ disable: [target.entry.name] })
    if (block === 'mute') e.group = { mute_left: 10 }
    if (block === 'at') target.bridge.dependencies.cfg.getGroup = () => ({ onlyReplyAt: 1, botAlias: ['机器人'] })
    if (block === 'permission') target.entry.plugin.rule[0].permission = 'admin'
    await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
    assert.equal(executions, 0, block)
    if (block === 'permission') {
      assert.match(e.sent[0], /管理员/)
      e.member.is_admin = true
      await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
      assert.equal(executions, 1)
    }
  }
})

test('已有交互上下文时不注入指令、不调用上下文或 accept，状态保持原样', async () => {
  const target = fakeBridge('gs.panel.show', async () => { throw Error('must not invoke') })
  const context = { awaitingConfirmation: { text: 'original' } }
  target.entry.plugin.getContext = () => context
  target.entry.plugin.accept = () => {}
  target.entry.class.prototype.accept = () => { throw Error('must not accept') }
  target.entry.class.prototype.awaitingConfirmation = () => { throw Error('must not consume context') }
  const e = event()
  assert.equal((await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })).status, 'context_busy')
  assert.equal(context.awaitingConfirmation.text, 'original')
  assert.deepEqual(e.sent, [])
})

test('当前优先级和 false 放行生效；处理器或 accept 尝试回复后不再执行第二项', async () => {
  for (const mode of ['fallthrough', 'reply', 'accept']) {
    const seen = []
    const first = fakeBridge('gs.panel.show', async e => {
      seen.push('first'); if (mode === 'reply') await e.reply('first'); return false
    })
    const second = fakeBridge('gs.panel.show', async e => { seen.push('second'); return e.reply('second') })
    first.loader.priority.push(second.entry)
    if (mode === 'accept') {
      first.entry.plugin.accept = () => {}
      first.entry.class.prototype.accept = async e => { seen.push('accept'); await e.reply('accept'); return false }
    }
    const e = event()
    await first.bridge.execute({ capability: first.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
    assert.deepEqual(seen, mode === 'fallthrough' ? ['first', 'second'] : [mode === 'reply' ? 'first' : 'accept'])
    assert.equal(e.sent.length, 1)
  }
})

test('派蒙全部入口从合成分发中排除，避免递归或再次纠错', async () => {
  const target = fakeBridge()
  const own = fakeBridge('gs.panel.show', () => { throw Error('must not reenter Paimon') })
  own.entry.key = 'paimon-plugin'; own.entry.plugin.accept = () => {}
  own.entry.class.prototype.accept = () => { throw Error('must not reenter observer') }
  target.loader.priority.unshift(own.entry)
  const e = event()
  assert.equal((await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })).status, 'responded')
  assert.deepEqual(e.sent, ['image'])
})

test('同一处理器并行调用不共享派生事件，不修改 loader/插件实例/原型', async () => {
  const target = fakeBridge('gs.panel.show', async e => { await new Promise(r => setTimeout(r, 5)); return e.reply(e.user.owner) })
  const sentinel = {}, priority = target.loader.priority, Class = target.entry.class
  target.entry.plugin.e = sentinel
  const a = event(), b = event('', { user_id: 'b' })
  const input = { capability: target.capability, args: { character: '芙宁娜' }, allowed: async () => true }
  await Promise.all([target.bridge.execute({ ...input, original: a }), target.bridge.execute({ ...input, original: b })])
  assert.deepEqual(a.sent, ['a']); assert.deepEqual(b.sent, ['b'])
  assert.equal(target.loader.priority, priority)
  assert.equal(target.entry.class, Class); assert.equal(target.entry.plugin.e, sentinel)
})

test('框架初始化期间取消/更换处理类后不执行旧处理器', async () => {
  for (const action of ['cancel', 'replace']) {
    let called = 0, allowed = true
    const target = fakeBridge('gs.panel.show', () => { called++ })
    target.bridge.dependencies.Runtime.init = async () => {
      if (action === 'cancel') allowed = false
      else target.entry.class = class Replacement {}
    }
    const e = event()
    await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => allowed })
    assert.equal(called, 0); assert.deepEqual(e.sent, [])
  }
})

test('运行中替换规则或提升权限后拦截迟到回复', async () => {
  for (const change of ['replaceRule', 'permission']) {
    const target = fakeBridge('gs.panel.show', async e => {
      if (change === 'replaceRule') target.entry.plugin.rule = []
      else target.entry.plugin.rule[0].permission = 'master'
      await e.reply('late')
    })
    const e = event()
    await target.bridge.execute({ capability: target.capability, args: { character: '芙宁娜' }, original: e, allowed: async () => true })
    assert.deepEqual(e.sent, [])
  }
})

test('纠错只依赖批准目录；框架或插件不可用也能给正确名称且不执行', async () => {
  const { router: r, calls } = router(cfg(), { bridge: { available: async () => false, recognizes: async () => { throw Error('offline') } } })
  const e = event('#芙宁娜攻路')
  await r.observe(e)
  assert.equal(await r.suggest(e), true)
  assert.match(e.sent[0], /#芙宁娜攻略/)
  assert.deepEqual(calls, [])
})

test('七圣能力关闭，卡牌和呼唤昵称不参与角色面板的游戏推断', async () => {
  assert.equal(commandCatalog.some(c => c.row === 'B18' || c.id.startsWith('gs.card.')), false)
  const seen = []
  const { router: r, config } = router(cfg(), { entities: { ...entities, inText: async (game, kind, text) => {
    seen.push({ game, kind, text })
    if (kind === 'card') throw Error('must not inspect cards')
    return entities.inText(game, kind, text)
  } } })
  const p = await prepare(r, [event('派蒙，看一下蕾米埃尔面板')], config)
  assert.deepEqual(p.games, ['zzz'])
  assert.ok(p.capabilities.every(c => c.game === 'zzz'))
  assert.ok(seen.every(s => s.kind === 'character' && !s.text.includes('派蒙')))
  for (const text of ['#七圣查询牌组列彪', '#七圣查询角色排']) {
    const e = event(text); await r.observe(e)
    assert.equal(await r.suggest(e), false)
    assert.deepEqual(e.sent, [])
  }
})

test('面板候选提供已核实别名和字符串示例，受限修复错游戏与实体包装', async () => {
  const logs = []
  const { router: r, calls, config } = router(cfg(), { log: async (type, data) => logs.push({ type, data }) })
  const e = event('派蒙帮我看一下蕾米面板')
  const p = await prepare(r, [e], config)
  const payload = JSON.parse(p.prompt.split('\n').find(line => line.startsWith('候选：')).slice(3))
  const panel = payload.find(c => c.id === 'zzz.panel.show')
  assert.deepEqual(panel.parameters.character.namesInCurrentMessage, ['蕾米埃尔'])
  assert.deepEqual(panel.parameters.character.aliasesInCurrentMessage, [{ alias: '蕾米', name: '蕾米埃尔' }])
  assert.deepEqual(panel.example.args, { character: '蕾米埃尔' })
  const data = decision('gs.panel.show', 'c0', { character: { entity: '蕾米' } })
  const result = await r.invoke(data, p, config, async () => true)
  assert.equal(result.command, '%蕾米埃尔面板')
  assert.equal(result.status, 'responded')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].original, e)
  assert.deepEqual(calls[0].args, { character: '蕾米埃尔' })
  assert.deepEqual(logs[0].data.repaired, ['panel_game', 'entity_wrapper'])
  assert.deepEqual(data.args, { character: { entity: '蕾米' } }, 'do not mutate model evidence')
})

test('面板修复仍拒绝额外字段、注入、补造角色、错动作和歧义，记录原因不存正文', async () => {
  const logs = []
  const { router: r, calls, config } = router(cfg(), { log: async (type, data) => logs.push({ type, data }) })
  const p = await prepare(r, [event('派蒙看一下蕾米面板')], config)
  for (const args of [
    { character: { entity: '蕾米', user_id: 'victim' } }, { character: { entity: '蕾米\n#重启' } },
    { character: { entity: '未知名字' } }, { character: { entity: '艾莲' } },
    { character: { entity: '蕾米' }, target: 'victim' },
  ]) assert.equal((await r.invoke(decision('gs.panel.show', 'c0', args), p, config, async () => true)).status, 'rejected')
  for (const id of ['gs.panel.refresh', 'unapproved.panel.show'])
    assert.equal((await r.invoke(decision(id, 'c0', { character: '蕾米' }), p, config, async () => true)).status, 'rejected')
  const ambiguous = await prepare(r, [event('派蒙看看芙宁娜和蕾米的面板')], config)
  assert.equal((await r.invoke(decision('gs.panel.show', 'c0', { character: '芙宁娜' }), ambiguous, config, async () => true)).reason, 'game_ambiguous')
  assert.deepEqual(calls, [])
  assert.ok(logs.every(l => l.type === 'command_rejected' && l.data.reason))
  assert.doesNotMatch(JSON.stringify(logs), /蕾米|未知名字|victim|重启/)
})

test('接纳的明确续问无需点名，仍排除否定、他人、历史及多人归属歧义', async () => {
  const { router: r, config, calls } = router()
  const accepted = es => r.prepare(es.map(e => messageFromEvent(e, e.msg, ['派蒙'])), es, config, { acceptedConversation: true })
  const e = event('看下水神面板吧')
  const p = await accepted([e, event('今天挺好', { user_id: 'b' })])
  assert.equal((await r.invoke(decision('gs.panel.show', 'c0', { character: '水神' }), p, config, async () => true)).command, '#芙宁娜面板')
  assert.equal(calls[0].original, e)
  const concise = await accepted([event('水神攻略')])
  assert.ok(concise.capabilities.some(c => c.id === 'gs.guide'), '续问不要求额外使用看/查等固定动词')
  for (const text of ['不要查芙宁娜面板', '他说看看芙宁娜面板', '如果看芙宁娜面板', '面板是什么'])
    assert.equal(await accepted([event(text)]), null)
  const at = event('看看芙宁娜面板'); at.message.push({ type: 'at', qq: 'other' })
  assert.equal(await accepted([at]), null)
  const message = messageFromEvent(e, e.msg, ['派蒙']); message.origin = 'pre_trigger'
  assert.equal(await r.prepare([message], [e], config, { acceptedConversation: true }), null)
  const multi = await accepted([e, event('看看蕾米面板', { user_id: 'b' })])
  assert.deepEqual(multi.capabilities, [])
})

test('完整会话：首次仍需触发，绝区零缺数据原样提示，未点名续问转交原神面板', async () => {
  const config = cfg(), commands = []
  const zzz = fakeBridge('zzz.panel.show', async e => {
    commands.push(e.msg)
    return e.reply('暂无角色蕾米埃尔面板数据，请先%更新面板')
  })
  const gs = fakeBridge('gs.panel.show', async e => {
    commands.push(e.msg)
    return e.reply({ type: 'image', file: 'panel' })
  })
  zzz.loader.priority.push(gs.entry)
  const cr = new CommandRouter({ getConfig: async () => config, bridge: zzz.bridge, entities })
  let modelCalls = 0
  const runtime = new PaimonRuntime({ config: { load: async () => config, getPersona: () => '派蒙', getStickers: () => ({}) }, commandRouter: cr,
    client: { complete: async () => ({ data: ++modelCalls === 1
      ? decision('gs.panel.show', 'c0', { character: { entity: '蕾米' } })
      : decision('gs.panel.show', 'c0', { character: '水神' }) }) },
    modelLogger: { write: async () => {} }, knowledgeProvider: async () => ({}), logger: () => {} })
  try {
    await runtime.handleEvent(event('看看水神面板'))
    assert.equal(runtime.buffer.get('group:group'), null)
    const first = event('派蒙帮我看一下蕾米面板')
    await runtime.handleEvent(first); await runtime.buffer.flush('group:group')
    assert.deepEqual(first.sent, ['暂无角色蕾米埃尔面板数据，请先%更新面板'])
    const next = event('看下水神面板吧')
    await runtime.handleEvent(next); await runtime.buffer.flush('group:group')
    assert.deepEqual(next.sent, [{ type: 'image', file: 'panel' }])
    assert.deepEqual(commands, ['#绝区零蕾米埃尔面板', '#芙宁娜面板'])
    assert.equal(modelCalls, 2)
  } finally { await runtime.dispose() }
})

test('面板角色库复用喵喵 Meta 与绝区零别名覆盖规则，Atlas 不覆盖源名称或混入卡牌', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-aliases-'))
  const write = async (file, data) => {
    const target = path.join(root, 'plugins', file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, typeof data === 'string' ? data : JSON.stringify(data))
  }
  try {
    await write('ZZZ-Plugin/resources/map/PartnerId2Data.json', { 1: { name: '蕾米埃尔', full_name: '蕾米埃尔·丹' }, 2: { name: '艾莲', full_name: '艾莲·乔' } })
    await write('ZZZ-Plugin/defSet/alias.yaml', { '蕾米埃尔·丹': ['旧称呼', 'Remielle'], 艾莲: ['女仆'] })
    await write('ZZZ-Plugin/config/alias.yaml', { '蕾米埃尔·丹': ['蕾米', 'Remielle', '共用别名'], 艾莲: ['鲨鱼妹', '共用别名'] })
    await write('Atlas/zzz-atlas/path.json', { character: { '蕾米埃尔·丹': 'image', 蕾米: 'image' } })
    await write('Atlas/Genshin-Atlas/path.json', { '七圣角色牌': { 派蒙: 'image' }, 'character card': { 凯亚: 'image' } })
    const names = { 芙宁娜: '芙宁娜', 水神: '芙宁娜', 自定义水神: '芙宁娜', 琴: '琴' }
    let imports = 0
    const reader = new CommandEntities({ root, deps: async () => ({ loader: { priority: [{ key: 'miao-plugin' }] } }),
      importModule: async url => {
        imports++; assert.match(url, /miao-plugin\/components\/Meta.js$/)
        return { default: { create: (game, type) => game === 'gs' && type === 'char'
          ? { data: { 芙宁娜: {}, 琴: {} }, alias: { 水神: '芙宁娜' }, alias2: { 自定义水神: '芙宁娜' }, getData: alias => ({ name: names[alias] }) }
          : { data: {}, getData: () => null } } }
      } }, { yamlParser: JSON.parse })
    for (const alias of ['蕾米埃尔', '蕾米埃尔·丹', '蕾米', 'REMIELLE', '共用别名'])
      assert.equal(await reader.resolve('zzz', 'character', alias), '蕾米埃尔', alias)
    assert.equal(await reader.resolve('zzz', 'character', '旧称呼'), null)
    assert.equal(await reader.resolve('zzz', 'character', '女仆'), null)
    assert.equal(await reader.resolve('zzz', 'character', '鲨鱼妹'), '艾莲')
    assert.equal(await reader.resolve('gs', 'character', '自定义水神'), '芙宁娜')
    assert.deepEqual(await reader.inText('gs', 'character', '看看琴面板'), [['琴', '琴']])
    assert.deepEqual(await reader.inText('gs', 'character', '听人弹琴'), [])
    assert.equal(await reader.resolve('gs', 'character', '派蒙'), null)
    assert.equal(await reader.resolve('gs', 'character', '凯亚'), null)
    assert.equal(await reader.resolve('gs', 'card', '派蒙'), null)
    assert.equal(imports, 1)
    await write('ZZZ-Plugin/config/alias.yaml', { '蕾米埃尔·丹': ['新称呼'] })
    reader.cache.at -= 60001
    assert.equal(await reader.resolve('zzz', 'character', '新称呼'), '蕾米埃尔')
    assert.equal(await reader.resolve('zzz', 'character', 'Remielle'), null)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
