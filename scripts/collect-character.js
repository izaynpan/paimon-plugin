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

export function extractCharacter(response, { id, fetchedAt, rawHash }) {
  const page = response?.data?.page
  if (response?.retcode !== 0 || String(page?.id) !== id || !Array.isArray(page?.modules))
    throw new Error('公开接口返回失败、词条 ID 不匹配或缺少模块；未生成资料')
  const modules = page.modules.filter(m => !m.is_hidden)
  const components = m => (m.components ?? []).map(c => ({ type: c.component_id, data: JSON.parse(c.data) }))
  const named = name => modules.filter(m => m.name === name)
  const rich = m => {
    const cs = components(m)
    if (cs.some(c => c.type !== 'collapse_panel')) throw new Error(`栏目结构变更，需人工检查：${m.name}`)
    return cs.map(c => plainText(c.data.rich_text)).filter(Boolean).join('\n\n')
  }
  const textSections = name => named(name).map(m => ({ 标题: m.name, 正文: rich(m) })).filter(x => x.正文)
  const base = modules.flatMap(components).filter(c => c.type === 'role_base_info')
  const voice = modules.flatMap(components).filter(c => c.type === 'role_voice')
  if (base.length !== 1 || voice.length !== 1) throw new Error('基础信息或配音模块缺失/重复，需人工检查')
  const cn = voice[0].data.list.filter(v => ['汉语', '中文', '简体中文'].includes(v.tab_name))
  if (cn.length !== 1 || !cn[0].table?.length) throw new Error('未找到唯一的中文语音文本列表')
  const titles = new Set()
  const lines = cn[0].table.map(v => {
    const item = { 标题: plainText(v.name), 正文: plainText(v.content) }
    if (!item.标题 || !item.正文 || titles.has(item.标题)) throw new Error('中文语音存在空标题、空正文或重复标题')
    titles.add(item.标题)
    return item
  })
  const descriptionGroups = (page.template_layout?.tab ?? []).flatMap(t => t.module_group ?? [])
    .filter(g => g.name === '角色描述')
  if (descriptionGroups.length !== 1) throw new Error('未找到唯一的角色描述分组，不能安全识别特殊故事')
  const storyIds = new Set(descriptionGroups[0].module.map(m => String(m.id)))
  const stories = modules.filter(m => storyIds.has(String(m.id)) && !['更多描述', '角色详细', '生日邮件', '特殊料理'].includes(m.name))
    .map(m => ({ 标题: plainText(m.name), 正文: rich(m) })).filter(s => s.正文)
  if (stories.some(s => !s.标题)) throw new Error('发现无标题的故事正文，需人工检查')
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
  for (const m of named('角色关系网')) {
    for (const c of components(m)) {
      if (c.type !== 'role_relation') throw new Error('角色关系网结构变更')
      for (const table of c.data.tables ?? []) {
        if (table.header?.length !== 2 || plainText(table.header[0]) !== '角色')
          throw new Error('角色关系网表头变更')
        for (const row of table.row ?? []) {
          if (row.length !== 2 || !plainText(row[0]) || !plainText(row[1])) throw new Error('角色关联语音不完整')
          others.push({ 角色: plainText(row[0]), 标题: plainText(table.header[1]), 正文: plainText(row[1]) })
        }
      }
    }
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
    角色介绍: [...textSections('更多描述'), ...textSections('角色详细')],
    角色故事: stories,
    语音台词: lines,
    人物关联: { 相关角色: related, 本人相关评价: lines.filter(v => /^关于/.test(v.标题)
      && !/^关于(?:我们|自己)/.test(v.标题) && !v.标题.startsWith(`关于${page.name}自己`))
      .map(v => ({ 台词标题: v.标题 })), 他人评价: others },
    生日邮件: textSections('生日邮件'),
    特殊料理: textSections('特殊料理')
  }
  // The allowlist above intentionally omits audio, images, actors, combat data and recommendations.
  result.采集说明 = [
    '正文按来源保留，不自动改写或补全；页面版本不等同游戏版本，抓取不等同事实核验。',
    '语音仅保留一份中文文本；本人相关评价通过台词标题引用，不重复存储正文。',
    '人物关联只收录本页明确展示的条目和评价，不据此推断关系；本人相关评价也可能涉及概念。',
    '生日邮件和特殊料理仅收录本页已有内容，不追抓外链。'
  ]
  const absent = ['角色介绍', '角色故事', '生日邮件', '特殊料理'].filter(k => !result[k].length)
  if (absent.length) result.采集说明.push(`本页未收录或未识别到：${absent.join('、')}。`)
  return result
}

export function toMarkdown(data) {
  const out = [`# ${data.角色}`, '', `来源：[米游社观测枢](${data.来源.页面})`, '',
    `词条编号：${data.来源.词条编号}　页面版本：${data.来源.页面版本}`, '',
    `抓取时间：${new Date(data.来源.抓取时间).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`, '',
    '## 基础档案', '', ...data.基础档案.map(a => `- ${a.项目}：${a.内容}`), '']
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
  const data = extractCharacter(JSON.parse(raw), { id, fetchedAt, rawHash: hash(raw) })
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
