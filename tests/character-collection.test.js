import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCharacter, plainText, pageId, toMarkdown } from '../scripts/collect-character.js'

const module = (id, name, type, data, extra = {}) => ({ id, name,
  components: [{ component_id: type, data: JSON.stringify(data) }], ...extra })
const rich = (id, name, text) => module(id, name, 'collapse_panel', { rich_text: text })
const fixture = () => ({ retcode: 0, data: { page: { id: '123', name: '示例角色', version: '7',
  modules: [module('1', '基础信息', 'role_base_info', { name: '示例角色', star: 5,
    avatar_pc: 'https://example.com/image.png', attr: [{ key: '生日', value: ['一月一日'] }] }),
  rich('2', '角色详细', '<p>介绍</p>'), rich('3', '特殊故事标题', '<p>第一段</p><p>第二段</p>'),
  rich('4', '生日邮件', '<p>主题：示例</p><p>邮件正文</p>'), rich('5', '', '<p></p>'),
  module('6', '配音展示', 'role_voice', { list: [
    { tab_name: '汉语', table: [{ name: '关于同伴…', content: '中文台词', audio_url: 'https://example.com/cn.mp3' }] },
    { tab_name: '英语', table: [{ name: 'About', content: 'English only', audio_url: 'https://example.com/en.mp3' }] }
  ] }), rich('7', '特殊料理', '<p><img src="https://example.com/food.png">名称：点心</p>'),
  rich('8', '关联词条', '<strong>相关角色：</strong><span data-entry-name="同伴">同伴</span><strong>相关活动与任务：</strong><span data-entry-name="不收录任务">任务</span>'),
  module('9', '角色关系网', 'role_relation', { tables: [{ header: ['角色', '关于示例角色…'], row: [['<b>同伴</b>', '<p>评价</p>']] }] }),
  rich('10', '装备推荐', '<p>不收录的攻略</p>')],
  template_layout: { tab: [{ module_group: [{ name: '角色描述', module: ['2', '3', '4', '5'].map(id => ({ id })) }] }] }
} } })
const options = { id: '123', fetchedAt: '2026-10-26T17:00:00.000Z', rawHash: 'example' }

test('角色采集：中文白名单、特殊故事、邮件去重及人物关系来源边界', () => {
  const result = extractCharacter(fixture(), options)
  assert.deepEqual(result.角色故事, [{ 标题: '特殊故事标题', 正文: '第一段\n\n第二段' }])
  assert.equal(result.生日邮件.length, 1)
  assert.deepEqual(result.人物关联.相关角色, ['同伴'])
  assert.deepEqual(result.人物关联.本人相关评价, [{ 台词标题: '关于同伴…' }])
  assert.equal(result.人物关联.他人评价[0].正文, '评价')
  assert.equal(result.语音台词.length, 1)
  for (const output of [JSON.stringify(result), toMarkdown(result)]) {
    assert.doesNotMatch(output, /example\.com|English only|\.mp3|\.png|不收录的攻略|不收录任务/)
    assert.equal(output.split('中文台词').length - 1, 1)
    assert.equal(output.split('邮件正文').length - 1, 1)
  }
})

test('角色采集：富文本清理保留段落、可见链接文本和实体，不保留媒体或脚本', () => {
  assert.equal(plainText('<p>甲&nbsp;&amp;&#x4e59;</p><script>bad()</script><style>bad</style><p><a href="x">丙</a><br>丁<img src="x"></p>'), '甲 &乙\n\n丙\n丁')
})

test('角色采集：接口失败、ID不符和未知故事结构拒绝生成', () => {
  assert.throws(() => extractCharacter({ retcode: -1 }, options), /返回失败/)
  assert.throws(() => extractCharacter(fixture(), { ...options, id: '456' }), /ID 不匹配/)
  const raw = fixture()
  raw.data.page.template_layout.tab = []
  assert.throws(() => extractCharacter(raw, options), /角色描述分组/)
})

test('角色采集：缺少中文、重复标题、空台词拒绝悄悄丢失内容', () => {
  for (const mode of ['missing', 'duplicate', 'empty']) {
    const raw = fixture()
    const c = raw.data.page.modules.find(m => m.name === '配音展示').components[0]
    const d = JSON.parse(c.data)
    if (mode === 'missing') d.list.shift()
    if (mode === 'duplicate') d.list[0].table.push({ ...d.list[0].table[0] })
    if (mode === 'empty') d.list[0].table[0].content = ''
    c.data = JSON.stringify(d)
    assert.throws(() => extractCharacter(raw, options), /中文/)
  }
})

test('角色采集：缺少可选邮件或料理时明确记录缺失，不伪造正文', () => {
  const raw = fixture()
  raw.data.page.modules = raw.data.page.modules.filter(m => !['生日邮件', '特殊料理'].includes(m.name))
  const result = extractCharacter(raw, options)
  assert.deepEqual(result.生日邮件, [])
  assert.deepEqual(result.特殊料理, [])
  assert.match(result.采集说明.at(-1), /生日邮件、特殊料理/)
})

test('角色采集：仅接受观测枢角色页或数字ID', () => {
  assert.equal(pageId('505417'), '505417')
  assert.equal(pageId('https://baike.mihoyo.com/ys/obc/content/505417/detail?visit_device=pc'), '505417')
  assert.throws(() => pageId('https://example.com/ys/obc/content/505417/detail'))
  assert.throws(() => pageId('https://baike.mihoyo.com/ys/obc/channel/map/189/25'))
})
