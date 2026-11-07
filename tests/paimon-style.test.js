import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { artifacts, buildCorpus, compileExamples, mergeTurns, parseDialogue, root } from '../scripts/paimon-style.js'
import { stylePrompt, styleMode } from '../lib/paimon-style.js'
import { buildChatMessages, buildUnansweredFollowUpMessages } from '../lib/prompt-builder.js'
import { evalInput, runEvaluation } from '../scripts/eval-paimon-style.js'
import { styleEvalCases } from '../knowledge/paimon-style/eval-cases.js'

test('风格资料精确恢复旅行者引用、保留来源和说话者，构建产物可复现', async () => {
  const corpus = await buildCorpus()
  assert.deepEqual(corpus.rejected, [])
  assert.equal(corpus.records.length, 178)
  assert.equal(new Set(corpus.records.map(x => x.id)).size, corpus.records.length)
  assert.ok(corpus.records.some(x => x.sources.length === 2))
  assert.ok(corpus.records.some(x => x.sources.length === 1 && x.sources[0].traveler === '空'))
  const curation = JSON.parse(await fs.readFile(path.join(root, 'knowledge/paimon-style/curation.json')))
  assert.equal(curation.entries.length, 32)
  const examples = compileExamples(corpus, curation)
  assert.equal(examples.length, 6)
  for (const example of examples) {
    const record = corpus.records.find(x => x.id === example.id)
    for (const turn of example.turns)
      assert.ok(record.lines.filter(x => x.speaker === turn.speaker).map(x => x.text).join('').includes(turn.text))
  }
  for (const [name, expected] of await artifacts()) assert.equal((await fs.readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n'), expected)
  const bad = structuredClone(curation)
  bad.entries[0].id = 'source-changed'
  assert.throws(() => compileExamples(corpus, bad), /缺失、变动/)
})

test('风格抽取拒绝不明说话者，合并连续台词而不交换角色', () => {
  assert.equal(parseDialogue('●派蒙：你好\n旁白：开始冒险'), null)
  assert.equal(parseDialogue('●派蒙：你好\n没有标签的句子'), null)
  const lines = parseDialogue('●旅行者：这个呢？\n●派蒙：让我想想。\n●派蒙：好呀！')
  assert.deepEqual(mergeTurns(lines), [{ speaker: '旅行者', text: '这个呢？' }, { speaker: '派蒙', text: '让我想想。好呀！' }])
  assert.equal(lines.length, 3)
})

test('关闭风格精确恢复原消息；规则与示例均不篡改事实、记忆、称呼或输出协议', () => {
  const item = { ...styleEvalCases[0], knowledge: { text: '本轮的独立知识证据' } }
  const original = evalInput(item, 'off', '原有人设')
  original.participantMemories = { a: { userId: 'a', memory: '喜欢花' } }
  const baseline = buildChatMessages(original)
  const args = structuredClone(original)
  delete args.config.persona.styleMode
  assert.deepEqual(buildChatMessages(args), baseline)
  args.config.persona.styleMode = 'invalid'
  assert.deepEqual(buildChatMessages(args), baseline)
  for (const mode of ['rules', 'examples']) {
    args.config.persona.styleMode = mode
    const messages = buildChatMessages(args)
    assert.deepEqual(messages.slice(1, baseline.length), baseline.slice(1))
    assert.ok(messages[0].content.includes('原有人设'))
    assert.ok(messages[0].content.includes('喜欢花'))
    assert.equal(messages[0].content.replace('\n' + stylePrompt(args.config).rules, ''), baseline[0].content)
    assert.doesNotMatch(messages[0].content, /木漏茶室|史莱姆派蒙/)
    if (mode === 'examples') {
      assert.match(messages.at(-1).content, /只读风格示例/)
      assert.doesNotMatch(messages.at(-1).content, /sourceIds|kb-|w-/)
      assert.match(messages[0].content, /不提供本题事实证据/)
      assert.match(messages[0].content, /不据此假定用户的性别/)
      assert.equal(JSON.parse(messages.at(-1).content.split('\n')[1]).styleExamples.length, 6)
      assert.ok([...messages.at(-1).content].length < 1600)
    } else assert.equal(messages.length, baseline.length)
  }
  args.config.persona.styleMode = 'off'
  assert.deepEqual(buildChatMessages(args), baseline)
  assert.equal(styleMode({ persona: { styleMode: true } }), 'off')
})

test('风格不改变主动补话；每次构造读取当前模式，不改用户消息', () => {
  const args = evalInput(styleEvalCases[0], 'off', '人设')
  const question = { sentAt: 1000, batchIndex: 0 }
  const before = buildUnansweredFollowUpMessages({ ...args, question, now: 2000 })
  args.config.persona.styleMode = 'examples'
  assert.deepEqual(buildUnansweredFollowUpMessages({ ...args, question, now: 2000 }), before)
  assert.equal(styleEvalCases.length, 60)
  assert.equal(new Set(styleEvalCases.map(x => x.id)).size, 60)
  assert.ok(styleEvalCases.some(x => x.turns.length > 1))
})

test('对照评测使用隔离上下文、隐藏模式的审阅表，鉴权失败停止且不保存错误正文', async t => {
  const tempRoot = path.resolve(os.tmpdir())
  const dir = await fs.mkdtemp(path.join(tempRoot, 'paimon-style-test-'))
  t.after(async () => {
    assert.ok(path.resolve(dir).startsWith(tempRoot + path.sep))
    await fs.rm(dir, { recursive: true, force: true })
  })
  const calls = []
  const ok = await runEvaluation({ limit: 2, repeats: 1, outDir: path.join(dir, 'ok'), onProgress() {},
    complete: async messages => { calls.push(messages); return { data: { reply: '今天一起看云吧', emotion: 'happy', replyKind: 'chat' }, usage: { total_tokens: 12 } } } })
  assert.equal(ok.summary.completed, 6)
  assert.equal(ok.summary.tokens, 72)
  const blind = JSON.parse(await fs.readFile(path.join(ok.dir, 'blind-review.json')))
  assert.equal(blind.length, 2)
  assert.equal(blind[0].variants.length, 3)
  assert.doesNotMatch(JSON.stringify(blind), /"mode"/)
  assert.equal(calls.length, 6)
  const multiCalls = []
  const multi = await runEvaluation({ limit: 60, repeats: 1, outDir: path.join(dir, 'multi'), onProgress() {},
    complete: async messages => {
      const label = messages.some(x => x.content.includes('只读风格示例')) ? 'examples'
        : messages[0].content.includes('【派蒙的接话习惯】') ? 'rules' : 'off'
      multiCalls.push({ label, user: messages[1].content })
      return { data: { reply: `该模式自己的回答-${label}`, emotion: 'neutral', replyKind: 'chat',
        ...(messages[0].content.includes('【是否回应】') ? { shouldReply: true, reason: 'direct_address' } : {}) } }
    } })
  assert.equal(multi.summary.completed, 195)
  const secondTurns = multiCalls.filter(c => c.user.includes('该模式自己的回答-'))
  assert.equal(secondTurns.length, 15)
  for (const c of secondTurns) {
    assert.ok(c.user.includes(`该模式自己的回答-${c.label}`))
    for (const other of ['off', 'rules', 'examples'].filter(x => x !== c.label))
      assert.ok(!c.user.includes(`该模式自己的回答-${other}`))
  }
  let failedCalls = 0
  const failed = await runEvaluation({ limit: 60, repeats: 2, outDir: path.join(dir, 'failed'), onProgress() {},
    complete: async () => { failedCalls++; throw Object.assign(new Error('sensitive response text'), { code: 'http_401', status: 401 }) } })
  assert.ok(failedCalls <= 3)
  assert.equal(failed.summary.stopped, true)
  assert.doesNotMatch(JSON.stringify(failed.summary), /sensitive/)
})
