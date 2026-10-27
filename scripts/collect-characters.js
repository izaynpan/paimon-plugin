import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractCharacter, toMarkdown, voiceReferences } from './collect-character.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const directoryUrl = 'https://act-api-takumi-static.mihoyo.com/common/blackboard/ys_obc/v1/home/content/list?app_sn=ys_obc&channel_id=189'
const detailUrl = 'https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page'

export function selectCharacters(response) {
  if (response?.retcode !== 0 || !Array.isArray(response.data?.list)) throw new Error('角色目录请求失败')
  const matches = []
  const walk = node => {
    if (String(node.id) === '25' && String(node.parent_id) === '189') matches.push(node)
    for (const child of node.children ?? []) walk(child)
  }
  response.data.list.forEach(walk)
  if (matches.length !== 1 || !matches[0].list?.length || matches[0].hidden) throw new Error('角色目录缺失、隐藏或不唯一')
  const included = [], excluded = [], ids = new Set()
  for (const row of matches[0].list) {
    const id = String(row.content_id), name = row.title?.trim()
    if (!/^\d+$/.test(id) || !name || ids.has(id)) throw new Error('目录存在无效或重复词条编号')
    ids.add(id)
    const item = { 词条编号: id, 目录名称: name }
    if (/预告/.test(name)) excluded.push({ ...item, 原因: '目录标题标记为预告，未请求角色详情' })
    else included.push(item)
  }
  return { included, excluded }
}

export async function main(args = process.argv.slice(2)) {
  const offline = args.includes('--offline')
  const flags = args.filter(a => a !== '--offline')
  const options = {}
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--out', '--cache'].includes(flags[i]) || !flags[i + 1] || options[flags[i]]) throw new Error('参数无效')
    options[flags[i]] = flags[i + 1]
  }
  const output = path.resolve(options['--out'] ?? path.join(root, 'knowledge/characters'))
  const cache = path.resolve(options['--cache'] ?? path.join(root, 'data/knowledge/character-collection'))
  await fs.mkdir(cache, { recursive: true })
  await fs.mkdir(output, { recursive: true })
  const read = async (key, url) => {
    const file = path.join(cache, `${key}.snapshot.json`)
    if (offline) return JSON.parse(await fs.readFile(file, 'utf8'))
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw = await response.text()
    const parsed = JSON.parse(raw)
    if (parsed.retcode !== 0) throw new Error(`接口错误：${parsed.retcode} ${parsed.message}`)
    const snapshot = { fetchedAt: new Date().toISOString(), raw }
    await fs.writeFile(file, JSON.stringify(snapshot), 'utf8')
    return snapshot
  }
  const directory = await read('directory', directoryUrl)
  const { included, excluded } = selectCharacters(JSON.parse(directory.raw))
  const report = { 目录页面: 'https://baike.mihoyo.com/ys/obc/channel/map/189/25',
    目录抓取时间: directory.fetchedAt, 筛选规则: '排除目录标题含“预告”的词条；按词条编号保留不同形态。',
    目录总数: included.length + excluded.length, 计划采集数: included.length, 排除: excluded, 成功: [], 失败: [] }
  console.log(`目录 ${report.目录总数}，排除预告 ${excluded.length}，采集 ${included.length}`)
  const supplementary = new Map()
  for (const [i, item] of included.entries()) {
    try {
      const id = item.词条编号
      const snapshot = await read(id, `${detailUrl}?entry_page_id=${id}&lang=zh-cn`)
      const response = JSON.parse(snapshot.raw)
      const supplements = []
      for (const ref of voiceReferences(response)) {
        if (!supplementary.has(ref.id)) {
          const s = await read(ref.id, `${detailUrl}?entry_page_id=${ref.id}&lang=zh-cn`)
          supplementary.set(ref.id, { response: JSON.parse(s.raw), fetchedAt: s.fetchedAt,
            rawHash: createHash('sha256').update(s.raw).digest('hex') })
        }
        supplements.push(supplementary.get(ref.id))
      }
      const data = extractCharacter(response, { id, fetchedAt: snapshot.fetchedAt, supplements,
        rawHash: createHash('sha256').update(snapshot.raw).digest('hex') })
      if (/预告/.test(data.角色)) throw new Error('详情名称出现预告标记，请检查目录状态')
      await fs.writeFile(path.join(output, `${id}.zh-CN.json`), JSON.stringify(data, null, 2) + '\n', 'utf8')
      await fs.writeFile(path.join(output, `${id}.zh-CN.md`), toMarkdown(data), 'utf8')
      report.成功.push({ ...item, 角色: data.角色, 页面版本: data.来源.页面版本, 抓取时间: data.来源.抓取时间,
        档案字段数: data.基础档案.length, 介绍数: data.角色介绍.length, 故事数: data.角色故事.length,
        台词数: data.语音台词.length, 他人评价数: data.人物关联.他人评价.length,
        邮件栏目数: data.生日邮件.length, 料理栏目数: data.特殊料理.length,
        采集提示: data.采集说明.slice(4) })
      console.log(`[${i + 1}/${included.length}] ${item.目录名称}：${data.语音台词.length} 条台词`)
    } catch (error) {
      report.失败.push({ ...item, 原因: error.message })
      console.log(`[${i + 1}/${included.length}] ${item.目录名称}：失败 ${error.message}`)
    }
    if (!offline) await delay(250)
  }
  await fs.writeFile(path.join(output, 'collection-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  const lines = ['# 中文角色资料目录', '', `目录词条 ${report.目录总数} 个；排除预告 ${excluded.length} 个；成功 ${report.成功.length} 个；失败 ${report.失败.length} 个。`, '',
    `目录来源：[观测枢角色目录](${report.目录页面})`, '',
    '按词条编号区分同名角色及旅行者元素／性别版本。每份资料同时提供同名 JSON。仅采集约定的七类中文文本，尚未接入活动检索索引。', '',
    '## 已采集', '', '| 角色／词条编号 | 故事 | 台词 | 邮件栏目 |', '| --- | ---: | ---: | ---: |',
    ...report.成功.map(r => `| [${r.目录名称}（${r.词条编号}）](${r.词条编号}.zh-CN.md) | ${r.故事数} | ${r.台词数} | ${r.邮件栏目数} |`), '',
    '## 排除的预告词条', '', ...excluded.map(r => `- ${r.目录名称}（${r.词条编号}）`), '',
    '## 失败与待检查', '', ...report.失败.map(r => `- ${r.目录名称}（${r.词条编号}）：${r.原因}`)]
  if (!report.失败.length) lines.push('无失败词条。各角色页面未收录的栏目及源数据异常见采集说明与 collection-report.json。')
  await fs.writeFile(path.join(output, 'CATALOG.md'), lines.join('\n') + '\n', 'utf8')
  console.log(`完成：成功 ${report.成功.length}，失败 ${report.失败.length}，排除 ${excluded.length}`)
  if (report.失败.length) process.exitCode = 1
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
