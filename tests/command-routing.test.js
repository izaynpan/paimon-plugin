import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { commandCatalog, selectedRows, approvedCapabilities, commandText } from '../lib/command-catalog.js'
import { CommandBridge, commandManifest, commandSynthetic, deriveCommandEvent } from '../lib/command-bridge.js'
import { CommandEntities, validateArguments } from '../lib/command-entities.js'
import { CommandRouter, normalizeCommand } from '../lib/command-router.js'
import { messageFromEvent } from '../lib/trigger.js'
import { PaimonRuntime } from '../lib/paimon-runtime.js'
import { completeWithResearch } from '../lib/research.js'
import { buildMemoryEvaluationMessages } from '../lib/memory-compressor.js'

const rules = JSON.parse(await fs.readFile(new URL('./fixtures/command-rules.json', import.meta.url), 'utf8'))
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
  'zzz:character': { 艾莲: '艾莲' }, 'gs:weapon': { 雾切: '雾切之回光' }, 'gs:artifact': { 黄金剧团: '黄金剧团' },
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
  const c = cap(id), target = commandManifest.targets[c.targets[0]]
  const fnc = target.method
  class Handler { constructor() { this.rule = [] } async [fnc](e) { return handle(e, this) } }
  const entry = { key: target.owner === 'example' ? 'example/卡池信息查询.js' : target.owner,
    name: target.name, class: Handler, plugin: { name: target.name, event: 'message', rule: (rules[c.targets[0]] || []).map(r => ({ reg: new RegExp(r.source, r.flags), fnc })) } }
  const loader = { priority: [entry], checkBlack: () => true, checkDisable: () => true, filtEvent: () => true, ...opts.loader }
  const dependencies = { loader, cfg: { getGroup: () => ({}) }, Runtime: { init: async e => { e.runtime = { e }; e.user = { owner: e.user_id, game: e.game } } } }
  return { bridge: new CommandBridge({ dependencies, verify: async () => true, ...opts }), entry, loader, capability: c }
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
      assert.ok(c.targets.some(t => (rules[t] || []).some(r => new RegExp(r.source, r.flags).test(
        c.prepare === 'wiki' && t.startsWith('miao') ? '#喵喵WIKI' : cmd))), `${c.id}: ${cmd}`)
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

test('活跃群续话、否定解释引用、提到他人、历史和合成事件不能独立调用', async () => {
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

test('处理器无输出/异常/权限拒绝/卸载/不兼容不能冒充成功', async () => {
  for (const [handler, status] of [[async () => undefined, 'no_response'], [async () => { throw Error('api') }, 'failed']]) {
    const { bridge, capability } = fakeBridge('gs.panel.show', handler)
    const result = await bridge.execute({ capability, args: { character: '芙宁娜' }, original: event(), allowed: async () => true })
    assert.equal(result.status, status)
    assert.equal(result.successes, 0)
  }
  const { bridge, entry, loader, capability } = fakeBridge()
  entry.plugin.rule[0].permission = 'master'
  assert.equal(await bridge.available(capability, event()), false)
  delete entry.plugin.rule[0].permission
  assert.equal(await bridge.available(capability, event()), true)
  loader.priority = []
  assert.equal(await bridge.available(capability, event()), false)
  const stale = fakeBridge('gs.panel.show', undefined, { verify: async () => false })
  assert.equal(await stale.bridge.available(stale.capability, event()), false)
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

test('兼容签名检查版本和真实文件哈希；未知版本失败关闭', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-signature-'))
  try {
    await fs.mkdir(path.join(root, '.git'))
    await fs.writeFile(path.join(root, '.git/HEAD'), 'a'.repeat(40))
    const bridge = new CommandBridge({ root })
    assert.equal(await bridge.revisionMatches('.', 'aaaaaaa'), true)
    assert.equal(await bridge.revisionMatches('.', 'bbbbbbb'), false)
    assert.equal(await bridge.compatible(commandManifest.targets['miao-plugin/profile:profileDetail']), false)
    const file = path.join(root, 'example.txt')
    await fs.writeFile(file, 'abc')
    assert.equal(await bridge.hashMatches('example.txt', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), true)
    await fs.writeFile(file, 'changed')
    assert.equal(await bridge.hashMatches('example.txt', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'), false)
  } finally { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true }) }
})
