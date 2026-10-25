import { createHash } from 'node:crypto'

export const PARSER_VERSION = 2
export const hash = value => createHash('sha256').update(value).digest('hex')
export const plain = text => String(text).replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/\\([|*_`])/g, '$1').replace(/[*`]/g, '')
  .replace(/^>\s?/gm, '').trim()

function pieces(text, limit) {
  if (text.length <= limit) return [text]
  const sentences = text.match(/[^。！？\n]+[。！？\n]?|[。！？\n]/gu) || [text]
  const out = []; let current = ''
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) { out.push(current); current = '' }
    if (sentence.length > limit) {
      const chars = [...sentence]
      while (chars.length) out.push(chars.splice(0, limit).join(''))
    } else current += sentence
  }
  if (current) out.push(current)
  return out
}

// Parse only this corpus's Markdown dialect. Source coordinates remain original line numbers.
export function parseMarkdown(markdown, source, { maxChars = 850 } = {}) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n'), notes = new Map()
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[\^([^\]]+)\]:\s*(.*)/)
    if (!m) continue
    let text = m[2]
    while (i + 1 < lines.length && /^ {2,}\S/.test(lines[i + 1])) text += '\n' + lines[++i].trim()
    notes.set(m[1], plain(text))
  }
  const chunks = [], headings = [], headingReferences = [], seen = new Set(), warnings = []
  let order = 0, stopped = false
  const emit = (raw, start, end, type) => {
    const bodyRefs = [...raw.matchAll(/\[\^([^\]]+)\]/g)].map(m => m[1])
    const refs = [...new Set([...headingReferences.flat(), ...bodyRefs])]
    const references = refs.map(id => ({ id, text: notes.get(id) || '' }))
    for (const r of references) if (!r.text) warnings.push(`missing footnote ${r.id}:${start}`)
    const text = plain(raw.replace(/\[\^[^\]]+\]/g, ''))
    if (!text || /^本文已按/.test(text)) return
    const headingPath = headings.filter(Boolean)
    const sectionId = hash(source.file + '\n' + headingPath.join('/')).slice(0, 20)
    for (const body of pieces(text, maxChars)) {
      const id = 'kb-' + hash(source.file + '\n' + headingPath.join('/') + '\n' + body).slice(0, 24)
      if (seen.has(id)) continue
      seen.add(id)
      const commentary = headingPath.some(s => /编者之声|编者的话|结语/.test(s)) || /编者的话/.test(body)
      chunks.push({ id, sectionId, order: order++, collection: 'genshin-lore', file: source.file,
        title: source.title, headingPath, text: body, type, lineStart: start, lineEnd: end,
        contentKind: commentary ? 'compiler_commentary' : 'compilation',
        uncertain: /疑似|可能|推测|猜测|传说|尚未|待发现|尚不确定/.test(headingPath.join(' ') + body + references.map(r => r.text).join(' ')),
        references, edition: source.edition || '', verifiedThroughVersion: source.verifiedThroughVersion || '',
        // A footnote page locates the note; it is not a verified page for the entire chunk.
        footnotePages: [...new Set(refs.map(id => id.match(/^p(\d+)-/)?.[1]).filter(Boolean))],
      })
    }
  }
  for (let i = 0; i < lines.length;) {
    const heading = lines[i].match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      stopped = /^(注释与来源|脚注)$/.test(plain(heading[2]))
      headings.length = heading[1].length
      headingReferences.length = heading[1].length
      headingReferences[heading[1].length - 1] = [...heading[2].matchAll(/\[\^([^\]]+)\]/g)].map(m => m[1])
      headings[heading[1].length - 1] = plain(heading[2].replace(/\[\^[^\]]+\]/g, ''))
      i++; continue
    }
    if (stopped || !lines[i].trim() || /^\[\^|^!\[|^<\/?div|^```/.test(lines[i])) { i++; continue }
    if (lines[i].startsWith('|') && /^\|\s*:?-+/.test(lines[i + 1] || '')) {
      const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(s => s.trim())
      const header = cells(lines[i]); i += 2
      while (i < lines.length && lines[i].startsWith('|')) {
        const row = cells(lines[i])
        if (row.length !== header.length) warnings.push(`table columns:${i + 1}`)
        emit(row.map((v, n) => `${plain(header[n] || '补充字段')}：${v}`).join('\n'), i + 1, i + 1, 'table_row')
        i++
      }
      continue
    }
    const start = i, block = []
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s|^\[\^|^\|/.test(lines[i])) block.push(lines[i++])
    if (i === start) { i++; continue }
    emit(block.join('\n'), start + 1, i, 'paragraph')
  }
  const merged = []
  for (const chunk of chunks) {
    const last = merged.at(-1)
    if (last?.type === 'paragraph' && chunk.type === 'paragraph' && last.contentKind === chunk.contentKind && last.sectionId === chunk.sectionId && last.text.length + chunk.text.length + 2 <= maxChars) {
      last.text += '\n\n' + chunk.text
      last.lineEnd = chunk.lineEnd
      last.uncertain ||= chunk.uncertain
      last.references = [...new Map([...last.references, ...chunk.references].map(r => [r.id, r])).values()]
      last.footnotePages = [...new Set([...last.footnotePages, ...chunk.footnotePages])]
    } else merged.push({ ...chunk })
  }
  merged.forEach((chunk, i) => {
    chunk.order = i
    chunk.id = 'kb-' + hash(source.file + '\n' + chunk.headingPath.join('/') + '\n' + chunk.text).slice(0, 24)
  })
  return { chunks: merged, warnings }
}
