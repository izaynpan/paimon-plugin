import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PaimonRuntime } from '../lib/paimon-runtime.js'
import { CommandRouter } from '../lib/command-router.js'
import { commandText } from '../lib/command-catalog.js'
import { coneEvidence } from '../lib/light-cone-atlas.js'

const character = '爻光', name = '当她决定看见'
const sources = [
  { url: 'https://a.example/1', content: '爻光的专属光锥是「当她决定看见」。' },
  { url: 'https://b.example/2', title: '《当她决定看见》是爻光的专武' },
]

async function setup(t, { cvs = true, native = true, web = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-cone-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (file, data) => {
    const dest = path.join(root, 'plugins', file)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, JSON.stringify(data))
  }
  if (cvs) await write('xiaoyao-cvs-plugin/resources/sr/weapon/data.json', [{ name, star: 5, belongRole: [character] }])
  const weaponDir = 'miao-plugin/resources/meta-sr/weapon/'
  const entry = { id: '23054', type: '欢愉', star: 5, name }
  await write(weaponDir + 'data.json', { 23054: entry })
  await write(weaponDir + '欢愉/' + name + '/data.json', { ...entry,
    baseAttr: { hp: 1058.4, atk: 529.2, def: 529.2 },
    skill: { name: '破局', desc: '速度提高<nobr>$1[i]%</nobr>', tables: { 1: [18, 21, 24, 27, 30] } } })
  await write(weaponDir + '欢愉/' + name + '/splash.webp', '')
  const commands = [], queries = [], sent = [], cards = []
  const cfg = { enabled: true, trigger: { nicknames: ['派蒙'], groupNicknameTrigger: true },
    deepseek: { apiKey: 'test' }, commandRouting: { enabled: true }, webSearch: { enabled: web },
    conversation: { debounceMs: 100000, activeWindowMs: 90000 } }
  const bridge = { root, available: async () => true,
    execute: async ({ capability, args, original, allowed, onReply, pluginKeys }) => {
      assert.deepEqual(pluginKeys, ['Atlas', 'xiaoyao-cvs-plugin'])
      assert.ok(await allowed())
      commands.push(commandText(capability, args, true))
      if (!native) return { status: 'no_response', attempts: 0 }
      await original.reply('native-image'); onReply()
      return { status: 'responded', successes: 1, attempts: 1 }
    } }
  const entities = { resolve: async (game, kind, value) => game === 'sr' &&
    (kind === 'character' && value === character || kind === 'weapon' && value === name) ? value : null }
  const router = new CommandRouter({ bridge, entities, getConfig: async () => cfg })
  const runtime = new PaimonRuntime({ config: { load: async () => cfg, getPersona: () => '' },
    commandRouter: router, webSearchService: { lookup: async query => { queries.push(query); return sources } },
    client: { complete: async () => { throw Error('unexpected model request') } }, modelLogger: { write: async () => {} } })
  t.after(() => runtime.dispose())
  let id = 0
  const turn = async (text, user = 'a') => {
    const e = { msg: text, user_id: user, sender: {}, self_id: 'bot', isGroup: true, group_id: 'g',
      message_id: String(++id), reply: async x => { sent.push(x); return true },
      runtime: { render: async (plugin, template, card, opts) => {
        assert.deepEqual([plugin, template, opts.retType], ['paimon-plugin', 'light-cone/index', 'base64'])
        cards.push(card); return 'rendered-image'
      } } }
    assert.ok(await runtime.handleEvent(e))
    await runtime.buffer.flush('group:g')
  }
  return { turn, sent, commands, queries, cards, cfg, router, runtime }
}

test('实际三句话分别调用角色专武、回答名称、按名称调用；同群不同用户不继承', async t => {
  const f = await setup(t)
  await f.turn('派蒙，看下爻光专武的图鉴')
  await f.turn('爻光的专武是啥')
  await f.turn('看看这个专武的图鉴')
  assert.deepEqual(f.commands, ['*爻光专武', '*当她决定看见'])
  assert.deepEqual(f.sent, ['native-image', '爻光的专武叫「当她决定看见」', 'native-image'])
  await f.turn('看看这个专武的图鉴', 'b')
  assert.match(f.sent.at(-1), /哪位角色/)
  assert.deepEqual(f.queries, [])
})

test('原插件均无图：搜索核实角色和光锥、按名称重查、使用喵喵本地立绘和属性出图', async t => {
  const f = await setup(t, { native: false, cvs: false })
  await f.turn('派蒙，看下爻光专武的图鉴')
  assert.deepEqual(f.commands, ['*爻光专武', '*当她决定看见'])
  assert.deepEqual(f.queries, ['崩坏星穹铁道 爻光 专属五星光锥 专武名称'])
  assert.deepEqual(f.sent, ['rendered-image'])
  const card = f.cards[0]
  assert.equal(card.name, name)
  assert.deepEqual(card.stats.map(v => v.value), [1058, 529, 529])
  assert.equal(card.skill, '速度提高18 / 21 / 24 / 27 / 30%')
  assert.match(card.art, /splash.webp$/)
})

test('禁止联网时没有专武关系就说明未确认；推荐、单站重复或矛盾证据无法确认关系', async t => {
  const f = await setup(t, { cvs: false, native: false })
  await f.turn('派蒙，不用联网，看下爻光专武的图鉴')
  assert.deepEqual(f.queries, [])
  assert.deepEqual(f.cards, [])
  assert.match(f.sent[0], /还没核实/)
  assert.equal(coneEvidence(character, [name], [sources[0], sources[0]]).name, null)
  assert.equal(coneEvidence(character, [name], [sources[0], { ...sources[1], title: '爻光可选「当她决定看见」' }]).name, null)
  assert.equal(coneEvidence(character, [name, '另一张'], [...sources, { ...sources[1], title: '爻光的专武是「另一张」' }]).conflict, true)
  assert.equal(coneEvidence(character, [name], [{ ...sources[0], url: 'https://sr.mihoyo.com/news/1' }]).name, name)
})
