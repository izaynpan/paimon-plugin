import fs from 'node:fs/promises'
import path from 'node:path'
import { randomInt, randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { root } from './paimon-style.js'
import { DeepSeekClient } from '../lib/deepseek.js'
import { buildChatMessages, normalizeChatResponse } from '../lib/prompt-builder.js'
import { stylePrompt } from '../lib/paimon-style.js'
import { styleEvalCases } from '../knowledge/paimon-style/eval-cases.js'
import { styleEvalCasesV2 } from '../knowledge/paimon-style/eval-cases-v2.js'
import { experimentModes, experimentMessages } from './paimon-style-experiment.js'
import { writeReviewPage } from './style-review-page.js'

const modes = ['off', 'rules', 'examples']
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function shuffle(items) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]] }
  return out
}

export function evalInput(item, mode, persona, history = [], turn = 0) {
  const group = item.scene === 'group'
  return {
    persona, session: { scene: item.scene, participants: {}, sessionBatches: history },
    replyBatchMessages: [{ userId: 'eval-user', displayName: '小林', nickname: '小林', text: item.turns[turn] }],
    knowledge: item.knowledge,
    config: { persona: { styleMode: mode }, conversation: { useUserNickname: true, selectiveGroupReply: group } },
  }
}

export async function prepareEvaluation({ repeats = 2, limit, outDir, study = 'v1' } = {}) {
  if (!['v1', 'v2'].includes(study)) throw new Error('未知评测版本')
  const available = study === 'v2' ? styleEvalCasesV2 : styleEvalCases
  const selectedModes = study === 'v2' ? experimentModes : modes
  limit ??= available.length
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5 || !Number.isInteger(limit) || limit < 1 || limit > available.length)
    throw new Error('repeats 须为 1～5；limit 不得超过场景数量')
  const persona = await fs.readFile(path.join(root, 'config/persona.md'), 'utf8')
  const cases = available.slice(0, limit)
  const plannedCalls = cases.reduce((sum, c) => sum + c.turns.length, 0) * repeats * selectedModes.length
  if (plannedCalls > 1200) throw new Error('单次评测最多 1200 次请求')
  const dir = outDir || path.join(root, 'data/paimon-style-eval', new Date().toISOString().replace(/[:.]/g, '-'))
  await fs.mkdir(dir, { recursive: true })
  const config = { model: 'deepseek-flash', maxTokens: 600, temperature: 0.8, maxRetries: 0, timeoutMs: 30000, thinking: { type: 'disabled' } }
  // Do not record credentials or private configuration. Archive exact prompts for reproducibility.
  const experimentSources = study === 'v2' ? await Promise.all(['scripts/paimon-style-experiment.js', 'knowledge/paimon-style/experiment-pool.js']
    .map(async file => ({ file, hash: hash((await fs.readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n')) }))) : []
  const fingerprint = hash({ persona, cases, experimentSources, prompts: modes.map(mode => stylePrompt({ persona: { styleMode: mode } })), config })
  const manifest = { version: 2, runId: randomUUID(), study, modes: selectedModes, experimentSources, fingerprint, config, repeats, cases: cases.length, plannedCalls,
    scope: '普通聊天表达对照；不执行研究/工具链。知识查证、真实 QQ 行为仍需单独联调。' }
  await fs.writeFile(path.join(dir, 'manifest.json'), json(manifest), { flag: 'wx' })
  await fs.writeFile(path.join(dir, 'prompts.json'), json(cases.map(c => ({ id: c.id,
    variants: selectedModes.map(mode => ({ mode, ...messagesForStudy(study, evalInput(c, mode, persona), mode) })) }))))
  return { dir, manifest, persona, cases }
}

function messagesForStudy(study, args, mode, recentIds = []) {
  return study === 'v2' ? experimentMessages(args, mode, { recentIds })
    : { messages: buildChatMessages(args), selectedIds: [], reason: mode }
}

export async function runEvaluation({ apiKey = process.env.DEEPSEEK_API_KEY, complete, onProgress = console.log, ...options } = {}) {
  if (!complete && !apiKey) throw new Error('未设置 DEEPSEEK_API_KEY；可先运行 prepare，不调用 API')
  const prepared = await prepareEvaluation(options)
  const { dir, manifest, persona, cases } = prepared
  const selectedModes = manifest.modes
  const client = new DeepSeekClient()
  const call = complete || (messages => client.complete({ messages, json: true,
    config: { deepseek: { ...manifest.config, apiKey, baseUrl: 'https://api.deepseek.com' } } }))
  const tasks = shuffle(cases.flatMap(item => Array.from({ length: manifest.repeats }, (_, repeat) =>
    selectedModes.map(mode => ({ item, repeat, mode }))).flat()))
  const results = [], errors = []
  let writing = Promise.resolve()
  let next = 0, calls = 0, stop = false
  // At most three concurrent requests; per-conversation turns remain sequential.
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (!stop && next < tasks.length) {
      const { item, repeat, mode } = tasks[next++]
      const history = []
      const recentSelections = []
      for (let turn = 0; turn < item.turns.length && !stop; turn++) {
        const args = evalInput(item, mode, persona, history, turn)
        try {
          const input = messagesForStudy(manifest.study, args, mode, recentSelections.slice(-2).flat())
          writing = writing.then(() => fs.appendFile(path.join(dir, 'requests.jsonl'), JSON.stringify({
            id: item.id, repeat, mode, turn, ...input }) + '\n'))
          await writing
          calls++
          const response = await call(input.messages)
          const parsed = normalizeChatResponse(response.data, { selective: item.scene === 'group' })
          const row = { id: item.id, category: item.category, repeat, mode, turn, prompt: item.turns[turn],
            history: structuredClone(history), selectedIds: input.selectedIds, selectionReason: input.reason,
            data: response.data, reply: parsed.reply, usage: response.usage }
          results.push(row)
          writing = writing.then(() => fs.appendFile(path.join(dir, 'responses.jsonl'), JSON.stringify(row) + '\n'))
          await writing
          history.push({ messages: args.replyBatchMessages, reply: parsed.reply, skipped: parsed.shouldReply === false })
          recentSelections.push(input.selectedIds)
        } catch (error) {
          // Error messages can include server-controlled text: store only bounded classifications.
          errors.push({ id: item.id, repeat, mode, turn, status: Number(error.status) || 0,
            code: /^[a-z_0-9]+$/.test(error.code || '') ? error.code : 'invalid_response' })
          if ([401, 402, 403, 429].includes(error.status) || error.code === 'network_error' || errors.length >= 5) stop = true
          break
        }
        if (results.length % 15 === 0) onProgress(`已完成 ${results.length}/${manifest.plannedCalls} 次回答`)
      }
    }
  }))
  const review = [], key = []
  for (const item of cases) for (let repeat = 0; repeat < manifest.repeats; repeat++) {
    const order = shuffle(selectedModes)
    for (let turn = 0; turn < item.turns.length; turn++) {
      const variants = order.map((mode, i) => {
        const row = results.find(x => x.id === item.id && x.repeat === repeat && x.mode === mode && x.turn === turn)
        const label = String.fromCharCode(65 + i)
        key.push({ id: item.id, repeat, turn, label, mode })
        return { label, reply: row?.reply ?? null, history: row?.history ?? [], error: !row,
          shouldReply: row?.data.shouldReply }
      })
      review.push({ id: item.id, category: item.category, repeat, turn, prompt: item.turns[turn], variants })
    }
  }
  await fs.writeFile(path.join(dir, 'blind-review.json'), json(review))
  await fs.writeFile(path.join(dir, 'blind-key.json'), json(key))
  if (manifest.study === 'v2') await writeReviewPage({ dir, manifest, review })
  const summary = { plannedCalls: manifest.plannedCalls, attempted: calls, completed: results.length, errors, stopped: stop,
    tokens: results.reduce((n, r) => n + (r.usage?.total_tokens || 0), 0),
    automaticSignals: Object.fromEntries(selectedModes.map(mode => {
      const rows = results.filter(x => x.mode === mode), replies = rows.map(x => x.reply)
      return [mode, { count: rows.length, meanChars: rows.length ? Math.round(replies.reduce((n, x) => n + [...x].length, 0) / rows.length) : null,
        foodOrMoney: replies.filter(x => /摩拉|好吃|吃的|食物|鸡肉串/.test(x)).length,
        question: replies.filter(x => /[？?]/.test(x)).length }]
    })), note: '自动信号仅用于筛查，不是角色相似度评分。请盲评后再查看 blind-key。' }
  await fs.writeFile(path.join(dir, 'summary.json'), json(summary))
  return { dir, summary }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!['prepare', 'run'].includes(command)) throw new Error('用法：node scripts/eval-paimon-style.js prepare|run [--study=v2] [--limit=24] [--repeats=5]')
  const options = {}
  for (const arg of args) {
    if (/^--study=v[12]$/.test(arg)) { options.study = arg.slice(8); continue }
    const match = /^--(limit|repeats)=(\d+)$/.exec(arg)
    if (!match) throw new Error('未知参数')
    options[match[1]] = Number(match[2])
  }
  const result = command === 'prepare' ? await prepareEvaluation(options) : await runEvaluation(options)
  console.log(JSON.stringify({ directory: result.dir, ...(result.manifest || result.summary) }))
  if (result.summary?.errors.length) process.exitCode = 1
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { console.error('风格评测未完成：请检查参数、环境变量和本地结果；未输出凭据。'); process.exitCode = 1 })
