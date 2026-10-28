import { createRequire } from 'node:module'

// Existing lore-only installations remain importable before the optional character dependency is installed.
let pinyin
try { ({ pinyin } = createRequire(import.meta.url)('pinyin-pro')) }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error }

const topic = /原神|提瓦特|角色|人物|剧情|故事|身世|台词|语音|生日|料理|喜欢|讨厌|评价|关于|关系|姐姐|妹妹|哥哥|弟弟|身份|真名|过去|神之眼|命之座|神之心|性格|经历|是谁|介绍|食物|下雨|下雪|早上好|晚安|武器|元素|所属|出身|师父|老师|信仰/
const nameTail = /^(?:的|是|和|与|对|为什么|怎么|喜欢|讨厌|生日|故事|台词|语音|料理|身份|过去|性格|经历|评价|来自|在哪|有|说|叫|呢|吗|[，,。！？!?、：: ]|$)/
const phonetic = value => {
  if (!pinyin) throw new Error('角色知识库缺少 pinyin-pro，请在插件目录运行 npm ci --ignore-scripts')
  return pinyin(value, { toneType: 'none', type: 'array' }).join('').toLowerCase().replace(/[^a-zü]/g, '')
}
const norm = value => String(value).normalize('NFKC').toLowerCase()

export function prepareEntities(registry) {
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.entities) || registry.entities.length > 2000) throw new Error('invalid entity registry')
  const ids = new Set(), names = [], conflicts = new Map()
  for (const entity of registry.entities) {
    if (!/^gs\.character\.[^\s/\\]{1,80}$/.test(entity.id) || ids.has(entity.id) || typeof entity.name !== 'string' || !entity.name || !Array.isArray(entity.aliases) || !Array.isArray(entity.profiles)) throw new Error('invalid entity')
    ids.add(entity.id)
    for (const item of [{ name: entity.name, contextual: entity.contextual, source: 'profile-name', pinyin: entity.pinyin }, ...entity.aliases]) {
      if (typeof item.name !== 'string' || !item.name || item.name.length > 40 || !item.source) throw new Error('invalid entity alias')
      const name = norm(item.name)
      const py = item.pinyin || phonetic(name)
      if (item.pinyin && !/^[a-zü]{2,100}$/.test(py)) throw new Error('invalid pinyin override')
      names.push({ name, pinyin: py, id: entity.id, canonical: entity.name, contextual: item.contextual === true, method: name === norm(entity.name) ? 'exact' : 'alias' })
      if (!conflicts.has(name)) conflicts.set(name, new Set())
      conflicts.get(name).add(entity.id)
    }
  }
  return { names: names.sort((a, b) => b.name.length - a.name.length), entities: registry.entities,
    conflicts: [...conflicts].filter(([, ids]) => ids.size > 1).map(([name, ids]) => ({ name, ids: [...ids] })) }
}

export function resolveEntities(input, registry) {
  const current = norm(input).slice(0, 700), found = [], occupied = new Set(), ambiguous = []
  const explicit = registry.names.some(n => n.name.length > 1 && !n.contextual && current.includes(n.name))
  const hasTopic = topic.test(current) || explicit
  const acceptBoundary = (at, length) => {
    const before = current.slice(0, at), after = current.slice(at + length)
    return nameTail.test(after) && (at === 0 || /[，,。！？!?、：: “「（(]|(?:关于|请问|派蒙|和|与|说说|聊聊|介绍|问问|觉得|那|是|对)$/.test(before.slice(-8)))
  }
  for (const name of registry.names) {
    for (let at = current.indexOf(name.name); at >= 0; at = current.indexOf(name.name, at + 1)) {
      if ((name.contextual || name.name.length === 1) && (!hasTopic || !acceptBoundary(at, name.name.length))) continue
      if (/^[a-z]+$/.test(name.name) && /[a-z]/.test(current[at - 1] || '') || /^[a-z]+$/.test(name.name) && /[a-z]/.test(current[at + name.name.length] || '')) continue
      const positions = Array.from({ length: name.name.length }, (_, i) => at + i)
      if (positions.some(p => occupied.has(p))) continue
      const choices = registry.names.filter(n => n.name === name.name)
      const ids = [...new Set(choices.map(n => n.id))]
      positions.forEach(p => occupied.add(p))
      if (ids.length > 1) ambiguous.push({ input: name.name, candidates: ids })
      else found.push({ ...name, input: current.slice(at, at + name.name.length), at })
    }
  }
  // Only whole, plausible name spans. No syllable initials, substring pinyin or edit-distance guessing.
  if (hasTopic) {
    const spans = []
    for (const m of current.matchAll(/[a-zü]{4,40}|[\p{Script=Han}]{2,}/gu)) {
      if (/^[a-zü]+$/.test(m[0])) spans.push({ value: m[0], at: m.index })
      else for (let at = m.index; at < m.index + m[0].length; at++) for (let len = 2; len <= 8 && at + len <= m.index + m[0].length; len++)
        if (acceptBoundary(at, len)) spans.push({ value: current.slice(at, at + len), at })
    }
    spans.sort((a, b) => b.value.length - a.value.length)
    for (const span of spans) {
      const positions = Array.from({ length: span.value.length }, (_, i) => span.at + i)
      if (positions.some(p => occupied.has(p))) continue
      const latin = /^[a-zü]+$/.test(span.value), py = latin ? span.value : phonetic(span.value)
      const candidates = registry.names.filter(n => n.name.length >= 2 && !n.contextual && n.pinyin === py && (latin || n.name.length === span.value.length))
      const ids = [...new Set(candidates.map(n => n.id))]
      if (!ids.length) continue
      positions.forEach(p => occupied.add(p))
      if (ids.length > 1) ambiguous.push({ input: span.value, candidates: ids })
      else found.push({ ...candidates[0], method: 'pinyin', input: span.value, at: span.at })
    }
  }
  const matches = [...new Map(found.sort((a, b) => a.at - b.at).map(n => [n.id, n])).values()].slice(0, 6)
  return { matches, ambiguous, hasTopic }
}

export function characterQuery(args, registry) {
  const messages = args.replyBatchMessages || []
  const current = String(args.query || messages.map(m => m.text || '').join('\n')).slice(0, 700)
  let resolution = resolveEntities(current, registry), context = ''
  if (!args.query && !resolution.matches.length && !resolution.ambiguous.length && /他|她|它|那位|后来|然后|出处|哪里说的/.test(current) && !/换个话题|换一题|不说这个/.test(current)) {
    const user = messages.at(-1)?.userId
    const batches = args.session?.sessionBatches?.some(b => b.messages?.length) ? args.session.sessionBatches : args.recentContext?.batches || []
    const history = batches.slice(-3).flatMap(b => b.messages || []).filter(m => user && String(m.userId) === String(user))
    const quote = args.recentContext?.quotedMessage
    const active = quote?.source === 'active_context' ? batches.flatMap(b => b.messages || []).find(m => m.messageId === quote.messageId && m.namespace === quote.namespace)?.text : ''
    const prior = String(quote ? quote.text || active || '' : history.at(-1)?.text || '').slice(0, 350)
    const previous = resolveEntities(prior, registry)
    if (previous.matches.length === 1 && !previous.ambiguous.length) { context = prior; resolution = previous }
    else if (previous.matches.length > 1 || previous.ambiguous.length) resolution.ambiguous.push({ input: 'context', candidates: previous.matches.map(m => m.id) })
  }
  return { current, context, ...resolution }
}
