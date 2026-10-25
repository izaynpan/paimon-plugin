import { requestSafeMessage } from './history-provider.js'

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const games = [['gs', /原神|提瓦特/], ['sr', /星铁|星穹铁道|崩铁/], ['zzz', /绝区零/]]

// A narrow, complete request grammar. Conversation, quoted requests and explanations
// continue through the normal model path; no role or account comes from history.
export function parsePanelRequest(text, config = {}) {
  let body = String(text).trim()
  if (/^[#＃*＊%％]|不要|不用|别|取消|如果|假如|他说|她说|怎么|如何|是什么|[“”「」"`\n]/.test(body)) return null
  for (let i = 0; i < 3; i++) {
    body = body.replace(/^(?:好(?:的)?|嗯|那)[，,\s]+/, '')
    for (const name of config.trigger?.nicknames || ['派蒙', '派大王'])
      if (name) body = body.replace(new RegExp('^' + escape(name) + '[，,：:\\s]*'), '')
  }
  body = body.replace(/[。！!？?\s]+$/, '').replace(/(?:好吗|谢谢|吧|呀|啊|呗)$/, '').trim()
  // A nickname may itself contain a game name; only inspect the role/action
  // portion after the possessive marker when a target is present.
  const boundary = body.lastIndexOf('的') + 1
  const gameText = body.slice(boundary)
  const named = games.filter(([, re]) => re.test(gameText)).map(([game]) => game)
  if (named.length > 1) return null
  const game = named[0]
  body = (body.slice(0, boundary) + gameText.replace(/原神|提瓦特|星穹铁道|星铁|崩铁|绝区零/g, '')).trim()
  const prefix = '(?:(?:再|请|麻烦|帮我|给我|我想|我要|想|能不能|可以|能否|帮忙)\\s*)*'
  if (new RegExp('^' + prefix + '(?:米游社)?(?:更新|刷新|同步)(?:一下|下)?(?:我的)?面板$').test(body))
    return { kind: 'refresh', game }
  const match = new RegExp('^' + prefix + '(?:看看|看一下|看下|查看|看|查一下|查下|查|展示|调出|发一下|发下)?\\s*(.+?)的?面[板版]$').exec(body)
  if (!match || /[，,。！？!?；;]|更新|刷新|同步/.test(match[1])) return null
  let subject = match[1].trim().replace(/^(?:我(?:的)?|自己(?:的)?)/, '')
  let targetName = ''
  const own = subject.lastIndexOf('的')
  if (own >= 0) { targetName = subject.slice(0, own).trim(); subject = subject.slice(own + 1).trim() }
  if (!subject) return null
  return { kind: 'show', game, characterText: subject, targetName }
}

export class PanelTargets {
  constructor({ request = requestSafeMessage, now = Date.now } = {}) { this.request = request; this.now = now; this.cache = new Map() }
  async members(e) {
    const key = `${e.self_id}:${e.group_id}`, cached = this.cache.get(key)
    if (cached && this.now() - cached.at < 60000) return cached.rows
    let rows
    try {
      rows = await this.request(e, 'get_group_member_list', { group_id: e.group_id }, { timeoutMs: 1500 })
    } catch {
      const map = e.bot?.gml?.get(e.group_id) || e.bot?.gml?.get(Number(e.group_id))
      rows = map instanceof Map ? [...map.values()] : []
    }
    rows = Array.isArray(rows) ? rows.filter(row => row && /^\d+$/.test(String(row.user_id)) &&
      (row.group_id == null || String(row.group_id) === String(e.group_id))) : []
    if (rows.length) {
      this.cache.set(key, { at: this.now(), rows })
      while (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value)
    }
    return rows
  }
  async resolve(e, name = '') {
    const mentions = [...new Set((e.message || []).filter(m => m.type === 'at' && String(m.qq) !== String(e.self_id)).map(m => String(m.qq)))]
    if (!name && !mentions.length) return { status: 'self' }
    if (!e.isGroup || mentions.length > 1) return { status: 'ambiguous' }
    if (mentions.length === 1) {
      const segment = e.message.find(m => m.type === 'at' && String(m.qq) === mentions[0])
      if (!/^\d+$/.test(mentions[0]) || name && !['@' + (segment.name || segment.text || segment.qq), String(segment.name || ''), String(segment.text || '')].includes(name))
        return { status: 'ambiguous' }
      return { status: 'resolved', userId: mentions[0] }
    }
    const rows = await this.members(e)
    const ids = [...new Set(rows.filter(row => String(row.user_id) !== String(e.self_id) &&
      [row.card, row.nickname].some(n => typeof n === 'string' && n.trim() === name)).map(row => String(row.user_id)))]
    return ids.length === 1 ? { status: 'resolved', userId: ids[0] } : { status: ids.length ? 'ambiguous' : 'missing' }
  }
}
