import { LoreIndex, terms } from './search.js'
import { prepareEntities, characterQuery } from './entities.js'

function intentFor(query) {
  const sections = []
  if (/邮件|来信|信里/.test(query)) sections.push('生日邮件')
  else if (/生日|几月|哪天|所属|星级|武器类型|命之座|元素|神之眼/.test(query)) sections.push('基础档案')
  if (/料理|特色菜|拿手菜/.test(query)) sections.push('特殊料理')
  if (/台词|语音|说过|讲过|笑话|原话|原句|喜欢|喜好|爱好|兴趣|讨厌|爱吃|下雨|下雪|早上好|晚安|初次见面|评价|看法|怎么看|眼中|互评/.test(query)) sections.push('语音台词', '人物关联.他人评价')
  if (/故事|身世|经历|过去|来历|为什么|为何|师父|老师/.test(query)) sections.push('角色故事', '角色介绍')
  if (/性格|介绍|怎样的人|什么样的人|是谁|是什么人/.test(query)) sections.push('角色介绍', '角色故事', '语音台词')
  return { sections: [...new Set(sections)], cross: /历史|世界观|事件|战争|魔神|灾变|坎瑞亚|五百年|日月全事|剧情|前因后果/.test(query) ||
      /为什么|为何|来历|过去|经历|身世/.test(query) && !/角色故事\d|故事中的|这篇角色故事|角色介绍/.test(query),
    guide: /配队|圣遗物|主词条|副词条|伤害计算|抽卡|卡池|怎么培养|培养材料|充能效率|毕业面板|武器推荐|武器.*怎么配/.test(query) && !/剧情|故事|历史|身世|传说/.test(query),
    relation: /评价|看法|怎么看|眼中|关于/.test(query),
    content: /台词|语音|笑话|原话|原句|故事|说过|讲过/.test(query) &&
      !/生日|邮件|来信|料理|喜欢|讨厌|评价|看法|怎么看|眼中|互评|基础档案/.test(query) }
}

// Content anchors exclude retrieval instructions and conversational glue, not just character names.
function contentTerms(query) {
  return new Set(terms(query.replace(/(?:你|我)?(?:是否)?(?:听过|记得)|(?:给|跟|和|对)(?:你|我|派蒙|旅行者)|(?:说|讲)(?:过|的)|有一则|有一个|那一段|这一段|那段|这段|笑话|故事|台词|语音|原话|原句|旅行者|关于|里面|出处|哪段|哪里|还是/g, ' ')))
}

function characterCandidates(index, plan, intent, registry) {
  const entities = plan.matches.map(m => registry.entities.find(e => e.id === m.id))
  const files = new Set(entities.flatMap(e => e.profiles))
  const retrievalQuery = [plan.current, plan.context].filter(Boolean).join('\n')
  const genericTraveler = /旅行者/.test(retrievalQuery) && !entities.some(e => e.profiles.some(f => f.startsWith('traveler-')))
  if (genericTraveler) files.add('traveler-male.zh-CN.json')
  if (!files.size || intent.guide || plan.ambiguous.length) return []
  const names = entities.map(e => [e.name, ...e.aliases.map(a => a.name).filter(n => n.length > 1)])
  const directedRelation = intent.relation && names.length === 2 && !intent.content
  if (names.length === 2) {
    const [a, b] = plan.matches
    const between = plan.current.slice(a.at + a.input.length, b.at)
    if (/在|被/.test(between) || /^关于/.test(plan.current.slice(0, a.at))) names.reverse()
  }
  let query = (plan.contentFollowUp ? retrievalQuery : plan.current).normalize('NFKC').toLowerCase()
  for (const match of plan.matches) query = query.replaceAll(match.input, ' ')
  if (genericTraveler) query = query.replaceAll('旅行者', ' ')
  const queryTerms = new Set(terms(query)), scored = []
  const anchors = intent.content ? [...contentTerms(query)] : []
  const mentionNames = entities.flatMap(e => [e.name, ...e.aliases.filter(a => !a.contextual).map(a => a.name)]).filter(n => n.length > 1)
  for (let i = 0; i < index.documents.length; i++) {
    const d = index.documents[i]
    const ownFile = files.has(d.file)
    const sharedTraveler = genericTraveler && d.file.startsWith('traveler-')
    if (sharedTraveler && (d.file !== 'traveler-male.zh-CN.json' || !d.sharedWith)) continue
    // Cross-profile recall requires a named subject in the original text and distinctive content overlap.
    const words = index.wordSets[i]
    const contentHits = anchors.filter(t => words.has(t) && (index.frequencies.get(t) || 0) < index.documents.length * .15)
    const contentMatch = contentHits.length >= 2 || contentHits.some(t =>
      t.startsWith('w:') && t.length >= 5 || index.frequencies.get(t) <= Math.max(2, index.documents.length * .001))
    const crossProfile = !ownFile && intent.content && !directedRelation &&
      ['语音台词', '角色故事', '角色介绍'].includes(d.section) && !d.sharedWith &&
      mentionNames.some(n => d.text.includes(n)) && contentMatch
    if (!ownFile && !crossProfile) continue
    const years = plan.current.match(/(?:19|20)\d{2}/g)
    if (d.section === '生日邮件' && years?.length && d.mailDate && !years.some(y => d.mailDate.startsWith(y))) continue
    const title = d.headingPath.at(-1), heading = new Set(terms(title))
    let overlap = 0, headingScore = 0
    for (const token of queryTerms) {
      const df = index.frequencies.get(token) || index.documents.length
      const weight = Math.log(1 + index.documents.length / df)
      if (words.has(token)) overlap += weight
      if (heading.has(token)) headingScore += weight * 3
    }
    const sectionMatch = intent.sections.includes(d.section)
    const speaker = d.speakerMode === 'mixed' ? '' : d.speaker || (d.section === '语音台词' ? d.profile : '')
    const subject = d.subject || title
    const forward = directedRelation &&
      (names[0].some(n => speaker.includes(n)) && names[1].some(n => subject.includes(n)) ||
       /互相|彼此|相互|互评/.test(plan.current) && names[1].some(n => speaker.includes(n)) && names[0].some(n => subject.includes(n)))
    if (directedRelation && !forward) continue
    // A name alone can retrieve an introduction; a specific missing field cannot become arbitrary biography.
    if (intent.sections.length && !sectionMatch && !intent.cross && !crossProfile) continue
    if (!intent.sections.length && !overlap && !['角色介绍', '基础档案'].includes(d.section)) continue
    if (intent.sections.length && !overlap && !forward && !['角色故事', '角色介绍'].includes(d.section) &&
        !(d.section === '特殊料理' && /料理|特色菜|拿手菜/.test(query)) && !(d.section === '生日邮件' && /邮件|来信/.test(query))) continue
    let score = overlap + headingScore + (sectionMatch ? 25 : 0)
    if (intent.content && contentMatch) score += 40
    if (query.includes(title) && title.length > 2) score += 100
    if (!intent.sections.length && d.section === '角色介绍') score += 20
    if (/生日|哪天|几月/.test(query) && d.section === '基础档案' && title === '生日') score += 80
    if (/喜欢|喜好|爱吃/.test(query) && /喜欢的食物/.test(title)) score += 30
    if (/讨厌/.test(query) && /讨厌/.test(title)) score += 30
    if (directedRelation) {
      // The first named person is the evaluator in A对B/ A怎么评价B. Other phrasings may need a local reformulation.
      if (forward) score += 120
      else if (names[1].some(n => speaker.includes(n)) && names[0].some(n => subject.includes(n))) score -= 80
    }
    if (score > 0) scored.push({ ...d, score, genericTraveler: sharedTraveler, crossProfile })
  }
  return scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 80)
}

export function evidenceBlock(d) {
  if (d.collection !== 'characters') return d.block
  const subject = d.genericTraveler ? '旅行者共用资料（男女正文相同）' : d.profile
  const mixed = d.speakerMode === 'mixed' ? '；来源包含多个说话者或身份，未标注的一句不能只凭页面或评价者标签归属给某个人物' : ''
  const continued = d.dialogueStartSpeaker ? `；片段开头承接原文说话者：${d.dialogueStartSpeaker}，后续按正文标签区分` : ''
  return `[${d.id}] ${subject} / ${d.section} / ${d.headingPath.at(-1)}\n性质：${d.contentKind}；来源栏目收录，未逐句核实官方原文${d.speaker ? `；说话者：${d.speaker}；评价对象：${d.subject}` : '；正文可能含多个说话者，按原文区分'}${mixed}${continued}\n${d.text}`
}

export class KnowledgeIndex extends LoreIndex {
  constructor(snapshot) {
    super(snapshot)
    if (snapshot.characters) {
      this.registry = prepareEntities(snapshot.characters.registry)
      // Field-scoped candidates need document frequencies, not a second full posting/frequency index.
      this.characters = { documents: snapshot.characters.chunks, frequencies: new Map(), wordSets: [] }
      for (const d of this.characters.documents) {
        const words = new Set(terms(d.text + '\n' + d.headingPath.at(-1)))
        this.characters.wordSets.push(words)
        for (const word of words) this.characters.frequencies.set(word, (this.characters.frequencies.get(word) || 0) + 1)
      }
    }
  }
  search(args, options = {}) {
    if (!options.characters || !this.characters) return options.lore === false
      ? { matches: [], plan: { entities: [] }, truncated: false } : super.search(args, options)
    const started = performance.now(), plan = characterQuery(args, this.registry), intent = intentFor(plan.contentFollowUp ? plan.current + '\n' + plan.context : plan.current)
    if (plan.ambiguous.length) return { matches: [], plan: { ...plan, entities: [], ambiguous: true }, truncated: false,
      diagnostics: { ambiguousCandidates: plan.ambiguous, elapsedMs: performance.now() - started } }
    let normalized = [plan.current, plan.context].filter(Boolean).join('\n').normalize('NFKC').toLowerCase()
    for (const match of plan.matches) normalized = normalized.replaceAll(match.input, match.canonical)
    const lore = options.lore === false ? { matches: [], plan: { entities: [] } }
      : super.search(plan.matches.length ? { ...args, query: normalized } : args, { ...options, topK: 8, maxContextChars: 16000 })
    const characters = characterCandidates(this.characters, plan, intent, this.registry)
    const preferCharacter = (plan.matches.some(m => this.registry.entities.find(e => e.id === m.id)?.profiles.length) || /旅行者/.test(plan.current)) && intent.sections.length && !intent.cross
    const unknownField = !plan.matches.length && /生日|邮件|来信|料理|喜欢|讨厌|台词|语音|命之座|武器类型/.test(plan.current) && !intent.cross
    const unrelated = !plan.matches.length && !lore.plan.entities?.length && !plan.context &&
      /Python|编程|安装|空气|弹琴|练琴|睡眠|影子|这件事|那件事|谢谢|好累/i.test(plan.current)
    const loreMatches = preferCharacter || unknownField || unrelated ? [] : lore.matches
    // Rank fusion, not a direct comparison of unrelated BM25 scales.
    const rawPool = [
      ...characters.map((d, rank) => ({ ...d, fusion: (preferCharacter ? 2 : 1) / (30 + rank), block: evidenceBlock(d) })),
      ...loreMatches.map((d, rank) => ({ ...d, fusion: 1.1 / (30 + rank) })),
    ].sort((a, b) => b.fusion - a.fusion)
    const pool = [], duplicates = new Map()
    for (const d of rawPool) {
      const key = d.collection === 'characters' ? (d.speaker || d.profile) + '\n' + d.text : d.id
      const ref = { file: d.file, section: d.section, heading: d.headingPath.at(-1), sourcePath: d.sourcePath, url: d.url }
      if (duplicates.has(key)) duplicates.get(key).sourceRefs.push(ref)
      else { const merged = { ...d, sourceRefs: [ref] }; pool.push(merged); duplicates.set(key, merged) }
    }
    const topK = options.topK ?? 6, limit = options.maxContextChars ?? 10000
    const selected = [], seen = new Set(), parents = new Map(), limitReasons = new Set(); let size = 0, truncated = false
    const add = (d, max = topK) => {
      if (!d) return
      const key = (d.collection === 'characters' ? (d.speaker || d.profile) + '\n' : '') + d.text
      if (seen.has(key) || selected.some(m => m.id === d.id)) return
      if ((parents.get(d.parentId) || 0) >= 2 && d.parentId) { limitReasons.add('parent_limit'); return }
      if (selected.length >= max) { limitReasons.add('top_k'); return }
      if (size + d.block.length + (selected.length ? 2 : 0) > limit) { truncated = true; limitReasons.add('context_budget'); return }
      selected.push(d); seen.add(key); size += d.block.length + (selected.length > 1 ? 2 : 0)
      parents.set(d.parentId, (parents.get(d.parentId) || 0) + 1)
    }
    // Comparisons reserve evidence for each requested profile; cross-source questions reserve both collections.
    if (plan.matches.length > 1 && !intent.relation) for (const match of plan.matches) {
      const files = this.registry.entities.find(e => e.id === match.id).profiles
      add(pool.find(d => files.includes(d.file)))
    }
    if (intent.cross && characters.length && lore.matches.length) {
      add(pool.find(d => d.collection === 'characters')); add(pool.find(d => d.collection === 'genshin-lore'))
    }
    for (const d of pool) add(d)
    for (const d of [...selected]) {
      if (selected.length >= topK + 2 || d.collection !== 'characters' || d.type !== 'paragraph') continue
      const next = this.characters.documents.find(n => n.parentId === d.parentId && n.order === d.order + 1)
      if (next) add({ ...next, block: evidenceBlock(next), adjacent: true }, topK + 2)
    }
    return { matches: selected, plan: { ...lore.plan, entities: plan.matches.map(m => [m.canonical]),
      ambiguous: false, outsideScope: intent.guide, originalQuery: plan.current }, truncated,
      diagnostics: { elapsedMs: Math.round(performance.now() - started), candidates: { characters: characters.length, lore: lore.matches.length },
        truncationReasons: [...limitReasons],
        entities: plan.matches.map(m => ({ id: m.id, method: m.method })),
        collections: Object.fromEntries(['characters', 'genshin-lore'].map(c => [c, { count: selected.filter(d => d.collection === c).length, chars: selected.filter(d => d.collection === c).reduce((n, d) => n + d.block.length, 0) }])) } }
  }
}
