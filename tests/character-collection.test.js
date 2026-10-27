import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCharacter, plainText, pageId, toMarkdown, voiceReferences } from '../scripts/collect-character.js'
import { selectCharacters } from '../scripts/collect-characters.js'
import fs from 'node:fs'

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
  raw.data.page.modules.find(m => m.id === '3').name = '角色故事1'
  raw.data.page.template_layout.tab = []
  assert.throws(() => extractCharacter(raw, options), /角色描述分组/)
})

test('角色采集：缺少中文拒绝导入，重复或空文本有明确处理记录', () => {
  for (const mode of ['missing', 'duplicate', 'empty']) {
    const raw = fixture()
    const c = raw.data.page.modules.find(m => m.name === '配音展示').components[0]
    const d = JSON.parse(c.data)
    if (mode === 'missing') d.list.shift()
    if (mode === 'duplicate') d.list[0].table.push({ ...d.list[0].table[0] })
    if (mode === 'empty') d.list[0].table[0].content = ''
    c.data = JSON.stringify(d)
    if (mode === 'missing') assert.throws(() => extractCharacter(raw, options), /中文/)
    else {
      const result = extractCharacter(raw, options)
      assert.equal(result.语音台词.length, 1)
      assert.match(result.采集说明.join(''), mode === 'duplicate' ? /合并重复文本/ : /台词正文为空/)
    }
  }
})

test('批量采集：预告排除、同名不同ID保留、重复ID拒绝', () => {
  const raw = { retcode: 0, data: { list: [{ id: 189, children: [{ id: 25, parent_id: 189,
    list: [{ content_id: 1, title: '甲【预告】' }, { content_id: 2, title: '旅行者' }, { content_id: 3, title: '旅行者' }] }] }] } }
  const r = selectCharacters(raw)
  assert.deepEqual(r.included.map(x => x.词条编号), ['2', '3'])
  assert.deepEqual(r.excluded.map(x => x.词条编号), ['1'])
  raw.data.list[0].children[0].list.push({ content_id: 2, title: '重复' })
  assert.throws(() => selectCharacters(raw), /重复词条/)
})

test('角色采集：未命名旧故事分组及旧关联表保留，缺少说话者不猜测', () => {
  const raw = fixture()
  raw.data.page.template_layout.tab[0].module_group[0].name = ''
  raw.data.page.modules.find(m => m.id === '3').name = '角色故事1'
  raw.data.page.modules.push(rich('11', '角色关联语音', '<table><tr><td>角色</td><td>关于示例…</td></tr><tr><td></td><td>没有署名的原文</td></tr><tr><td></td><td></td></tr></table>'))
  const r = extractCharacter(raw, options)
  assert.equal(r.角色故事.length, 1)
  assert.equal(r.人物关联.他人评价.at(-1).角色, '未标注角色')
  assert.equal(r.人物关联.他人评价.at(-1).正文, '没有署名的原文')
})

test('角色采集：同名不同台词保留两版并区分标题', () => {
  const raw = fixture(), c = raw.data.page.modules.find(m => m.id === '6').components[0]
  const d = JSON.parse(c.data)
  d.list[0].table.push({ name: '关于同伴…', content: '另一版中文' })
  c.data = JSON.stringify(d)
  const r = extractCharacter(raw, options)
  assert.equal(r.语音台词.length, 2)
  assert.equal(r.语音台词[1].原标题, '关于同伴…')
  assert.match(r.语音台词[1].标题, /同名条目2/)
})

test('角色采集：补充语音必须来自本页明确链接，名称和ID均匹配', () => {
  const raw = fixture()
  raw.data.page.modules.push(rich('12', '配音展示', '<span data-entry-id="456" data-entry-name="旅行者语音展示（空）">空</span>'))
  assert.deepEqual(voiceReferences(raw), [{ id: '456', name: '旅行者语音展示（空）' }])
  assert.throws(() => extractCharacter(raw, options), /需补充/)
  const supplement = { response: { retcode: 0, data: { page: { id: '456', name: '旅行者语音展示（空）',
    modules: [module('20', '配音展示', 'role_voice', { list: [{ tab_name: '汉语', table: [{ name: '问候', content: '你好' }] }] })] } } },
    fetchedAt: options.fetchedAt, rawHash: 'snapshot' }
  const r = extractCharacter(raw, { ...options, supplements: [supplement] })
  assert.equal(r.语音台词.at(-1).正文, '你好')
  assert.equal(r.来源.补充语音来源[0].词条编号, '456')
  supplement.response.data.page.name = '另一个页面'
  assert.throws(() => extractCharacter(raw, { ...options, supplements: [supplement] }), /需补充/)
})

test('已采集角色资料：目录全集一致，无预告或媒体地址，台词引用均有效', () => {
  const directory = new URL('../knowledge/characters/', import.meta.url)
  const report = JSON.parse(fs.readFileSync(new URL('collection-report.json', directory)))
  assert.equal(report.失败.length, 0)
  assert.equal(report.成功.length, report.计划采集数)
  assert.equal(report.成功.length + report.排除.length, report.目录总数)
  const ids = report.成功.map(x => x.词条编号)
  assert.equal(new Set(ids).size, ids.length)
  assert.deepEqual(fs.readdirSync(directory).filter(x => /^\d+\.zh-CN\.json$/.test(x)).map(x => x.split('.')[0]).sort(), [...ids].sort())
  for (const row of report.成功) {
    assert.doesNotMatch(row.目录名称, /预告/)
    const d = JSON.parse(fs.readFileSync(new URL(`${row.词条编号}.zh-CN.json`, directory)))
    assert.equal(d.来源.词条编号, row.词条编号)
    assert.equal(d.语音台词.length, row.台词数)
    assert.equal(d.角色故事.length, row.故事数)
    const titles = new Set(d.语音台词.map(v => v.标题))
    assert.equal(titles.size, d.语音台词.length)
    for (const reference of d.人物关联.本人相关评价) assert.ok(titles.has(reference.台词标题))
    const markdown = fs.readFileSync(new URL(`${row.词条编号}.zh-CN.md`, directory), 'utf8')
    assert.equal(markdown, toMarkdown(d))
    assert.doesNotMatch(JSON.stringify(d), /audio_url|avatar_pc|<img\b|https?:[^"\s]*\.(?:mp3|png|gif|jpg)/i)
  }
  for (const row of report.排除) assert.equal(fs.existsSync(new URL(`${row.词条编号}.zh-CN.json`, directory)), false)
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
