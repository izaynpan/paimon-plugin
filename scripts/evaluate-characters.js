import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSnapshot } from '../lib/knowledge/store.js'
import { KnowledgeIndex } from '../lib/knowledge/unified-index.js'
import { characterQuestions } from '../tests/fixtures/character-questions.js'

export function evaluateCharacters(index, questions = characterQuestions) {
  const failures = [], splits = {}, times = []
  for (const item of questions) {
    const start = performance.now(), result = index.search({ query: item.query }, { characters: true })
    times.push(performance.now() - start)
    const success = item.expected.length ? item.expected.every(e => result.matches.some(m =>
      [{ file: m.file, section: m.section, heading: m.headingPath.at(-1) }, ...(m.sourceRefs || [])].some(r => r.file === e.file && r.section === e.section && r.heading.includes(e.heading)))) : !result.matches.length
    const stats = splits[item.split] ||= { total: 0, passed: 0 }
    stats.total++; if (success) stats.passed++
    else failures.push({ ...item, actual: result.matches.map(m => ({ file: m.file, section: m.section, heading: m.headingPath.at(-1) })) })
  }
  times.sort((a, b) => a - b)
  return { total: questions.length, passed: questions.length - failures.length, splits,
    queryP50Ms: times[Math.floor(times.length * .5)], queryP95Ms: times[Math.min(times.length - 1, Math.floor(times.length * .95))], failures }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const partition = process.argv.includes('--holdout') ? 'holdout' : process.argv.includes('--dev') ? 'dev' : ''
  const started = performance.now(), snapshot = await buildSnapshot({ characters: true }), index = new KnowledgeIndex(snapshot)
  const report = { revision: snapshot.revision, preparationMs: performance.now() - started,
    profiles: snapshot.characters.profiles.length, chunks: snapshot.characters.chunks.length, rssBytes: process.memoryUsage().rss,
    ...evaluateCharacters(index, characterQuestions.filter(q => !partition || q.split === partition)) }
  console.log(JSON.stringify(report, null, 2))
  const out = process.argv.indexOf('--out')
  if (out >= 0) await fs.writeFile(process.argv[out + 1], JSON.stringify(report, null, 2) + '\n')
  if (report.passed / report.total < .95) process.exitCode = 1
}
