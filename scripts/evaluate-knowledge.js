import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSnapshot } from '../lib/knowledge/store.js'
import { LoreIndex } from '../lib/knowledge/search.js'
import { pluginRoot } from '../lib/paths.js'
import { loreQuestions } from '../tests/fixtures/lore-questions.js'

export function evaluate(index, questions = loreQuestions) {
  const rows = questions.map(question => {
    const start = performance.now()
    const result = index.search(question.args || { query: question.query })
    const hits = question.expected.map(e => result.matches.some(m => m.file === e.file &&
      (!e.heading || m.headingPath.some(h => h.includes(e.heading))) && (!e.text || m.text.includes(e.text)) &&
      (!e.kind || m.contentKind === e.kind) && (!e.uncertain || m.uncertain)))
    return { id: question.id, category: question.category, query: question.query || question.args.replyBatchMessages.at(-1).text,
      pass: question.expectMiss ? result.matches.length === 0 : hits.length > 0 && hits.every(Boolean),
      expected: question.expected, hits, milliseconds: performance.now() - start,
      results: result.matches.map(m => ({ id: m.id, file: m.file, heading: m.headingPath.join(' / '), line: m.lineStart })) }
  })
  const categories = Object.fromEntries([...new Set(rows.map(r => r.category))].map(c => {
    const selected = rows.filter(r => r.category === c)
    return [c, { passed: selected.filter(r => r.pass).length, total: selected.length }]
  }))
  const times = rows.map(r => r.milliseconds).sort((a, b) => a - b)
  return { revision: index.snapshot.revision, total: rows.length, passed: rows.filter(r => r.pass).length,
    categories, queryP95Ms: times[Math.floor(times.length * .95)], rows }
}
export async function main() {
  const snapshot = await buildSnapshot(), report = evaluate(new LoreIndex(snapshot))
  const target = path.join(pluginRoot, 'data/knowledge/evaluation.json')
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ ...report, rows: undefined, failures: report.rows.filter(r => !r.pass).map(r => ({ id: r.id, query: r.query, expected: r.expected, results: r.results.slice(0, 6) })) }, null, 2))
  // A regression gate for this curated corpus, not a claim that every user question is answerable.
  const negatives = report.categories.negative, followups = report.categories.followup
  if (report.passed / report.total < .90 || negatives.passed !== negatives.total || followups.passed !== followups.total) process.exitCode = 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error); process.exitCode = 1 })
