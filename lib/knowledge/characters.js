import fs from 'node:fs/promises'
import path from 'node:path'
import { hash } from './markdown.js'
import { resolveTraveler, sectionRecords, recordId } from '../../scripts/traveler-profiles.js'

export const CHARACTER_VERSION = 1
const sections = ['基础档案', '角色介绍', '角色故事', '语音台词', '人物关联.他人评价', '生日邮件', '特殊料理']
const filePattern = /^(?:\d+|traveler-(?:female|male))\.zh-CN\.json$/
const text = (v, label) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 200000) throw new Error('invalid character ' + label)
  return v.trim()
}
export function characterPieces(body, limit = 850) {
  const pieces = [], sentences = body.match(/[^。！？\n]+[。！？\n]?|[。！？\n]/gu) || [body]
  let pending = ''
  for (const sentence of sentences) {
    if (pending && pending.length + sentence.length > limit) { pieces.push(pending); pending = '' }
    if (sentence.length > limit) {
      if (pending) { pieces.push(pending); pending = '' }
      for (let i = 0; i < sentence.length; i += limit) pieces.push(sentence.slice(i, i + limit))
    } else pending += sentence
  }
  if (pending) pieces.push(pending)
  return pieces
}
function recordFragments(body, section, heading) {
  const letters = section === '生日邮件' ? body.split(/(?=^主题[：:])/m).filter(s => s.trim()) : [body]
  const split = letters.length > 1 && letters.every(s => /^主题[：:][^\n]+\n/.test(s) && /^发件人[：:]/m.test(s) && /^时间[：:]/m.test(s))
  return (split ? letters : [body]).flatMap(letter => {
    const date = section === '生日邮件' ? letter.match(/^时间[：:]\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1] || '' : ''
    const subject = section === '生日邮件' ? letter.match(/^主题[：:]\s*([^\n]+)/m)?.[1] || '' : ''
    let cursor = 0
    return characterPieces(letter).map((fragment, part) => {
      const at = letter.indexOf(fragment, cursor)
      cursor = at + fragment.length
      const preceding = at >= 0 ? letter.slice(0, at) : ''
      const dialogueStartSpeaker = section === '语音台词' && !/^(?:●\s*)?(?:派蒙|旅行者|荧|空)[：:]/.test(fragment.trim())
        ? [...preceding.matchAll(/(?:^|\n|●)\s*(派蒙|旅行者|荧|空)[：:]/g)].at(-1)?.[1] || '' : ''
      return { fragment, part, date, dialogueStartSpeaker,
        heading: subject ? [heading, date, subject].filter(Boolean).join(' · ') : heading,
        group: hash(letter).slice(0, 20), split: letter.length > 850 }
    })
  })
}
const sourceUrl = value => /^https:\/\/baike\.mihoyo\.com\/ys\/obc\/content\/\d+\/detail$/.test(value || '')

export function parseCharacter(data, entry, original = data, mixedSpeakers = []) {
  if (![1, 2].includes(data.格式版本) || data.语言 !== '简体中文' || data.角色 !== entry.name || !data.来源)
    throw new Error('invalid character schema: ' + entry.file)
  const sources = data.格式版本 === 1 ? [data.来源] : [...data.来源.元素词条, ...data.来源.补充语音来源]
  if (data.格式版本 === 2 && (data.来源.元素词条.length !== 7 || new Set(data.来源.元素词条.map(s => s.元素)).size !== 7 ||
      data.来源.元素词条.some(s => !['火', '风', '水', '岩', '草', '雷', '冰'].includes(s.元素)))) throw new Error('incomplete traveler element provenance')
  if (!sources.length || sources.some(s => !sourceUrl(s.页面) || !/^\d+$/.test(s.词条编号) || !/^[a-f0-9]{64}$/.test(s.原始响应摘要) || !Number.isFinite(Date.parse(s.抓取时间))))
    throw new Error('invalid character provenance: ' + entry.file)
  const chunks = [], missing = [], seen = new Set()
  for (const section of sections) {
    const records = sectionRecords(data, section)
    if (!Array.isArray(records) || records.length > 10000) throw new Error('invalid character section: ' + section)
    if (!records.length) missing.push(section)
    const ownIndexes = new Map(sectionRecords(original, section).map((record, index) => [recordId(section, record), index]))
    const commonIndexes = new Map((original.共用内容?.[section]?.条目 || []).map((ref, index) => [ref.条目标识, index]))
    const provenance = new Map([...(original.合并索引?.[section] || []), ...(original.共用内容?.[section]?.条目 || [])].map(r => [r.条目标识, r]))
    records.forEach(record => {
      const heading = text(record.项目 || record.标题, 'heading')
      const body = text(record.内容 || record.正文, 'body')
      const sourceRecordId = recordId(section, record)
      const parentId = hash(entry.file + '\n' + section + '\n' + sourceRecordId).slice(0, 24)
      const speaker = section === '人物关联.他人评价' ? text(record.角色, 'speaker') : ''
      const metadata = data.格式版本 === 2 ? provenance.get(sourceRecordId) : null
      if (data.格式版本 === 2 && !metadata) throw new Error('missing traveler provenance')
      if (metadata && (!Array.isArray(metadata.来源词条) || !metadata.来源词条.length || metadata.来源词条.some(id => !sources.some(s => s.词条编号 === id)))) throw new Error('invalid traveler record origin')
      const commonIndex = commonIndexes.get(sourceRecordId) ?? -1
      const ownIndex = ownIndexes.get(sourceRecordId)
      const sourcePath = commonIndex >= 0 ? `/共用内容/${section}/条目/${commonIndex}` : `/${section.split('.').join('/')}/${ownIndex}`
      const origins = metadata ? sources.filter(s => metadata.来源词条.includes(s.词条编号) || section === '语音台词' && data.来源.补充语音来源.includes(s)) : sources
      if (!origins.length) throw new Error('missing character origin')
      const fragments = recordFragments(body, section, heading)
      fragments.forEach(({ fragment, part, date, heading: leaf, group, split, dialogueStartSpeaker }) => {
        const recordParent = hash(parentId + group).slice(0, 24)
        const id = 'kb-' + hash(recordParent + '\n' + fragment + '\n' + part).slice(0, 24)
        if (seen.has(id)) return
        seen.add(id)
        const line = (section === '基础档案' ? heading + '：' : '') + fragment
        chunks.push({ id, parentId: recordParent, sectionId: recordParent, order: part, collection: 'characters',
          file: entry.file, entityId: entry.entityId, profile: data.角色, section, speaker,
          speakerMode: speaker ? mixedSpeakers.includes(speaker) ? 'mixed' : 'owner' : entry.speakerMode || 'owner',
          // A profile can contain several speakers; never label all dialogue as its owner's speech.
          subject: speaker ? data.角色 : '', title: data.角色, headingPath: [data.角色, section, leaf],
          text: line, type: split ? 'paragraph' : 'record', mailDate: date, dialogueStartSpeaker, references: [],
          contentKind: section === '人物关联.他人评价' ? 'character_opinion' : section === '语音台词' ? 'character_dialogue' : 'character_record',
          uncertain: /可能|推测|猜测|传说|未标注/.test(fragment + speaker), edition: '', verifiedThroughVersion: '',
          sourcePath, sourceRecordId, contentHash: hash(fragment), url: origins[0].页面,
          origins: origins.map(s => ({ id: s.词条编号, url: s.页面, pageVersion: s.页面版本, fetchedAt: s.抓取时间, sha256: s.原始响应摘要 })),
          sharedWith: commonIndex >= 0 ? 'traveler-female.zh-CN.json' : '',
        })
      })
    })
  }
  return { chunks, missing, navigation: data.人物关联?.相关角色 || [] }
}

export async function buildCharacters(root) {
  const directory = path.join(root, 'knowledge/characters')
  const read = async file => {
    const raw = await fs.readFile(file)
    if (!raw.length || raw.length > 10000000) throw new Error('invalid character input size')
    return { value: JSON.parse(raw), sha256: hash(raw), bytes: raw.length }
  }
  const manifest = (await read(path.join(root, 'knowledge/character-sources.json'))).value
  const registry = (await read(path.join(root, 'knowledge/entities.json'))).value
  const report = (await read(path.join(directory, 'collection-report.json'))).value
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 1000 || registry.schemaVersion !== 1)
    throw new Error('invalid character manifest')
  if (!Array.isArray(report.失败) || report.失败.length || !Array.isArray(report.输出资料) || report.输出资料数 !== report.输出资料.length)
    throw new Error('incomplete character collection')
  const expected = report.输出资料.map(r => r.文件 + '.zh-CN.json').sort()
  if (JSON.stringify(expected) !== JSON.stringify(manifest.files.map(r => r.file).sort())) throw new Error('character manifest differs from collection report; review additions/deletions')
  const values = new Map(), sources = [], chunks = [], profiles = []
  for (const entry of manifest.files) {
    if (!filePattern.test(entry.file) || values.has(entry.file) || !registry.entities.some(e => e.id === entry.entityId && e.profiles.includes(entry.file)))
      throw new Error('invalid or duplicate character source')
    const input = await read(path.join(directory, entry.file)); values.set(entry.file, input.value)
    const reported = report.输出资料.find(r => r.文件 + '.zh-CN.json' === entry.file)
    if (reported.角色 !== entry.name) throw new Error('character report name mismatch')
    sources.push({ collection: 'characters', file: entry.file, title: entry.name, sha256: input.sha256, bytes: input.bytes })
  }
  if (values.has('traveler-male.zh-CN.json') !== values.has('traveler-female.zh-CN.json')) throw new Error('traveler pair must be updated together')
  for (const entry of manifest.files) {
    const original = values.get(entry.file)
    if (original.格式版本 === 2 && !/^traveler-(female|male)\.zh-CN\.json$/.test(entry.file)) throw new Error('unknown character variant')
    if (original.基准资料 && (entry.file !== 'traveler-male.zh-CN.json' || original.基准资料.文件 !== 'traveler-female.zh-CN.json')) throw new Error('invalid traveler base file')
    const full = original.基准资料 ? resolveTraveler(original, values.get('traveler-female.zh-CN.json')) : original
    const parsed = parseCharacter(full, entry, original, manifest.files.filter(e => e.speakerMode === 'mixed').map(e => e.name))
    chunks.push(...parsed.chunks)
    profiles.push({ ...entry, missing: parsed.missing, navigation: parsed.navigation, records: parsed.chunks.length })
  }
  if (!chunks.length || chunks.length > 100000) throw new Error('invalid character corpus size')
  return { version: CHARACTER_VERSION, manifest, registry, sources, chunks, profiles }
}
