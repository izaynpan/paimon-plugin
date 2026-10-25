import { hash } from './markdown.js'

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const stop = new Set(['派蒙', '为什么', '怎么', '什么', '是谁', '怎样', '哪个', '哪些', '关系', '介绍', '一下', '事情', '到底', '可以', '知道', '告诉', '请问', '他们', '她们', '这个', '那个', '后来', '相关', '原神', '剧情', '世界观', '过去', '如何', '为何', '人们', '曾经', '地方', '有什么', '是什么', '发生', '什么事', '经历', '来历', '有什', '么事', '为什', '么会', '么关', '系是', '的关', '是什', '么时', '时候', '么地', '么的', '有哪', '些什', '哪里', '故事'])
const generic = new Set(['影', '黄金', '少女', '队长', '贤者', '龙王', '博士', '女士', '富人', '公子', '木偶', '公鸡', '仆人', '风神', '岩神'])
const loreIntent = /原神|提瓦特|剧情|世界观|魔神|愚人众|执行官|坎瑞亚|稻妻|须弥|蒙德|璃月|枫丹|至冬|纳塔|故事|历史|身世|过去|以前|当年|五百年|500年|为什么|为何|身份|真名|是谁/
export function terms(text) {
  const clean = String(text).normalize('NFKC').toLowerCase().replace(/https?:\/\/\S+/g, ' ')
  const out = []
  for (const { segment, isWordLike } of segmenter.segment(clean))
    if (isWordLike && segment.length > 1 && !stop.has(segment)) out.push('w:' + segment)
  for (const run of clean.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < run.length - 1; i++) {
      const t = run.slice(i, i + 2)
      if (!stop.has(t) && !/[的么呢呀吗是]/.test(t)) out.push('b:' + t)
    }
  return out
}

export function queryFor(args, groups) {
  const messages = args.replyBatchMessages || []
  const current = String(args.query || messages.map(m => m.text || '').join('\n')).slice(0, 700)
  const matches = text => {
    const found = [], occupied = new Set(), selected = new Set()
    const hasTopic = loreIntent.test(text) || groups.some(g => g.some(a => a.length > 1 && !generic.has(a) && text.includes(a)))
    groups.forEach((g, i) => g.forEach(a => {
      if (a.length < 2 || generic.has(a) && !hasTopic) return
      for (let at = text.indexOf(a); at >= 0; at = text.indexOf(a, at + 1)) found.push({ i, at, length: a.length })
    }))
    found.sort((a, b) => b.length - a.length)
    for (const f of found) {
      const positions = Array.from({ length: f.length }, (_, i) => f.at + i)
      if (positions.some(p => occupied.has(p))) continue
      positions.forEach(p => occupied.add(p)); selected.add(f.i)
    }
    return [...selected].map(i => groups[i])
  }
  let context = '', ambiguous = false
  if (!args.query && /(?:他|她|它|他们|她们|那位|那个人|那她姐姐|后来|然后|那.{0,8}呢|为什么会这样|为什么这么说|出处|哪里说的)/.test(current) && !/换个话题|换一题|不说这个/.test(current)) {
    const userId = messages.at(-1)?.userId
    const batches = args.session?.sessionBatches?.some(b => b.messages?.length) ? args.session.sessionBatches : args.recentContext?.batches || []
    const history = batches.slice(-3).flatMap(b => b.messages || []).filter(m => !userId || String(m.userId) === String(userId))
    const quoted = args.recentContext?.quotedMessage
    // The runtime may omit duplicated quote text already present in active history.
    const activeQuote = quoted?.source === 'active_context' && quoted.messageId
      ? batches.flatMap(b => b.messages || []).find(m => m.messageId === quoted.messageId && m.namespace === quoted.namespace)?.text : ''
    const previous = quoted ? quoted.text || activeQuote || '' : history.at(-1)?.text || ''
    const previousGroups = matches(previous), currentGroups = matches(current)
    if (!currentGroups.length) {
      if (previousGroups.length <= 1 && previous.trim()) context = String(previous).slice(0, 350)
      else ambiguous = true
    }
  }
  const entities = matches(current + ' ' + context).slice(0, 6)
  const expansions = [...new Set(entities.flat())].filter(a => a.length > 1)
  // Relational follow-ups resolve only explicit, curated relations, never a guessed identity.
  const relations = /姐姐/.test(current) && entities.some(g => g.includes('雷电影')) ? ['雷电真'] : []
  expansions.push(...relations)
  const outsideScope = /配队|圣遗物|词条|主词条|副词条|伤害计算|抽卡|卡池|怎么培养|培养材料|充能效率|毕业面板|武器推荐|武器.*怎么配/.test(current) && !/剧情|故事|历史|身世|传说/.test(current)
  const smallTalk = !entities.length && /^(?:派蒙[，,！! ]*)?(?:你好|早上好|晚安|谢谢|辛苦了|今天吃什么|好无聊|我好累|我今天很难过|今天天气.*|你真可爱)[呀啊呢吧啦！!？?。 ]*$/.test(current.trim())
  return { current, context, expansions, entities, relations, ambiguous, outsideScope, smallTalk,
    query: [current, context].filter(Boolean).join('\n') }
}

export class LoreIndex {
  constructor(snapshot) {
    this.snapshot = snapshot
    this.documents = snapshot.chunks
    this.postings = new Map(); this.lengths = []; this.sections = new Map()
    this.aliases = snapshot.aliases.groups
    this.cache = new Map()
    this.documents.forEach((d, index) => {
      const tokens = terms(d.text + '\n' + d.headingPath.join(' ')), freq = new Map()
      tokens.forEach(t => freq.set(t, (freq.get(t) || 0) + 1))
      this.lengths.push(tokens.length)
      for (const [t, count] of freq) {
        if (!this.postings.has(t)) this.postings.set(t, [])
        this.postings.get(t).push([index, count])
      }
      if (!this.sections.has(d.sectionId)) this.sections.set(d.sectionId, [])
      this.sections.get(d.sectionId).push(index)
    })
    this.averageLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length)
  }

  search(args, { topK = 6, maxContextChars = 10000 } = {}) {
    const plan = queryFor(args, this.aliases)
    if (plan.outsideScope || plan.smallTalk || plan.ambiguous) return { matches: [], plan, truncated: false }
    const key = hash(JSON.stringify([plan, topK, maxContextChars]))
    if (this.cache.has(key)) return structuredClone(this.cache.get(key))
    const weights = new Map(), direct = new Set(terms(plan.current)), allDirect = new Set(terms(plan.query))
    const queryWords = [...allDirect].filter(t => t.startsWith('w:'))
    const knownWords = queryWords.filter(t => this.postings.has(t))
    const bigrams = [...allDirect].filter(t => t.startsWith('b:'))
    // A few accidental bigrams from an unknown name or unrelated technical question are not evidence.
    if (!plan.entities.length && (queryWords.length >= 3 && knownWords.length / queryWords.length < .5 ||
        bigrams.length >= 6 && bigrams.filter(t => this.postings.has(t)).length / bigrams.length < .65))
      return { matches: [], plan, truncated: false }
    for (const t of direct) weights.set(t, 1)
    for (const t of terms(plan.context)) if (!weights.has(t)) weights.set(t, .65)
    for (const a of plan.expansions) for (const t of terms(a)) if (!weights.has(t)) weights.set(t, .3)
    const scores = new Map(), overlaps = new Map(), n = this.documents.length
    for (const [term, weight] of weights) {
      const posting = this.postings.get(term) || []
      const idf = Math.log(1 + (n - posting.length + .5) / (posting.length + .5))
      for (const [i, freq] of posting) {
        const score = weight * idf * (freq * 2.2) / (freq + 1.2 * (.25 + .75 * this.lengths[i] / this.averageLength))
        scores.set(i, (scores.get(i) || 0) + score)
        if (allDirect.has(term)) overlaps.set(i, (overlaps.get(i) || 0) + 1)
      }
    }
    const candidates = [...scores].map(([i, score]) => {
      const d = this.documents[i], heading = d.headingPath.join(' ')
      const exact = plan.expansions.some(a => d.text.includes(a))
      const inHeading = plan.expansions.some(a => heading.includes(a))
      const names = plan.expansions.filter(a => d.text.includes(a)).length
      const identity = /是谁|叫什么|原名|身份|哪几位/.test(plan.current)
      const headingTokens = new Set(terms(heading))
      const leafTokens = new Set(terms(d.headingPath.at(-1) || ''))
      let headingScore = 0
      let headingAnchor = false
      for (const term of allDirect) if (headingTokens.has(term)) {
        const df = this.postings.get(term)?.length || n
        headingScore += (leafTokens.has(term) ? 3 : 1) * Math.log(1 + n / df)
        if (df < n / 10) headingAnchor = true
      }
      const relationScore = plan.relations.some(a => d.text.includes(a)) ? 18 : 0
      return { i, score: score + headingScore + relationScore + (exact ? 6 : 0) + (inHeading ? 8 : 0) + Math.min(4, names) * 3 + (identity && d.type === 'table_row' ? 12 : 0), overlap: overlaps.get(i) || 0, exact, headingAnchor }
    }).filter(r => r.overlap >= 2 || r.headingAnchor || r.exact && plan.entities.length > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 24)
    const picked = [], seen = new Set(), textSeen = new Set(); let used = 0, truncated = false
    const add = (index, score, adjacent = false) => {
      const d = this.documents[index]
      if (seen.has(d.id) || textSeen.has(d.text)) return
      const references = d.references.map(r => `${r.id}：${r.text}`).join('\n')
      const block = `[${d.id}] ${d.title} / ${d.headingPath.join(' / ')}\n性质：${d.contentKind}${d.uncertain ? '；含不确定或传说表述' : ''}\n${d.text}${references ? '\n出处注释：\n' + references : ''}`
      const size = block.length + (picked.length ? 2 : 0)
      if (used + size > maxContextChars) { truncated = true; return }
      used += size; seen.add(d.id); textSeen.add(d.text)
      picked.push({ ...d, score, adjacent, block })
    }
    for (const r of candidates) {
      if (picked.length >= topK) break
      add(r.i, r.score)
    }
    // Expand only the immediately neighbouring paragraph in the same section.
    for (const match of [...picked]) {
      if (picked.length >= topK + 2) break
      const ids = this.sections.get(match.sectionId), position = ids.findIndex(i => this.documents[i].id === match.id)
      const next = ids[position + 1]
      if (next !== undefined && match.type === 'paragraph' && this.documents[next].type === 'paragraph') add(next, match.score, true)
    }
    const result = { matches: picked, plan, truncated }
    this.cache.set(key, result)
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value)
    return structuredClone(result)
  }
}
