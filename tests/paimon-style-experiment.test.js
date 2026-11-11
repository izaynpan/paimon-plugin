import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { selectStyleExamples, experimentMessages } from '../scripts/paimon-style-experiment.js'
import { styleEvalCasesV2 } from '../knowledge/paimon-style/eval-cases-v2.js'
import { experimentPool } from '../knowledge/paimon-style/experiment-pool.js'
import { styleMode } from '../lib/paimon-style.js'
import { evalInput, runEvaluation } from '../scripts/eval-paimon-style.js'
import { reviewPayload } from '../scripts/style-review-page.js'
import { summarizeRatings } from '../scripts/score-paimon-style.js'

test('动态实验保留说话者、有限选例；当前停止要求优先，无匹配就不给示例', () => {
  assert.equal(experimentPool.length, 24)
  const a = selectStyleExamples('派大王，颁给你一个偷懒奖')
  assert.equal(a.rows.length, 2)
  const b = selectStyleExamples('派大王，颁给你一个偷懒奖', a.rows.map(x => x.id))
  assert.ok(b.rows.every(x => !a.rows.some(y => y.id === x.id)))
  for (const text of ['今天难过，别逗我了', '谢谢，但现在请认真听', '我想听原话', '怎样算伤害', '先不要说话', '嗯'])
    assert.deepEqual(selectStyleExamples(text).rows, [])
  const args = evalInput(styleEvalCasesV2[2], 'adaptive2', '既有人设')
  const out = experimentMessages(args, 'adaptive2')
  const data = JSON.parse(out.messages.at(-1).content.split('\n')[1])
  assert.ok([...JSON.stringify(data)].length <= 850)
  assert.equal(data.styleExamples.length, 2)
  assert.doesNotMatch(JSON.stringify(data), /"id"|"intent"|sourceIds/)
  assert.equal(args.config.persona.styleMode, 'adaptive2')
  assert.equal(styleMode(args.config), 'off', '实验模式不成为线上配置')
  args.replyBatchMessages.push({ userId: 'other', text: '哈哈，派大王' })
  assert.equal(experimentMessages(args, 'adaptive2').reason, 'mixed_authors')
})

test('第二轮实验保存完整请求，三轮历史与模式隔离，盲评页面不带解盲映射', async t => {
  const base = path.resolve(os.tmpdir()), dir = await fs.mkdtemp(path.join(base, 'paimon-style-v2-'))
  t.after(async () => { assert.ok(path.resolve(dir).startsWith(base + path.sep)); await fs.rm(dir, { recursive: true, force: true }) })
  const result = await runEvaluation({ study: 'v2', limit: 24, repeats: 1, outDir: dir, onProgress() {},
    complete: async messages => ({ data: { reply: '收到', emotion: 'neutral', replyKind: 'chat',
      ...(messages[0].content.includes('【是否回应】') ? { shouldReply: true, reason: 'direct_address' } : {}) } }) })
  assert.equal(result.summary.completed, 200)
  const requests = (await fs.readFile(path.join(dir, 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(requests.length, 200)
  const b = requests.find(x => x.id === 'v2-17' && x.mode === 'adaptive2' && x.turn === 1)
  assert.ok(['boundary_or_uncertain', 'no_match'].includes(b.reason))
  assert.deepEqual(b.selectedIds, [])
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json')))
  const review = JSON.parse(await fs.readFile(path.join(dir, 'blind-review.json')))
  assert.equal(review.length, 40)
  const page = await fs.readFile(path.join(dir, 'review.html'), 'utf8')
  assert.doesNotMatch(page, /adaptive2|fixed2|deepseek-flash|blind-key|selectedIds/)
  const payload = reviewPayload(manifest, review)
  assert.equal(payload.rows[0].variants.length, 5)
  assert.equal(payload.rows.find(x => x.id === 'v2-17' && x.turn === 2).variants[0].history.length, 2)
  const malicious = structuredClone(review)
  malicious[0].variants[0].reply = '</script><script>bad()</script>'
  const { writeReviewPage } = await import('../scripts/style-review-page.js')
  await writeReviewPage({ dir, manifest, review: malicious })
  assert.ok(!(await fs.readFile(path.join(dir, 'review.html'), 'utf8')).includes('<script>bad()'))
})

test('角色感与合适程度单独评分；按场景等权且拒绝错实验和未知回答', () => {
  const manifest = { fingerprint: 'test', runId: 'this-run', modes: ['off', 'rules'] }
  const key = [0, 1].flatMap(repeat => ['A', 'B'].map(label => ({ id: 'case1', repeat, turn: 0, label, mode: label === 'A' ? 'off' : 'rules' })))
  const review = [0, 1].map(repeat => ({ id: 'case1', repeat, turn: 0, variants: [{ label: 'A' }, { label: 'B' }] }))
  const ratings = { version: 2, fingerprint: 'test', runId: 'this-run', ratings: {
    'case1/0/0/A': { voice: 2, appropriateness: 5 }, 'case1/0/0/B': { voice: 5, appropriateness: 2 },
    'case1/1/0/A': { voice: 4, appropriateness: null }, 'case1/1/0/B': { voice: 5, appropriateness: null },
  } }
  const out = summarizeRatings({ manifest, key, review, ratings })
  assert.equal(out.dimensions.voice.byMode.off.caseBalancedMean, 3)
  assert.equal(out.dimensions.voice.paired[0].caseBalancedDifference, -2)
  assert.equal(out.dimensions.appropriateness.paired[0].caseBalancedDifference, 3)
  assert.equal(out.dimensions.voice.paired[0].cases, 1)
  assert.throws(() => summarizeRatings({ manifest, key, review, ratings: { ...ratings, fingerprint: 'other' } }), /指纹/)
  assert.throws(() => summarizeRatings({ manifest, key, review, ratings: { ...ratings, runId: 'different-label-order' } }), /指纹/)
  assert.throws(() => summarizeRatings({ manifest, key, review, ratings: { ...ratings, ratings: { 'nope': { voice: 5 } } } }), /未知/)
})
