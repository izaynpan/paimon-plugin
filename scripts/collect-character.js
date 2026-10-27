import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const endpoint = 'https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page'
const hash = text => createHash('sha256').update(text).digest('hex')

// Convert the site's rich text to data, never execute embedded HTML.
export function plainText(value) {
  return String(value ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol|blockquote)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, '　')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|nbsp|amp|quot|apos|lt|gt);/gi, (whole, entity) => {
      const key = entity.toLowerCase()
      if (!key.startsWith('#')) return { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[key]
      const n = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1))
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : whole
    })
    .replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function pageId(value) {
  if (/^\d+$/.test(value ?? '')) return value
  const url = new URL(value)
  const match = url.pathname.match(/^\/ys\/obc\/content\/(\d+)\/detail\/?$/)
  if (url.protocol !== 'https:' || url.hostname !== 'baike.mihoyo.com' || !match)
    throw new Error('请输入米游社观测枢角色页链接或数字词条 ID')
  return match[1]
}

export function voiceReferences(response) {
  const refs = new Map()
  for (const m of response?.data?.page?.modules ?? []) {
    if (m.is_hidden || m.name !== '配音展示') continue
    for (const c of m.components ?? []) {
      if (c.component_id !== 'collapse_panel') continue
      for (const match of (JSON.parse(c.data).rich_text ?? '').matchAll(/<span\b[^>]*data-entry-id="(\d+)"[^>]*data-entry-name="([^"]+)"/g)) {
        if (/^旅行者语音展示（[空荧]）$/.test(match[2])) refs.set(match[1], { id: match[1], name: match[2] })
      }
    }
  }
  return [...refs.values()]
}

export function extractCharacter(response, { id, fetchedAt, rawHash, supplements = [] }) {
  const page = response?.data?.page
  if (response?.retcode !== 0 || String(page?.id) !== id || !Array.isArray(page?.modules))
    throw new Error('公开接口返回失败、词条 ID 不匹配或缺少模块；未生成资料')
  const modules = page.modules.filter(m => !m.is_hidden)
  const components = m => (m.components ?? []).map(c => ({ type: c.component_id, data: JSON.parse(c.data) }))
  const named = name => modules.filter(m => m.name === name)
  const notes = []
  const uniqueSections = items => {
    const seen = new Set(), titles = new Map()
    return items.filter(item => {
      const key = JSON.stringify(item)
      if (seen.has(key)) { notes.push(`合并重复文本：${item.标题}。`); return false }
      seen.add(key)
      const count = (titles.get(item.标题) ?? 0) + 1
      titles.set(item.标题, count)
      if (count > 1) {
        notes.push(`同名不同正文均保留：${item.标题}。`)
        item.原标题 = item.标题
        item.标题 += `（同名条目${count}）`
      }
      return true
    })
  }
  const rich = m => {
    const cs = components(m)
    if (cs.some(c => c.type !== 'collapse_panel')) throw new Error(`栏目结构变更，需人工检查：${m.name}`)
    return cs.map(c => plainText(c.data.rich_text)).filter(Boolean).join('\n\n')
  }
  const textSections = name => uniqueSections(named(name).map(m => ({ 标题: m.name, 正文: rich(m) })).filter(x => x.正文))
  const base = modules.flatMap(components).filter(c => c.type === 'role_base_info')
  if (base.length !== 1) throw new Error('基础信息模块缺失/重复，需人工检查')
  const voiceModules = [...modules]
  for (const ref of voiceReferences(response)) {
    const source = supplements.find(s => String(s.response?.data?.page?.id) === ref.id)
    if (!source || source.response.retcode !== 0 || source.response.data.page.name !== ref.name)
      throw new Error(`需补充本页明确链接的中文语音页：${ref.id} ${ref.name}`)
    voiceModules.push(...source.response.data.page.modules.filter(m => !m.is_hidden))
  }
  const voice = voiceModules.flatMap(components).filter(c => c.type === 'role_voice')
  const voiceLines = []
  for (const c of voice) {
    const cn = c.data.list.filter(v => ['汉语', '中文', '简体中文'].includes(v.tab_name))
    if (!cn.length && c.data.list.some(v => v.table?.some(a => plainText(a.content))))
      throw new Error('配音列表含正文但缺少中文标签，需检查语言')
    for (const tab of cn) for (const v of tab.table ?? []) {
      const item = { 标题: plainText(v.name), 正文: plainText(v.content) }
      if (!item.标题 && !item.正文) continue
      if (!item.标题) item.标题 = `未命名台词（条目${voiceLines.length + 1}）`
      if (!item.正文) notes.push(`源页面台词正文为空：${item.标题}。`)
      voiceLines.push(item)
    }
  }
  const lines = uniqueSections(voiceLines)
  const groups = (page.template_layout?.tab ?? []).flatMap(t => t.module_group ?? [])
  let descriptionGroups = groups.filter(g => g.name === '角色描述')
  if (!descriptionGroups.length) {
    const anchors = new Set(modules.filter(m => /^角色故事\s*\d/.test(m.name)).map(m => String(m.id)))
    descriptionGroups = groups.filter(g => g.module?.some(m => anchors.has(String(m.id))))
    if (anchors.size && descriptionGroups.length !== 1) throw new Error('未找到唯一的角色描述分组，不能安全识别特殊故事')
  }
  if (descriptionGroups.length > 1) throw new Error('角色描述分组不唯一')
  const storyIds = new Set((descriptionGroups[0]?.module ?? []).map(m => String(m.id)))
  const stories = uniqueSections(modules.filter(m => storyIds.has(String(m.id)) && !['更多描述', '角色详细', '生日邮件', '特殊料理', '角色CV'].includes(m.name))
    .map(m => ({ 标题: plainText(m.name) || `未命名故事（栏目${m.id}）`, 正文: rich(m) })).filter(s => s.正文))
  const related = []
  for (const m of named('关联词条')) {
    for (const c of components(m)) {
      const html = c.data.rich_text ?? ''
      const start = html.search(/<strong[^>]*>\s*相关角色[：:]/i)
      if (start < 0) continue
      const tail = html.slice(start)
      const next = tail.indexOf('<strong', 7)
      const section = next < 0 ? tail : tail.slice(0, next)
      for (const match of section.matchAll(/data-entry-name="([^"]*)"/g)) {
        const name = plainText(match[1])
        if (name && !related.includes(name)) related.push(name)
      }
    }
  }
  const others = []
  const addRelation = (header, row) => {
    if (row.length !== 2) throw new Error('角色关联语音列数变更')
    let speaker = plainText(row[0])
    const content = plainText(row[1])
    if (!speaker && !content) return
    if (!speaker) { speaker = '未标注角色'; notes.push('源页面有未标注说话者的关联语音，保留正文，不推断归属。') }
    if (!content) notes.push(`源页面关联语音正文为空：${speaker}。`)
    if (!others.some(x => x.角色 === speaker && x.正文 === content))
      others.push({ 角色: speaker, 标题: plainText(header), 正文: content })
  }
  for (const m of named('角色关系网')) {
    for (const c of components(m)) {
      if (c.type !== 'role_relation') throw new Error('角色关系网结构变更')
      for (const table of c.data.tables ?? []) {
        if (table.header?.length !== 2 || plainText(table.header[0]) !== '角色')
          throw new Error('角色关系网表头变更')
        for (const row of table.row ?? []) {
          addRelation(table.header[1], row)
        }
      }
    }
  }
  for (const m of named('角色关联语音')) for (const c of components(m)) {
    if (c.type !== 'collapse_panel') throw new Error('旧版角色关联语音结构变更')
    const html = c.data.rich_text ?? ''
    if (!plainText(html)) continue
    const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(r => [...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => x[1]))
    if (!rows.length || rows[0].length !== 2 || plainText(rows[0][0]) !== '角色')
      throw new Error('旧版角色关联语音表头变更')
    for (const row of rows.slice(1)) addRelation(rows[0][1], row)
  }
  const info = base[0].data
  const result = {
    格式版本: 1,
    角色: plainText(page.name),
    语言: '简体中文',
    来源: { 平台: '米游社观测枢', 词条编号: id, 页面: `https://baike.mihoyo.com/ys/obc/content/${id}/detail`,
      页面版本: String(page.version ?? ''), 抓取时间: fetchedAt, 原始响应摘要: rawHash },
    基础档案: [{ 项目: '姓名', 内容: plainText(info.name) }, { 项目: '星级', 内容: `${info.star}星` },
      ...(info.attr ?? []).map(a => ({ 项目: plainText(a.key), 内容: (a.value ?? []).map(plainText).join('、') }))],
    角色介绍: [...textSections('更多描述'), ...textSections('角色详细'), ...textSections('奇偶备注')],
    角色故事: stories,
    语音台词: lines,
    人物关联: { 相关角色: related, 本人相关评价: lines.filter(v => /^关于/.test(v.标题)
      && !/^关于(?:我们|自己)/.test(v.标题) && !v.标题.startsWith(`关于${page.name}自己`))
      .map(v => ({ 台词标题: v.标题 })), 他人评价: others },
    生日邮件: textSections('生日邮件'),
    特殊料理: textSections('特殊料理')
  }
  if (supplements.length) result.来源.补充语音来源 = supplements.map(s => ({
    词条编号: String(s.response.data.page.id), 名称: s.response.data.page.name,
    页面: `https://baike.mihoyo.com/ys/obc/content/${s.response.data.page.id}/detail`,
    页面版本: String(s.response.data.page.version ?? ''), 抓取时间: s.fetchedAt, 原始响应摘要: s.rawHash
  }))
  // The allowlist above intentionally omits audio, images, actors, combat data and recommendations.
  result.采集说明 = [
    '正文按来源保留，不自动改写或补全；页面版本不等同游戏版本，抓取不等同事实核验。',
    '语音仅保留一份中文文本；本人相关评价通过台词标题引用，不重复存储正文。',
    '人物关联只收录本页明确展示的条目和评价，不据此推断关系；本人相关评价也可能涉及概念。',
    '生日邮件和特殊料理仅收录本页已有内容，不追抓外链。'
  ]
  if (supplements.length) notes.push('旅行者语音来自本页明确链接的独立语音页；未按元素拆分该页共有台词。')
  const absent = ['角色介绍', '角色故事', '语音台词', '生日邮件', '特殊料理'].filter(k => !result[k].length)
  if (absent.length) result.采集说明.push(`本页未收录或未识别到：${absent.join('、')}。`)
  result.采集说明.push(...new Set(notes))
  return result
}

export function toMarkdown(data) {
  const out = [`# ${data.角色}`, '', `来源：[米游社观测枢](${data.来源.页面})`, '',
    `词条编号：${data.来源.词条编号}　页面版本：${data.来源.页面版本}`, '',
    `抓取时间：${new Date(data.来源.抓取时间).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`, '',
    '## 基础档案', '', ...data.基础档案.map(a => `- ${a.项目}：${a.内容}`), '']
  if (data.来源.补充语音来源?.length) out.splice(8, 0,
    ...data.来源.补充语音来源.flatMap(s => [`补充语音来源：[${s.名称}](${s.页面})`, '']))
  const sections = (heading, list) => {
    out.push(`## ${heading}`, '')
    if (!list.length) out.push('本页未收录或未识别到。', '')
    for (const item of list) out.push(`### ${item.标题}`, '', item.正文, '')
  }
  sections('角色介绍', data.角色介绍)
  sections('角色故事', data.角色故事)
  sections('语音台词', data.语音台词)
  out.push('## 人物关联', '', '### 本页关联角色', '', data.人物关联.相关角色.join('、') || '本页未收录或未识别到。', '',
    '### 本人相关评价', '', '以下正文见“语音台词”中的同名条目：', '',
    ...data.人物关联.本人相关评价.map(v => `- ${v.台词标题}`), '', '### 他人评价', '')
  for (const item of data.人物关联.他人评价) out.push(`#### ${item.角色}：${item.标题}`, '', item.正文, '')
  sections('生日邮件', data.生日邮件)
  sections('特殊料理', data.特殊料理)
  out.push('## 采集说明', '', ...data.采集说明.map(s => `- ${s}`), '')
  return out.join('\n')
}

export async function main(args = process.argv.slice(2)) {
  const [input, ...flags] = args
  if (!input) throw new Error('用法：node scripts/collect-character.js <角色链接或ID> [--input 原始JSON] [--out 输出目录]')
  const options = {}
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--input', '--out'].includes(flags[i]) || !flags[i + 1] || options[flags[i]]) throw new Error('参数无效或重复')
    options[flags[i]] = flags[i + 1]
  }
  const id = pageId(input)
  let raw, fetchedAt
  if (options['--input']) {
    raw = await fs.readFile(options['--input'], 'utf8')
    fetchedAt = (await fs.stat(options['--input'])).mtime.toISOString()
  } else {
    const url = new URL(endpoint)
    url.search = new URLSearchParams({ entry_page_id: id, lang: 'zh-cn' }).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`公开接口 HTTP ${response.status}`)
    raw = await response.text()
    fetchedAt = new Date().toISOString()
  }
  const response = JSON.parse(raw)
  const supplements = []
  for (const ref of voiceReferences(response)) {
    if (options['--input']) throw new Error('该页需要独立语音快照，请改用 collect-characters.js --offline（需先完成在线批次）')
    const r = await fetch(`${endpoint}?entry_page_id=${ref.id}&lang=zh-cn`, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`补充语音页 HTTP ${r.status}`)
    const body = await r.text()
    supplements.push({ response: JSON.parse(body), fetchedAt: new Date().toISOString(), rawHash: hash(body) })
  }
  const data = extractCharacter(response, { id, fetchedAt, rawHash: hash(raw), supplements })
  const output = path.resolve(options['--out'] ?? path.join(root, 'knowledge/characters'))
  await fs.mkdir(output, { recursive: true })
  const base = path.join(output, `${id}.zh-CN`)
  await fs.writeFile(`${base}.json`, JSON.stringify(data, null, 2) + '\n', 'utf8')
  await fs.writeFile(`${base}.md`, toMarkdown(data), 'utf8')
  console.log(JSON.stringify({ 角色: data.角色, 语音条数: data.语音台词.length, 故事条数: data.角色故事.length,
    文件: [`${base}.md`, `${base}.json`] }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
