import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { buildSnapshot, KnowledgeStore } from '../lib/knowledge/store.js'
import { buildCharacters, parseCharacter } from '../lib/knowledge/characters.js'
import { KnowledgeIndex } from '../lib/knowledge/unified-index.js'
import { LoreIndex } from '../lib/knowledge/search.js'
import { prepareEntities, resolveEntities, characterQuery } from '../lib/knowledge/entities.js'
import { createKnowledgeProvider, normalizeKnowledge } from '../lib/knowledge-provider.js'
import { evaluate } from '../scripts/evaluate-knowledge.js'
import { evaluateCharacters } from '../scripts/evaluate-characters.js'
import { characterQuestions } from './fixtures/character-questions.js'
import { completeWithResearch } from '../lib/research.js'
import { pluginRoot } from '../lib/paths.js'
import { PaimonRuntime } from '../lib/paimon-runtime.js'

let corpus
const prepared = () => corpus ||= buildSnapshot({ characters: true }).then(snapshot => ({ snapshot, index: new KnowledgeIndex(snapshot) }))
const cfg = () => ({ enabled: true, knowledge: { enabled: true, characters: true }, webSearch: { enabled: false }, deepseek: { apiKey: 'fake' }, conversation: {} })
const query = (index, text, options = {}) => index.search({ query: text }, { characters: true, ...options })

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-character-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'knowledge/characters'), { recursive: true })
  await fs.mkdir(path.join(root, 'knowledge/genshinlore-md'))
  for (const file of ['sources.json', 'aliases.json']) await fs.copyFile(path.join(pluginRoot, 'knowledge', file), path.join(root, 'knowledge', file))
  const lore = JSON.parse(await fs.readFile(path.join(root, 'knowledge/sources.json')))
  for (const entry of lore.files) await fs.copyFile(path.join(pluginRoot, 'knowledge/genshinlore-md', entry.file), path.join(root, 'knowledge/genshinlore-md', entry.file))
  const s = (await prepared()).snapshot.characters
  const files = s.manifest.files.filter(r => r.name === '刻晴' || r.name === '钟离')
  const report = JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters/collection-report.json')))
  report.输出资料 = report.输出资料.filter(r => files.some(e => e.file === r.文件 + '.zh-CN.json'))
  report.输出资料数 = files.length
  await fs.writeFile(path.join(root, 'knowledge/characters/collection-report.json'), JSON.stringify(report))
  await fs.writeFile(path.join(root, 'knowledge/character-sources.json'), JSON.stringify({ schemaVersion: 1, files }))
  await fs.writeFile(path.join(root, 'knowledge/entities.json'), JSON.stringify(s.registry))
  for (const entry of files) await fs.copyFile(path.join(pluginRoot, 'knowledge/characters', entry.file), path.join(root, 'knowledge/characters', entry.file))
  return { root, store: new KnowledgeStore({ root }) }
}

test('characters: explicit corpus includes 124 profiles with valid local provenance, no media or duplicated Markdown', async () => {
  const { snapshot } = await prepared(), c = snapshot.characters
  assert.equal(c.sources.length, 124); assert.equal(snapshot.sources.length, 9)
  assert.ok(c.chunks.length > 10000)
  assert.ok(c.chunks.every(d => d.file.endsWith('.json') && d.sourcePath && d.origins.length && /^kb-[a-f0-9]{24}$/.test(d.id)))
  assert.equal(new Set(c.chunks.map(d => d.id)).size, c.chunks.length)
  assert.ok(c.profiles.find(d => d.name === '奇偶·男性').missing.includes('语音台词'))
  assert.ok(!c.sources.some(s => /510137|510136/.test(s.file)))
})

test('characters: male traveler resolves every shared voice without inheriting female-exclusive stories', async () => {
  const { snapshot } = await prepared(), chunks = snapshot.characters.chunks
  const male = chunks.filter(c => c.file === 'traveler-male.zh-CN.json'), female = chunks.filter(c => c.file === 'traveler-female.zh-CN.json')
  assert.equal(new Set(male.filter(c => c.section === '语音台词').map(c => c.parentId)).size, 218)
  const common = male.filter(c => c.sharedWith)
  assert.ok(common.length > 200)
  assert.ok(common.every(m => female.some(f => f.text === m.text && f.section === m.section)))
  const maleStory = male.filter(c => c.headingPath.at(-1) === '角色故事2').map(c => c.text).join('')
  const femaleStory = female.filter(c => c.headingPath.at(-1) === '角色故事2').map(c => c.text).join('')
  assert.notEqual(maleStory, femaleStory)
})

test('characters: every source pointer resolves to the actual collected record or explicit traveler reference', async () => {
  const { snapshot } = await prepared(), files = new Map()
  for (const d of snapshot.characters.chunks) {
    if (!files.has(d.file)) files.set(d.file, JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters', d.file))))
    const record = d.sourcePath.split('/').slice(1).reduce((value, key) => value?.[key], files.get(d.file))
    assert.ok(record, d.file + d.sourcePath)
    if (d.sharedWith) assert.equal(record.条目标识, d.sourceRecordId)
    else assert.ok((record.内容 || record.正文).includes(d.text.replace(/^生日：/, '').replace(new RegExp('^' + (record.项目 || '') + '：'), '').trim()))
  }
})

test('characters: birthday mail separates explicitly dated letters without inventing a publication year', async () => {
  const { index } = await prepared(), hits = query(index, '刻晴2024年的生日邮件').matches
  assert.ok(hits.length)
  assert.ok(hits.every(d => d.mailDate === '2024-11-20' && d.text.includes('家宴')))
  assert.ok(!hits.some(d => /时间：202[035]/.test(d.text)))
})

test('characters: registry distinguishes identity from a shared profile and diagnoses alias conflicts', async () => {
  const { index } = await prepared(), registry = index.registry
  const a = resolveEntities('雷电影的过去', registry).matches[0], b = resolveEntities('雷电将军的过去', registry).matches[0]
  assert.notEqual(a.id, b.id)
  const source = structuredClone(index.snapshot.characters.registry)
  source.entities[0].aliases.push({ name: '测试别名', source: 'fixture' })
  source.entities[1].aliases.push({ name: '测试别名', source: 'fixture' })
  const altered = prepareEntities(source)
  assert.ok(altered.conflicts.some(c => c.name === '测试别名'))
  const result = resolveEntities('测试别名生日', altered)
  assert.equal(result.matches.length, 0); assert.equal(result.ambiguous.length, 1)
})

test('characters: same-pinyin collisions never select the first entity and exact names win', () => {
  const registry = prepareEntities({ schemaVersion: 1, entities: ['钟离', '中离'].map((name, i) => ({ id: 'gs.character.test' + i, name, profiles: [], aliases: [] })) })
  assert.equal(resolveEntities('钟璃生日', registry).ambiguous.length, 1)
  assert.equal(resolveEntities('钟离生日', registry).matches[0].canonical, '钟离')
  assert.equal(resolveEntities('zl生日', registry).matches.length, 0)
})

test('characters: short names respect ordinary-word boundaries and do not trigger from surrounding speech', async () => {
  const { index } = await prepared()
  for (const text of ['空气的生日', '影响角色的故事', '练琴的习惯', '空调怎么用', '荧光的颜色'])
    assert.equal(resolveEntities(text, index.registry).matches.length, 0, text)
  for (const text of ['琴的生日', '魈对钟离的看法', '空的故事', '荧的故事'])
    assert.ok(resolveEntities(text, index.registry).matches.length, text)
})

test('characters: upper-case pinyin and typo follow-ups normalize into the shared lore query', async () => {
  const { index } = await prepared()
  const lower = query(index, 'zhongli的魔神战争历史').matches.map(m => m.id)
  assert.deepEqual(query(index, 'ZHONGLI的魔神战争历史').matches.map(m => m.id), lower)
  const result = index.search({ replyBatchMessages: [{ userId: '1', text: '他的魔神战争历史呢' }], session: { sessionBatches: [{ messages: [{ userId: '1', text: '钟璃喜欢什么食物' }] }] } }, { characters: true })
  assert.ok(result.matches.some(m => m.collection === 'genshin-lore'))
  assert.ok(!result.plan.query.includes('钟璃'))
})

test('characters: long dialogue excerpts retain the explicit preceding speaker', async () => {
  const data = JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters/1058.zh-CN.json')))
  data.语音台词 = [{ 标题: '对话测试', 正文: '●派蒙：' + '派蒙的这一轮发言很长。'.repeat(100) + '\n●旅行者：' + '旅行者的这一轮发言也很长。'.repeat(100) }]
  const chunks = parseCharacter(data, { file: '1058.zh-CN.json', name: '刻晴', entityId: 'test', speakerMode: 'mixed' }).chunks.filter(d => d.section === '语音台词')
  assert.ok(chunks.some(d => d.dialogueStartSpeaker === '派蒙'))
  assert.ok(chunks.some(d => d.dialogueStartSpeaker === '旅行者'))
})

test('characters: same-author follow-ups inherit corrected names but not another member or an ambiguous pair', async () => {
  const { index } = await prepared()
  const args = { replyBatchMessages: [{ userId: '1', text: '她的生日呢' }], session: { sessionBatches: [{ messages: [{ userId: '1', text: '刻情喜欢什么食物' }, { userId: '2', text: '钟离的生日' }] }] } }
  assert.equal(characterQuery(args, index.registry).matches[0].canonical, '刻晴')
  assert.ok(index.search(args, { characters: true }).matches.some(m => m.file === '1058.zh-CN.json' && m.headingPath.at(-1) === '生日'))
  args.session.sessionBatches[0].messages[0].text = '刻晴和钟离的故事'
  assert.equal(index.search(args, { characters: true }).matches.length, 0)
  args.replyBatchMessages[0].text = '换个话题，她呢'
  assert.equal(characterQuery(args, index.registry).context, '')
})

test('characters: directional evaluations preserve speaker, target and duplicate provenance', async () => {
  const { index } = await prepared()
  for (const [q, speaker, subject] of [['达达利亚怎么评价丝柯克', '达达利亚', '丝柯克'], ['丝柯克怎么评价达达利亚', '丝柯克', '达达利亚'], ['关于丝柯克，达达利亚怎么评价', '达达利亚', '丝柯克'], ['丝柯克在达达利亚眼中是怎样的', '达达利亚', '丝柯克']]) {
    const hits = query(index, q).matches.filter(m => m.collection === 'characters')
    assert.ok(hits.length, q)
    assert.ok(hits.every(m => (m.speaker || m.profile) === speaker && (m.subject || m.headingPath.at(-1)).includes(subject)), q)
  }
  const duplicate = query(index, '刻晴怎么评价钟离').matches.find(m => m.sourceRefs?.length > 1)
  assert.ok(duplicate); assert.ok(duplicate.sourceRefs.some(r => r.file === '1058.zh-CN.json'))
})

test('characters: comparison reserves both people and shared global budget counts full evidence blocks', async () => {
  const { index } = await prepared(), r = query(index, '钟离和温迪的生日', { maxContextChars: 2000 })
  assert.ok(r.matches.some(m => m.file === '1290.zh-CN.json'))
  assert.ok(r.matches.some(m => m.file === '57.zh-CN.json'))
  assert.ok(r.matches.map(m => m.block).join('\n\n').length <= 2000)
  const limited = query(index, '钟离的故事', { maxContextChars: 1 })
  assert.equal(limited.matches.length, 0)
  assert.ok(limited.diagnostics.truncationReasons.includes('context_budget'))
})

test('characters: source-scoped questions do not fill remaining slots with unrelated lore', async () => {
  const { index } = await prepared()
  assert.ok(query(index, '刻晴生日').matches.every(m => m.collection === 'characters' && m.headingPath.at(-1) === '生日'))
  const cross = query(index, '温迪为何选择无名少年的模样？').matches
  assert.ok(cross.some(m => m.collection === 'characters'))
  assert.ok(cross.some(m => m.collection === 'genshin-lore'))
  assert.ok(query(index, '旅行者的台词').matches.every(m => m.sharedWith && /共用资料/.test(m.block)))
})

test('characters: old lore-only switch and all existing passing lore cases survive joint retrieval', async () => {
  const { snapshot, index } = await prepared(), legacy = evaluate(new LoreIndex(snapshot))
  const joint = evaluate({ snapshot, search: args => index.search(args, { characters: true }) })
  for (const r of legacy.rows.filter(r => r.pass)) assert.equal(joint.rows.find(j => j.id === r.id).pass, true, r.id + ' ' + r.query)
  assert.deepEqual(query(index, '博士是谁', { characters: false }), new LoreIndex(snapshot).search({ query: '博士是谁' }))
  assert.equal(query(index, '刻晴生日', { lore: false, characters: false }).matches.length, 0)
})

test('characters: 126 curated retrieval questions keep the dev and held-out results separate', async () => {
  const { index } = await prepared(), report = evaluateCharacters(index)
  assert.equal(characterQuestions.length, 126)
  assert.equal(report.splits.holdout.total, 40)
  assert.ok(report.passed / report.total >= .95, JSON.stringify(report.failures))
  assert.ok(report.splits.holdout.passed / report.splits.holdout.total >= .95)
})

test('characters: incomplete collection or an unreviewed deletion cannot publish a new snapshot', async t => {
  const f = await fixture(t), file = path.join(f.root, 'knowledge/characters/collection-report.json')
  const report = JSON.parse(await fs.readFile(file))
  report.失败.push({ 词条编号: 'test' }); await fs.writeFile(file, JSON.stringify(report))
  await assert.rejects(buildCharacters(f.root), /incomplete/)
  report.失败 = []; report.输出资料.pop(); report.输出资料数--
  await fs.writeFile(file, JSON.stringify(report))
  await assert.rejects(buildCharacters(f.root), /differs/)
})

test('characters: invalid filenames and source URLs are rejected and missing optional sections stay explicit', async t => {
  const f = await fixture(t), file = path.join(f.root, 'knowledge/character-sources.json')
  const manifest = JSON.parse(await fs.readFile(file)); manifest.files[0].file = '../secret.json'
  await fs.writeFile(file, JSON.stringify(manifest))
  await assert.rejects(buildCharacters(f.root))
  const data = JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters/1058.zh-CN.json')))
  const entry = { file: '1058.zh-CN.json', name: data.角色, entityId: 'test' }
  data.语音台词 = []; assert.ok(parseCharacter(data, entry).missing.includes('语音台词'))
  data.来源.页面 = 'https://evil.invalid/example'; assert.throws(() => parseCharacter(data, entry), /provenance/)
})

test('characters: mismatched traveler base aborts import and never mutates collected source objects', async () => {
  const { resolveTraveler } = await import('../scripts/traveler-profiles.js')
  const male = JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters/traveler-male.zh-CN.json')))
  const female = JSON.parse(await fs.readFile(path.join(pluginRoot, 'knowledge/characters/traveler-female.zh-CN.json')))
  const before = JSON.stringify(male); resolveTraveler(male, female); assert.equal(JSON.stringify(male), before)
  female.角色故事[0].正文 += 'changed'
  assert.throws(() => resolveTraveler(male, female), /摘要/)
})

test('characters: combined revisions include aliases, old snapshots remain readable, rollback is coherent', async t => {
  const f = await fixture(t), old = await f.store.build(), combined = await f.store.build({ characters: true })
  assert.notEqual(old.revision, combined.revision)
  assert.equal((await f.store.build()).revision, combined.revision, 'normal rebuild retains the active collections')
  const registryFile = path.join(f.root, 'knowledge/entities.json'), registry = JSON.parse(await fs.readFile(registryFile))
  registry.entities.find(e => e.name === '刻晴').aliases.push({ name: '回归测试别称', source: 'fixture' })
  await fs.writeFile(registryFile, JSON.stringify(registry))
  const changed = await f.store.build({ characters: true })
  assert.notEqual(changed.revision, combined.revision)
  assert.ok(query((await f.store.load()).index, '回归测试别称生日').matches.some(m => m.file === '1058.zh-CN.json'))
  await f.store.rollback(combined.revision)
  assert.equal((await f.store.load()).index.snapshot.characters.registry.entities.find(e => e.name === '刻晴').aliases.some(a => a.name === '回归测试别称'), false)
  await f.store.rollback(old.revision)
  const provider = createKnowledgeProvider({ store: f.store })
  await provider.prewarm()
  assert.equal((await provider({ config: cfg(), query: '刻晴生日' })).retrievalReason, 'characters_not_built')
})

test('characters: prewarmed queries pin one version while background refresh keeps old evidence available', async t => {
  const f = await fixture(t), a = await f.store.build({ characters: true }), provider = createKnowledgeProvider({ store: f.store })
  await provider.prewarm()
  const token = {}, args = { config: cfg(), query: '刻晴生日', knowledgeRequest: token }
  const first = await provider(args)
  const file = path.join(f.root, 'knowledge/characters/1058.zh-CN.json'), data = JSON.parse(await fs.readFile(file))
  data.基础档案.find(r => r.项目 === '生日').内容 = '测试更新日期'; await fs.writeFile(file, JSON.stringify(data))
  const b = await f.store.build({ characters: true })
  assert.notEqual(a.revision, b.revision)
  const during = await provider({ ...args, knowledgeRequest: {} })
  assert.equal(during.revision, first.revision)
  await provider.prewarm()
  assert.equal((await provider(args)).revision, first.revision)
  const next = await provider({ ...args, knowledgeRequest: {} })
  assert.equal(next.revision, b.revision); assert.match(next.text, /测试更新日期/)
})

test('characters: normalized source types and diagnostic metadata survive without logging raw queries', async () => {
  const { index } = await prepared()
  const provider = createKnowledgeProvider({ store: { load: async () => ({ index, issue: '' }) } })
  const value = normalizeKnowledge(await provider({ config: cfg(), query: '刻情生日' }))
  assert.equal(value.citations[0].contentKind, 'character_record')
  assert.equal(value.citations[0].collection, 'characters')
  assert.equal(value.diagnostics.entities[0].method, 'pinyin')
  assert.ok(!JSON.stringify(value.diagnostics).includes('刻情'))
  assert.equal(value.status, 'partial'); assert.equal(value.freshness, 'unknown')
})

test('characters: all selected sources are logged while only two are displayed, forged IDs remain rejected', async () => {
  const ids = ['a', 'b', 'c'].map(c => 'kb-' + c.repeat(24)), logs = []
  const citations = ids.map(id => ({ id, title: '角色资料', coverage: '栏目', collection: 'characters', url: 'https://baike.mihoyo.com/ys/obc/content/1058/detail' }))
  const response = await completeWithResearch({ config: cfg(), messages: [{ role: 'system', content: '派蒙' }],
    knowledge: { text: '资料', status: 'partial', revision: 'v1', citations },
    providerArgs: { session: { scene: 'private' }, replyBatchMessages: [{ text: '出处' }] },
    client: { complete: async () => ({ data: { action: 'answer', reply: '答复', sourceIds: [...ids, 'kb-' + 'd'.repeat(24)] } }) },
    signal: new AbortController().signal, allowed: async () => true, log: async (event, data) => logs.push({ event, ...data }) })
  assert.equal(logs.find(r => r.event === 'knowledge_used').sourceIds.length, 3)
  assert.equal(logs.find(r => r.event === 'knowledge_used').rejectedSourceCount, 1)
  assert.equal((response.data.reply.match(/出处：/g) || []).length, 2)
})

test('characters: a collection switch cancels an in-flight research job', () => {
  const config = cfg(), runtime = new PaimonRuntime({ logger: () => {} })
  const job = { controller: new AbortController(), knowledgeEnabled: true, knowledgeProvider: 'genshin-lore',
    knowledgeCollections: 'true:true', webEnabled: false, apiKey: 'fake', session: { scene: 'private' } }
  runtime.researchJobs.add(job); config.knowledge.characters = false
  runtime.revalidateResearch(config)
  assert.equal(job.controller.signal.aborted, true)
})

test('characters: missing optional pinyin dependency does not prevent module import for existing lore-only users', async t => {
  await fs.mkdir(path.join(pluginRoot, 'data/knowledge'), { recursive: true })
  const root = await fs.mkdtemp(path.join(pluginRoot, 'data/knowledge/no-pinyin-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'entities.mjs')
  const code = await fs.readFile(path.join(pluginRoot, 'lib/knowledge/entities.js'), 'utf8')
  await fs.writeFile(file, code.replace("('pinyin-pro')", "('paimon-intentionally-missing-pinyin-for-test')"))
  const module = await import(pathToFileURL(file))
  assert.throws(() => module.prepareEntities({ schemaVersion: 1, entities: [{ id: 'gs.character.test', name: '测试', profiles: [], aliases: [] }] }), /pinyin-pro/)
})

test('characters: a mixed-identity voice page is not automatically attributed to one speaker', async () => {
  const { index } = await prepared()
  assert.equal(query(index, '雷电将军怎么评价八重神子').matches.length, 0)
  assert.ok(query(index, '雷电将军喜欢什么食物').matches.every(d => /多个说话者或身份/.test(d.block)))
})
