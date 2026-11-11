import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep the two dimensions separate; balance conversations rather than counting
// correlated turns/repetitions as independent votes. No invented quality score.
export function summarizeRatings({ manifest, key, review, ratings }) {
  if (!manifest.runId || ratings.runId !== manifest.runId || ratings.version !== 2 || ratings.fingerprint !== manifest.fingerprint || !ratings.ratings || typeof ratings.ratings !== 'object' || Array.isArray(ratings.ratings))
    throw new Error('评分版本或实验指纹不匹配')
  const index = new Map(key.map(x => [[x.id, x.repeat, x.turn, x.label].join('/'), x]))
  const valid = new Set(review.flatMap(r => r.variants.filter(v => !v.error).map(v => [r.id, r.repeat, r.turn, v.label].join('/'))))
  const rows = []
  for (const [id, row] of Object.entries(ratings.ratings)) {
    if (!index.has(id) || !valid.has(id) || !row || typeof row !== 'object') throw new Error('评分包含未知或失败回答')
    for (const dimension of ['voice', 'appropriateness']) if (row[dimension] != null && (!Number.isInteger(row[dimension]) || row[dimension] < 1 || row[dimension] > 5))
      throw new Error('评分须为 1～5 或留空')
    rows.push({ ...index.get(id), voice: row.voice ?? null, appropriateness: row.appropriateness ?? null })
  }
  const mean = xs => xs.reduce((n, x) => n + x, 0) / xs.length
  const dimensions = {}
  for (const dim of ['voice', 'appropriateness']) {
    const scored = rows.filter(r => r[dim] != null)
    const byMode = {}
    for (const mode of manifest.modes) {
      const subset = scored.filter(r => r.mode === mode), cases = [...new Set(subset.map(r => r.id))]
      byMode[mode] = { ratings: subset.length, cases: cases.length,
        caseBalancedMean: cases.length ? mean(cases.map(id => mean(subset.filter(r => r.id === id).map(r => r[dim])))) : null }
    }
    const paired = []
    for (let i = 0; i < manifest.modes.length; i++) for (const b of manifest.modes.slice(i + 1)) {
      const a = manifest.modes[i], deltas = []
      for (const left of scored.filter(r => r.mode === a)) {
        const right = scored.find(r => r.mode === b && r.id === left.id && r.repeat === left.repeat && r.turn === left.turn)
        if (right) deltas.push({ id: left.id, value: left[dim] - right[dim] })
      }
      const cases = [...new Set(deltas.map(r => r.id))]
      paired.push({ a, b, pairedAnswers: deltas.length, cases: cases.length,
        caseBalancedDifference: cases.length ? mean(cases.map(id => mean(deltas.filter(r => r.id === id).map(r => r.value)))) : null })
    }
    dimensions[dim] = { byMode, paired }
  }
  return { runId: manifest.runId, fingerprint: manifest.fingerprint, ratedAnswers: rows.filter(r => r.voice != null || r.appropriateness != null).length,
    dimensions, note: '两个维度独立统计；先在同一场景内平均，再等权汇总场景。仅描述已评分样本，不代表总体显著性；少量、未配对或选择性评分不能断言方案优劣。' }
}

async function main() {
  const [dir, file] = process.argv.slice(2)
  if (!dir || !file) throw new Error('用法：node scripts/score-paimon-style.js <评测目录> <导出的评分.json>')
  const [manifest, key, review, ratings] = await Promise.all(['manifest.json', 'blind-key.json', 'blind-review.json', file]
    .map((name, i) => fs.readFile(i === 3 ? name : path.join(dir, name), 'utf8').then(JSON.parse)))
  console.log(JSON.stringify(summarizeRatings({ manifest, key, review, ratings }), null, 2))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
