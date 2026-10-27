import { createHash } from 'node:crypto'

export const travelerSections = ['基础档案', '角色介绍', '角色故事', '语音台词',
  '人物关联.相关角色', '人物关联.本人相关评价', '人物关联.他人评价', '生日邮件', '特殊料理']
export const travelerFiles = { 荧: 'traveler-female', 空: 'traveler-male' }
const elements = ['火', '风', '水', '岩', '草', '雷', '冰']
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sectionRecords = (data, section) => section.split('.').reduce((v, k) => v[k], data)
const setSection = (data, section, value) => {
  const keys = section.split('.'), last = keys.pop()
  keys.reduce((v, k) => v[k] ??= {}, data)[last] = value
}
export const recordId = (section, value) => hash([section, value])
// Only equivalent ellipsis glyphs are folded when combining elemental pages.
export const travelerComparison = value => JSON.stringify(value).replace(/\.{3}|⋯/g, '…')

export function travelerIdentity(data) {
  if (!/^旅行者/.test(data.角色)) return null
  const element = /^旅行者·([火风水岩草雷冰])$/.exec(data.角色.trim())?.[1]
  const name = data.基础档案.find(a => a.项目 === '姓名')?.内容
  const gender = /^旅行者（([荧空])）$/.exec(name)?.[1]
  const refs = data.来源.补充语音来源 ?? []
  if (!element || !gender || refs.length !== 1 || refs[0].名称 !== `旅行者语音展示（${gender}）`)
    throw new Error('旅行者元素、姓名与明确链接的语音页不一致，拒绝合并')
  return { gender, element }
}

export function mergeTravelers(records) {
  const groups = { 荧: [], 空: [] }, seen = new Set()
  for (const data of records) {
    const identity = travelerIdentity(data)
    if (!identity) throw new Error('合并输入包含非旅行者资料')
    const id = data.来源.词条编号
    if (seen.has(id)) throw new Error('旅行者来源词条重复')
    seen.add(id)
    groups[identity.gender].push({ data, ...identity })
  }
  const profiles = []
  for (const gender of ['荧', '空']) {
    const rows = groups[gender].sort((a, b) => elements.indexOf(a.element) - elements.indexOf(b.element))
    if (rows.length !== elements.length || new Set(rows.map(r => r.element)).size !== elements.length)
      throw new Error(`旅行者（${gender}）七元素来源不完整或重复，拒绝发布合并资料`)
    const voiceSources = new Map(rows.flatMap(r => r.data.来源.补充语音来源).map(s => [JSON.stringify(s), s]))
    if (voiceSources.size !== 1) throw new Error('同一性别的旅行者补充语音快照不一致')
    const result = { 格式版本: 2, 角色: gender === '荧' ? '女旅行者（荧）' : '男旅行者（空）',
      语言: '简体中文', 资料模式: gender === '荧' ? '完整资料' : '相对女旅行者的差异',
      来源: { 平台: '米游社观测枢', 元素词条: rows.map(({ data, element }) => {
        const { 补充语音来源, ...source } = data.来源
        return { 元素: element, ...source }
      }), 补充语音来源: [...voiceSources.values()] }, 合并索引: {}, 共用内容: {} }
    for (const section of travelerSections) {
      const unique = new Map()
      for (const { data } of rows) for (const record of sectionRecords(data, section)) {
        const key = travelerComparison(record)
        if (!unique.has(key)) unique.set(key, { record, sources: [] })
        const ids = unique.get(key).sources
        if (!ids.includes(data.来源.词条编号)) ids.push(data.来源.词条编号)
      }
      setSection(result, section, [...unique.values()].map(r => r.record))
      result.合并索引[section] = [...unique.values()].map(r => ({
        条目标识: recordId(section, r.record), 来源词条: r.sources
      }))
    }
    result.采集说明 = [...new Set(rows.flatMap(r => r.data.采集说明)),
      '同一性别各元素的相同条目只存一份；仅将三点省略号与居中省略号视作等价，正文采用火、风、水、岩、草、雷、冰顺序中最先出现的版本。其他正文差异保留独立条目。',
      '合并索引与正文数组逐项对应，记录来源词条；来源元素表示哪些页面收录此文，不表示台词仅适用于该元素。']
    profiles.push(result)
  }
  const [female, male] = profiles
  male.基准资料 = { 文件: `${travelerFiles.荧}.zh-CN.json`, 内容摘要: hash(female) }
  for (const section of travelerSections) {
    const baseIds = new Set(female.合并索引[section].map(r => r.条目标识))
    const own = [], index = [], common = [], order = []
    sectionRecords(male, section).forEach((r, i) => {
      const entry = male.合并索引[section][i]
      order.push(entry.条目标识)
      if (baseIds.has(entry.条目标识)) common.push(entry)
      else { own.push(r); index.push(entry) }
    })
    setSection(male, section, own)
    male.合并索引[section] = index
    male.共用内容[section] = { 条目: common, 完整顺序: order }
  }
  male.采集说明.push('本文件只保存与女旅行者不同的正文；共用内容按条目标识精确引用女旅行者。读取时合并引用与差异，不能把女旅行者独有的条目整体继承给男旅行者。男女标点差异也保留，不据此推断设定差异。')
  resolveTraveler(male, female)
  return profiles
}

export function resolveTraveler(male, female) {
  if (male.基准资料?.内容摘要 !== hash(female)) throw new Error('女旅行者基准摘要不匹配')
  const full = structuredClone(male)
  for (const section of travelerSections) {
    const base = new Map(sectionRecords(female, section).map(r => [recordId(section, r), r]))
    const records = new Map(sectionRecords(male, section).map(r => [recordId(section, r), r]))
    for (const ref of male.共用内容[section].条目) {
      if (!base.has(ref.条目标识) || records.has(ref.条目标识)) throw new Error('旅行者共用引用缺失或重复')
      records.set(ref.条目标识, base.get(ref.条目标识))
    }
    const order = male.共用内容[section].完整顺序
    if (new Set(order).size !== order.length || order.length !== records.size || order.some(id => !records.has(id)))
      throw new Error('旅行者共用引用顺序不完整')
    setSection(full, section, order.map(id => records.get(id)))
  }
  return full
}

export function travelerMarkdown(data) {
  const out = [`# ${data.角色}`, '', `资料模式：${data.资料模式}。各元素版本已合并。`, '']
  if (data.基准资料) out.push('共用资料见[女旅行者（荧）](traveler-female.zh-CN.md)。以下仅列出男旅行者的不同正文；机器读取时须按 JSON 中的共用引用合并，不能直接套用女旅行者全文。', '')
  for (const section of travelerSections) {
    out.push(`## ${section.replace('.', ' · ')}`, '')
    const common = data.共用内容[section]?.条目.length ?? 0
    if (common) out.push(`与女旅行者共用 ${common} 项，详见基准资料。`, '')
    const rows = sectionRecords(data, section)
    if (!rows.length && !common) out.push('来源页面未收录或未识别到。', '')
    rows.forEach((r, i) => {
      const ids = data.合并索引[section][i].来源词条
      const scope = data.来源.元素词条.filter(s => ids.includes(s.词条编号)).map(s => s.元素)
      if (typeof r === 'string') out.push(`- ${r}`, '')
      else if (r.项目) out.push(`- ${r.项目}：${r.内容}`, '')
      else if (r.台词标题) out.push(`- 台词引用：${r.台词标题}`, '')
      else out.push(`### ${r.角色 ? `${r.角色}：` : ''}${r.标题}`, '', r.正文, '')
      if (scope.length !== data.来源.元素词条.length) out.push(`收录此项的元素页面：${scope.join('、')}。`, '')
    })
  }
  out.push('## 来源', '', '以下版本号均为网页版本，非游戏版本。各条来源及原始响应摘要见同名 JSON。', '')
  for (const s of data.来源.元素词条) out.push(`- [${s.元素}元素词条（${s.词条编号}）](${s.页面})：页面版本 ${s.页面版本}；抓取时间 ${s.抓取时间}`)
  for (const s of data.来源.补充语音来源) out.push(`- [${s.名称}](${s.页面})：页面版本 ${s.页面版本}；抓取时间 ${s.抓取时间}`)
  out.push('', '## 采集说明', '', ...data.采集说明.map(s => `- ${s}`), '')
  return out.join('\n')
}
