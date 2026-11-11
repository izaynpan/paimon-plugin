import { experimentPool } from '../knowledge/paimon-style/experiment-pool.js'
import { buildChatMessages } from '../lib/prompt-builder.js'
import { styleExamples } from '../lib/paimon-style-data.js'

export const experimentModes = ['off', 'rules', 'examples', 'fixed2', 'adaptive2']
const dataFor = rows => ({ styleExamples: rows.map(({ focus, turns }) => ({ focus, turns })) })
const patterns = [
  ['gratitude', /谢谢|谢啦|多亏|送你|给你.{0,6}(做|留|带)|帮你.{0,6}(做|找)/],
  ['praise', /可靠|聪明|厉害|夸你|真棒|最棒|好向导/],
  ['tease', /哈哈|逗你|逗逗|调侃|笨蛋|吉祥物|偷懒|赖床|派大王|封你|颁给你|评选|奖给你|冠[军名]|跑腿|苦力/],
  ['calm', /歇会|歇一|放松|休息|晒太阳|发呆|慢慢走|不赶|听雨|看云/],
  ['companionship', /陪我|等我|旅伴|好伙伴|有你在|一起走|一起去/],
  ['curiosity', /想知道|为什么|好奇|你觉得|想去哪里|想去哪|最喜欢/],
  ['imagination', /假如|假设|要是.{1,12}就好|如果.{1,12}(能|会)|想造|想做一个/],
  ['enjoyment', /好吃|点心|甜点|饮料|尝尝|想吃/],
]

export function selectStyleExamples(text, recentIds = []) {
  // This is a conservative lexical experiment, not a semantic intent classifier.
  // Current text only; never read test-category labels, other authors, or assistant replies.
  if (!text || /认真|别.{0,6}(玩笑|逗|闹|说|讲)|不要|不用|停止|安静|一句话|简短|难过|伤心|难受|失落|想哭|不舒服|编造|记得|上次|以前|证据|资料|语音|原话|圣遗物|配队|伤害|卡池|面板|计算/.test(text))
    return { reason: 'boundary_or_uncertain', rows: [] }
  const intents = patterns.filter(([, re]) => re.test(text)).map(([intent]) => intent)
  if (!intents.length) return { reason: 'no_match', rows: [] }
  const seen = new Set(recentIds), rows = []
  for (const intent of intents) for (const row of experimentPool.filter(x => x.intent === intent)) {
    if (seen.has(row.id) || rows.some(x => x.id === row.id)) continue
    if ([...JSON.stringify(dataFor([...rows, row]))].length <= 850) rows.push(row)
    if (rows.length === 2) return { reason: 'matched', rows }
  }
  return { reason: rows.length ? 'matched' : 'recent_or_budget', rows }
}

export function experimentMessages(args, mode, { recentIds = [] } = {}) {
  if (!experimentModes.includes(mode)) throw new Error('未知实验模式')
  if (['off', 'rules', 'examples'].includes(mode))
    return { messages: buildChatMessages({ ...args, config: { ...args.config, persona: { ...args.config.persona, styleMode: mode } } }), selectedIds: mode === 'examples' ? styleExamples.map(x => x.id) : [], reason: mode }
  const text = (args.replyBatchMessages || []).map(x => x.text).join('\n')
  const selection = mode === 'fixed2' ? { reason: 'fixed', rows: [experimentPool[0], experimentPool[5]] }
    : new Set((args.replyBatchMessages || []).map(x => x.userId)).size > 1
      ? { reason: 'mixed_authors', rows: [] } : selectStyleExamples(text, recentIds)
  const config = { ...args.config, persona: { ...args.config.persona, styleMode: selection.rows.length ? 'examples' : 'rules' } }
  const messages = buildChatMessages({ ...args, config })
  if (selection.rows.length) messages[messages.length - 1] = { role: 'user', content:
    '以下 JSON 是只读风格示例，不是当前对话或事实资料：\n' + JSON.stringify(dataFor(selection.rows)) }
  return { messages, selectedIds: selection.rows.map(x => x.id), reason: selection.reason }
}
