import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const label = value => typeof value === 'string' ? value.slice(0, 80) : ''
const flat = new Set(['hp', 'atk', 'def', 'hpBase', 'atkBase', 'defBase', 'hpPlus', 'atkPlus', 'defPlus', 'mastery'])
const attrKeys = new Set([...flat, 'hpPct', 'atkPct', 'defPct', 'cpct', 'cdmg', 'recharge', 'heal', 'dmg', 'phy', 'pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo'])
const stat = (key, value) => attrKeys.has(key) && number(value) !== null
  ? { key, value, unit: flat.has(key) ? 'points' : 'percent_points' } : null
const stats = source => Object.entries(source || {}).map(([key, value]) => stat(key, value)).filter(Boolean)
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

// Whitelist primitive facts, never serialize an Avatar/Player or account record.
// Percent values here are Miao percentage points (e.g. recharge 160 = 160%).
export function profileFacts(profile, score) {
  const artifacts = []
  profile.artis.forEach((arti, pos) => {
    const marked = score?.artis?.[pos]
    artifacts.push({ position: Number(pos), name: label(marked?.name || arti.name),
      set: label(marked?.set || arti.set), level: number(arti.level), rarity: number(arti.star),
      main: stat(arti.main?.key, arti.main?.value),
      substats: Object.values(arti.attrs || {}).map(a => stat(a.key, a.value)).filter(Boolean),
      score: number(marked?._mark), grade: label(marked?.markClass), maxScore: number(marked?.pMax) })
  })
  const timestamp = typeof profile._time === 'number' || typeof profile._time === 'string' ? new Date(profile._time) : null
  const updatedAt = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
  return freeze({ game: 'gs', character: label(profile.name), level: number(profile.level), constellation: number(profile.cons),
    talents: Object.fromEntries(['a', 'e', 'q'].map(key => [key, {
      original: number(profile.talent?.[key]?.original), level: number(profile.talent?.[key]?.level) }])),
    weapon: { name: label(profile.weapon?.name), level: number(profile.weapon?.level), refinement: number(profile.weapon?.affix) },
    attributes: stats(profile.attr), baseAttributes: stats(profile.base), artifacts,
    score: score ? { total: number(score._mark), grade: label(score.markClass), rule: label(score.classTitle),
      weights: Object.fromEntries(Object.entries(score.charWeight || {}).filter(([key, v]) => attrKeys.has(key) && number(v) !== null)) } : null,
    updatedAt, source: ({ enka: 'Enka.Network', miao: '喵喵Api', mgg: 'MiniGG-Api', hutao: 'Hutao-Enka', mys: '米游社',
      customize: '预设面板', share: '外部导入' })[profile._source] || '未知',
    conditions: '静态面板；队伍、循环、敌人、实战层数与临时增益未确认。评分是喵喵圣遗物规则，不是伤害提升百分比。' })
}

export class MiaoProfileProvider {
  constructor({ bridge, readFile = fs.readFile } = {}) { this.bridge = bridge; this.readFile = readFile }
  async modules() {
    const load = file => this.bridge.importModule(pathToFileURL(path.join(this.bridge.root, 'plugins/miao-plugin', file)).href)
    const [avatar, character, common, uid] = await Promise.all([
      load('models/Avatar.js'), load('models/Character.js'), load('components/Common.js'), load('apps/profile/ProfileCommon.js'),
    ])
    return { Avatar: avatar.default, Character: character.default, Common: common.default, getTargetUid: uid.getTargetUid }
  }
  async read({ e, request, capability, allowed }) {
    let snapshot, reason = 'unavailable'
    // Use the real dispatcher for fresh identity/runtime and permission checks.
    // Reading is silent, and never runs a refresh or a Player.save()/reload().
    const silent = { ...e, reply: async () => false }
    if (e.group) silent.group = new Proxy(e.group, { get: (obj, key) => /^send/.test(String(key)) ? async () => false
      : typeof obj[key] === 'function' ? obj[key].bind(obj) : obj[key] })
    if (e.friend) silent.friend = new Proxy(e.friend, { get: (obj, key) => /^send/.test(String(key)) ? async () => false
      : typeof obj[key] === 'function' ? obj[key].bind(obj) : obj[key] })
    const result = await this.bridge.execute({ capability, args: { character: request.character }, original: silent,
      targetUserId: request.targetUserId, allowed, profileHook: { readOnly: true, run: async event => {
        const { Avatar, Character, Common, getTargetUid } = await this.modules()
        if (!Common.cfg('avatarProfile')) { reason = 'disabled'; return }
        const char = Character.get(request.character, 'gs')
        if (!char || char.game !== 'gs' || char.isCustom || !char.isRelease) { reason = 'unsupported'; return }
        const uid = await getTargetUid(event)
        if (!uid || !/^\d{9,10}$/.test(String(uid))) { reason = 'unbound'; return }
        if (!(await allowed())) return
        let saved
        try {
          const data = await this.readFile(path.join(this.bridge.root, 'data/PlayerData/gs', String(uid) + '.json'), 'utf8')
          if (data.length > 8 * 1024 * 1024) throw new Error('profile too large')
          saved = JSON.parse(data)
        } catch (error) { reason = error.code === 'ENOENT' ? 'missing' : 'unavailable'; return }
        let raw = Object.values(saved.avatars || {}).find(a => String(a.id) === String(char.id))
        if (char.isTraveler) raw = saved.avatars?.['10000005'] || saved.avatars?.['10000007']
        if (!raw) { reason = 'missing'; return }
        const profile = new Avatar(structuredClone(raw), 'gs')
        if (!profile.isProfile) { reason = 'missing'; return }
        // Pin UID only on the task-private object used by the native renderer.
        profile.uid = uid
        let score = null
        try { score = profile.getArtisMark(true) || null } catch { /* Limited advice without a score. */ }
        snapshot = { profile, uid, facts: profileFacts(profile, score) }
        reason = 'ready'
      } } })
    if (!(await allowed())) return { status: 'cancelled' }
    if (['context_busy', 'cancelled', 'timeout', 'failed'].includes(result.status))
      return { status: result.status === 'failed' ? reason === 'ready' ? 'unavailable' : reason : result.status }
    return snapshot ? { status: 'ready', snapshot } : { status: reason }
  }
  async render({ e, request, capability, snapshot, allowed, onReply }) {
    const isImage = value => Array.isArray(value) ? value.some(isImage) : value?.type === 'image' ||
      typeof value === 'string' && /^(?:base64:\/\/|\[CQ:image,)/.test(value)
    const original = { ...e, reply: async (...values) => {
      const result = await e.reply(...values)
      if (isImage(values[0]) && result !== false && result !== null && !result?.error) onReply?.(result)
      return result
    } }
    return this.bridge.execute({ capability, args: { character: request.character }, original,
      targetUserId: request.targetUserId, allowed,
      profileHook: { run: async event => {
        // Native ProfileDetail consumes _profile and skips auto-refresh/ranking.
        event._profile = snapshot.profile
        event.uid = snapshot.uid
      } } })
  }
}
