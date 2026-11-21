import fs from 'node:fs/promises'
import path from 'node:path'
import { hash } from './markdown.js'
import { queryFor } from './search.js'

const titles = ['高等元素论', '伤害乘区论']

// Keep Markdown tables and TeX intact. Each blank-line-delimited block is indivisible.
export async function buildUniversity(root) {
  const chunks = [], sources = []
  for (const title of titles) {
    const file = title + '.md', sourcePath = 'knowledge/teyvat-university/' + file
    const raw = await fs.readFile(path.join(root, sourcePath))
    const lines = raw.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    const headings = [], startCount = chunks.length
    let last
    for (let i = 0; i < lines.length;) {
      const heading = lines[i].match(/^(#{1,6})\s+(.+)$/)
      if (heading) {
        headings.length = heading[1].length
        headings[headings.length - 1] = heading[2].trim()
        last = null
        i++
        continue
      }
      if (!lines[i].trim() || headings.includes('目录')) { i++; continue }
      const start = i++
      while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i])) i++
      const block = lines.slice(start, i).join('\n')
      if (last && last.text.length + block.length + 2 <= 780) {
        last.text += '\n\n' + block
        last.lineEnd = i
      } else {
        const headingPath = headings.filter(Boolean)
        last = { collection: 'teyvat-university', contentKind: 'combat_mechanics', title, file, sourcePath,
          headingPath, sectionId: hash(sourcePath + '\n' + headingPath.join('/')).slice(0, 20),
          type: 'section_excerpt', references: [], lineStart: start + 1, lineEnd: i, text: block }
        chunks.push(last)
      }
    }
    const count = chunks.length - startCount
    if (!count) throw new Error('empty university source: ' + file)
    sources.push({ file, title, sha256: hash(raw), chunks: count })
  }
  for (const d of chunks) d.id = 'kb-' + hash(d.sourcePath + '\n' + d.headingPath.join('/') + '\n' + d.text).slice(0, 24)
  return { sources, chunks }
}

// Require a corpus topic before ranking. Everyday questions and character names alone are too broad.
const topics = /高等元素论|伤害乘区论|元素反应|元素量|元素克制|元素附着|附着冷却|双计数器|元素精通|增幅反应|剧变反应|月曜反应|星烁反应|蒸发|融化|超载|星?超导|月?感电|燃烧|冻结|碎冰|星?扩散|[超烈月]?绽放|月?结晶|[原超蔓]?激化|草原核|雷暴云|草露|月笼|星辉风旋|极星辉域|伤害乘区|基础伤害|单次攻击|整合公式|伤害倍率|攻击区|倍率区|增伤|暴击|防御区|减防|穿防|无视防御|抗性|减抗|减伤|盾值|护盾强效|元素附魔|冷却缩减|攻速|dps/gi
const synonyms = {
  icd: '附着冷却', 独立附着: '附着冷却', 弱元素: '元素量', 强元素: '元素量',
  双暴: '暴击率 暴击伤害', 爆伤: '暴击伤害', 爆率: '暴击率', 负抗: '抗性 减抗',
  水打火: '蒸发 倍率', 火打水: '蒸发 倍率', 火打冰: '融化 倍率', 冰打火: '融化 倍率',
}
const ambiguous = /^(?:蒸发|融化|燃烧|冻结|扩散|结晶|绽放|激化|超载|超导)$/
const gameContext = /原神|元素|反应|触发|附着|倍率|伤害|机制|精通|物抗|水打火|火打水|[火水冰雷草风岩](?:系|伤|打|底)|角色|提瓦特/
const narrative = /剧情|故事|台词|语音|身世|生日|世界观|历史|料理/

export function universityPlan(args) {
  const plan = queryFor(args, [])
  const expand = text => {
    const normalized = text.normalize('NFKC').toLowerCase()
    const expanded = [normalized, ...Object.entries(synonyms).filter(([word]) => normalized.includes(word)).map(([, value]) => value)].join(' ').trim()
    if (!expanded.match(topics) && /伤害(?:怎么[计结]?算|计算|公式)|乘区/.test(expanded)) return expanded + ' 单次攻击 整合公式 基础伤害'
    return expanded
  }
  let query = expand(plan.current)
  let anchors = query.match(topics) || []
  if (!anchors.length && plan.context && /^(?:那|那么|所以|然后|它|这|还有|为什么|出处|哪里说的)/.test(plan.current.trim())) {
    query += ' ' + expand(plan.context)
    anchors = query.match(topics) || []
  }
  if (!anchors.length || anchors.every(a => ambiguous.test(a)) && !gameContext.test(query) &&
      !(anchors.includes('融化') && anchors.includes('蒸发'))) return null
  const mixed = narrative.test(plan.current)
  if (mixed && !/机制|反应|计算|倍率|乘区|怎么触发|怎么结算/.test(plan.current)) return null
  return { ...plan, query, expansions: [...new Set(anchors)], outsideScope: false, mixed }
}
