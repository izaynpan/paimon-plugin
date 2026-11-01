import test from 'node:test'
import assert from 'node:assert/strict'
import { profileFacts, equippedSetFacts } from '../lib/miao-profile-provider.js'
import { buildAnalysisMessages } from '../lib/build-analysis-prompt.js'

// Synthetic items only; never reuse a player's complete equipment as a fixture.
test('装备事实明确羽毛与生命杯，按原部位而非遍历次序，评分名称不覆盖装备事实', () => {
  const items = [
    [4, { name: '测试杯', set: '测试套', main: { key: 'hp', value: 39.5 }, attrs: [{ key: 'atk', value: 8 }] }],
    [2, { name: '测试羽', set: '测试套', main: { key: 'atkPlus', value: 200 }, attrs: [] }],
    [1, { name: '测试花', set: '测试套', main: { key: 'hpPlus', value: 3000 }, attrs: [] }],
  ]
  const result = profileFacts({ game: 'gs', artis: { forEach: fn => items.forEach(([pos, item]) => fn(item, pos)) } },
    { artis: { 4: { name: '不能覆盖的评分别名', set: '不能覆盖的评分套装' } } })
  const cup = result.artifacts.find(a => a.position === 4), feather = result.artifacts.find(a => a.position === 2)
  assert.equal(cup.slot, '空之杯（杯子）'); assert.equal(cup.name, '测试杯'); assert.equal(cup.set, '测试套')
  assert.equal(cup.main.name, '生命值百分比（大生命）'); assert.equal(cup.main.unit, 'percent_points'); assert.equal(cup.main.value, 39.5)
  assert.equal(cup.substats[0].name, '攻击力百分比（大攻击）')
  assert.equal(feather.slot, '死之羽（羽毛）'); assert.equal(feather.main.name, '固定攻击力（小攻击）'); assert.equal(feather.main.unit, 'points')
  assert.equal(result.artifacts.find(a => a.position === 1).main.name, '固定生命值（小生命）')
  assert.equal(Object.isFrozen(result.artifacts[0].main), true)
})

test('四件加散件已经满足2/4件数门槛；第五件不增加效果且保留战斗触发条件', () => {
  const metadata = { a: { name: '合成套装', skills: { 2: '测试属性增加。', 4: '生命值变化时提升暴击率，至多三层。' } } }
  const items = Array.from({ length: 4 }, () => ({ set: '合成套装' }))
  const four = equippedSetFacts([...items, { set: '散件套装' }], metadata)
  assert.equal(four[0].equippedPieces, 4); assert.equal(four[0].allPieceRequirementsMet, true)
  assert.deepEqual(four[0].effects.map(e => [e.requiredPieces, e.pieceRequirementMet]), [[2, true], [4, true]])
  assert.match(four[0].effects[1].description, /生命值变化.*三层/)
  assert.equal(four[1].allPieceRequirementsMet, null)
  const five = equippedSetFacts([...items, { set: '合成套装' }], metadata)
  assert.deepEqual(five[0].effects, four[0].effects); assert.equal(five[0].equippedPieces, 5)
})

test('套装按实际门槛区分三件未满和特殊单件；缺资料不猜效果', () => {
  const metadata = { a: { name: '甲', skills: { 2: '二件', 4: '四件' } }, b: { name: '乙', skills: { 1: '<nobr>单件</nobr>' } } }
  for (const pieces of [2, 3]) {
    const sets = equippedSetFacts([...Array.from({ length: pieces }, () => ({ set: '甲' })), { set: '乙' }, { set: '未知' }], metadata)
    assert.equal(sets[0].allPieceRequirementsMet, false)
    assert.deepEqual(sets[0].effects.map(e => e.pieceRequirementMet), [true, false])
    assert.equal(sets[1].allPieceRequirementsMet, true); assert.equal(sets[1].effects[0].description, '单件')
    assert.deepEqual(sets[2].effects, []); assert.equal(sets[2].allPieceRequirementsMet, null)
  }
  for (const skills of ['不能按字符串索引解释门槛', ['不能按数组索引解释门槛'], null]) {
    assert.deepEqual(equippedSetFacts([{ set: '甲' }], { a: { name: '甲', skills } })[0].effects, [])
  }
})

test('铁道使用六部位名称及原生skills资料，位面二件不推断四件效果', () => {
  const result = profileFacts({ game: 'sr', artis: { forEach: fn => {
    for (let pos = 1; pos <= 6; pos++) fn({ name: '测试遗器', set: pos > 4 ? '测试位面套装' : '测试四件套' }, pos)
  } } }, null, { plane: { name: '测试位面套装', skills: { 2: '速度达到指定值时获得额外效果。' } } })
  assert.deepEqual(result.artifacts.map(a => a.slot), ['头部', '手部', '躯干', '脚部', '位面球', '连结绳'])
  assert.equal(result.equippedSets[1].allPieceRequirementsMet, true)
  assert.equal(result.equippedSets[1].effects.length, 1)
  assert.match(result.equippedSets[1].effects[0].description, /速度达到/)
})

test('三游戏分析不向模型提供快照日期，仍保留内部刷新验证和事实核对要求', () => {
  for (const game of ['gs', 'sr', 'zzz']) {
    const facts = { game, character: '测试角色', updatedAt: '2026-01-02T00:00:00.000Z' }
    const messages = buildAnalysisMessages({ facts, refreshed: true, refreshConfirmed: false })
    assert.ok(!JSON.stringify(messages).includes(facts.updatedAt))
    assert.equal(facts.updatedAt, '2026-01-02T00:00:00.000Z')
    assert.match(messages[0].content, /不要输出快照记录时间/)
    assert.match(messages[0].content, /main才是主词条/)
    assert.match(messages[0].content, /达到件数不等于实战触发条件/)
    const dto = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')))
    assert.equal(dto.refreshConfirmed, false); assert.equal(dto.panel.updatedAt, undefined)
  }
})
