import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { number, label, freeze, silentProfileEvent, imageReplyEvent } from './profile-values.js'
import { buildGames } from './build-games.js'

const flat = new Set(['hp', 'atk', 'def', 'hpBase', 'atkBase', 'defBase', 'hpPlus', 'atkPlus', 'defPlus', 'mastery', 'speed', 'speedBase', 'speedPlus'])
const attrKeys = new Set([...flat, 'hpPct', 'atkPct', 'defPct', 'speedPct', 'cpct', 'cdmg', 'recharge', 'heal', 'dmg', 'phy',
  'pyro', 'hydro', 'anemo', 'electro', 'dendro', 'cryo', 'geo', 'physical', 'fire', 'ice', 'wind', 'lightning', 'quantum', 'imaginary',
  'stance', 'effPct', 'effDef', 'joy', 'shield', 'coloringDmg'])
const statNames = { hp: '生命值', atk: '攻击力', def: '防御力', hpBase: '基础生命值', atkBase: '基础攻击力', defBase: '基础防御力',
  hpPlus: '固定生命值（小生命）', atkPlus: '固定攻击力（小攻击）', defPlus: '固定防御力（小防御）',
  hpPct: '生命值百分比（大生命）', atkPct: '攻击力百分比（大攻击）', defPct: '防御力百分比（大防御）',
  cpct: '暴击率', cdmg: '暴击伤害', mastery: '元素精通', recharge: '能量恢复效率', heal: '治疗加成', dmg: '伤害加成', phy: '物理伤害加成',
  speed: '速度', speedBase: '基础速度', speedPlus: '固定速度', speedPct: '速度百分比', stance: '击破特攻', effPct: '效果命中', effDef: '效果抵抗', joy: '愉悦度',
  pyro: '火元素伤害加成', hydro: '水元素伤害加成', anemo: '风元素伤害加成', electro: '雷元素伤害加成', dendro: '草元素伤害加成', cryo: '冰元素伤害加成', geo: '岩元素伤害加成',
  physical: '物理伤害加成', fire: '火属性伤害加成', ice: '冰属性伤害加成', wind: '风属性伤害加成', lightning: '雷属性伤害加成', quantum: '量子属性伤害加成', imaginary: '虚数属性伤害加成' }
const slots = { gs: ['生之花（花）', '死之羽（羽毛）', '时之沙（沙漏）', '空之杯（杯子）', '理之冠（头冠）'],
  sr: ['头部', '手部', '躯干', '脚部', '位面球', '连结绳'] }
const stat = (key, value, equipment = false) => attrKeys.has(key) && number(value) !== null
  ? { key, name: statNames[equipment && ['hp', 'atk', 'def'].includes(key) ? key + 'Pct' : key] || key,
    value, unit: flat.has(key) && !(equipment && ['hp', 'atk', 'def'].includes(key)) ? 'points' : 'percent_points' } : null
const stats = source => Object.entries(source || {}).map(([key, value]) => stat(key, value)).filter(Boolean)

// Only the equipped sets' public descriptions leave this adapter. Do not infer
// combat stacks from a met piece requirement, or invent tiers for unknown sets.
export function equippedSetFacts(artifacts, metadata = {}) {
  const counts = new Map()
  for (const arti of artifacts) if (arti.set) counts.set(arti.set, (counts.get(arti.set) || 0) + 1)
  return [...counts].map(([name, pieces]) => {
    const entry = Object.values(metadata || {}).find(row => row?.name === name)
    const rawEffects = entry?.skills || entry?.effect || entry?.skill
    const effects = Object.entries(rawEffects && typeof rawEffects === 'object' && !Array.isArray(rawEffects) ? rawEffects : {})
      .filter(([count, text]) => /^[1-6]$/.test(count) && typeof text === 'string' && text.trim())
      .map(([count, text]) => ({ requiredPieces: Number(count), pieceRequirementMet: pieces >= Number(count),
        description: text.replace(/<[^>]*>/g, '').slice(0, 1600) })).sort((a, b) => a.requiredPieces - b.requiredPieces)
    return { name, equippedPieces: pieces, effects, allPieceRequirementsMet: effects.length ? effects.every(e => e.pieceRequirementMet) : null,
      source: effects.length ? 'miao-plugin 本地套装资料' : '套装效果资料缺失，不能推断已触发的效果' }
  })
}

// Whitelist primitive facts, never serialize an Avatar/Player or account record.
// Percent values here are Miao percentage points (e.g. recharge 160 = 160%).
export function profileFacts(profile, score, setMetadata = {}) {
  const game = profile.game === 'sr' ? 'sr' : 'gs'
  const artifacts = []
  profile.artis.forEach((arti, pos) => {
    const marked = score?.artis?.[pos]
    artifacts.push({ position: Number(pos), slot: slots[game][Number(pos) - 1] || '未知部位', name: label(arti.name || marked?.name),
      set: label(arti.set || marked?.set), level: number(arti.level), rarity: number(arti.star),
      main: stat(arti.main?.key, arti.main?.value, true),
      substats: Object.values(arti.attrs || {}).map(a => stat(a.key, a.value, true)).filter(Boolean),
      score: number(marked?._mark), grade: label(marked?.markClass), maxScore: number(marked?.pMax) })
  })
  const timestamp = typeof profile._time === 'number' || typeof profile._time === 'string' ? new Date(profile._time) : null
  const updatedAt = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null
  return freeze({ game, character: label(profile.name), element: label(profile.elem || profile.char?.elem),
    level: number(profile.level), constellation: number(profile.cons),
    talents: Object.fromEntries((game === 'sr' ? ['a', 'e', 'q', 't', 'xe', 'me', 'mt'] : ['a', 'e', 'q']).map(key => [key, {
      original: number(profile.talent?.[key]?.original), level: number(profile.talent?.[key]?.level) }])),
    ...(game === 'sr' ? { unlockedTraceIds: (profile.trees || []).filter(id => /^\d{1,12}$/.test(String(id))).map(String).slice(0, 100) } : {}),
    weapon: { name: label(profile.weapon?.name), level: number(profile.weapon?.level), refinement: number(profile.weapon?.affix) },
    attributes: stats(profile.attr), baseAttributes: stats(profile.base), artifacts, equippedSets: equippedSetFacts(artifacts, setMetadata),
    attributeBasis: profile.attr?._calc === true ? { kind: 'miao_static', teamResonanceIncluded: false } : { kind: 'unknown' },
    score: score ? { total: number(score._mark), grade: label(score.markClass), rule: label(score.classTitle),
      weights: Object.fromEntries(Object.entries(score.charWeight || {}).filter(([key, v]) => attrKeys.has(key) && number(v) !== null)) } : null,
    updatedAt, source: ({ enka: 'Enka.Network', miao: '喵喵Api', mgg: 'MiniGG-Api', hutao: 'Hutao-Enka', mys: '米游社',
      homo: 'Mihomo', customize: '预设面板', share: '外部导入' })[profile._source] || '未知',
    conditions: `静态面板；队伍、循环、敌人、实战层数与临时增益未确认。评分是喵喵${buildGames[game].equipment}规则，不是伤害提升百分比。` })
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
    const game = request.game || capability.game
    if (!['gs', 'sr'].includes(game) || capability.game !== game) return { status: 'unsupported' }
    let snapshot, reason = 'unavailable'
    // Use the real dispatcher for fresh identity/runtime and permission checks.
    // Reading is silent, and never runs a refresh or a Player.save()/reload().
    const silent = silentProfileEvent(e)
    const result = await this.bridge.execute({ capability, args: { character: request.character }, original: silent,
      targetUserId: request.targetUserId, allowed, profileHook: { readOnly: true, run: async event => {
        const { Avatar, Character, Common, getTargetUid } = await this.modules()
        if (!Common.cfg('avatarProfile')) { reason = 'disabled'; return }
        const char = Character.get(request.character, game)
        if (!char || char.game !== game || char.isCustom || !char.isRelease) { reason = 'unsupported'; return }
        const uid = await getTargetUid(event)
        if (!uid || !/^\d{9,10}$/.test(String(uid))) { reason = 'unbound'; return }
        if (!(await allowed())) return
        let saved
        try {
          const data = await this.readFile(path.join(this.bridge.root, 'data/PlayerData', game, String(uid) + '.json'), 'utf8')
          if (data.length > 8 * 1024 * 1024) throw new Error('profile too large')
          saved = JSON.parse(data)
        } catch (error) { reason = error.code === 'ENOENT' ? 'missing' : 'unavailable'; return }
        let raw = Object.values(saved.avatars || {}).find(a => String(a.id) === String(char.id))
        if (game === 'gs' && char.isTraveler) raw = saved.avatars?.['10000005'] || saved.avatars?.['10000007']
        // Match the current Miao character's gender pair, never borrow a different Path.
        if (!raw && game === 'sr' && char.isTrailblazer && Number(char.id) >= 8001 && Number(char.id) <= 8018) {
          const pair = Number(char.id) % 2 ? Number(char.id) + 1 : Number(char.id) - 1
          raw = saved.avatars?.[pair]
        }
        if (!raw) { reason = 'missing'; return }
        const profile = new Avatar(structuredClone(raw), game)
        if (!profile.isProfile) { reason = 'missing'; return }
        // Pin UID only on the task-private object used by the native renderer.
        profile.uid = uid
        let score = null
        try { score = profile.getArtisMark(true) || null } catch { /* Limited advice without a score. */ }
        let setMetadata = {}
        try {
          const data = await this.readFile(path.join(this.bridge.root, `plugins/miao-plugin/resources/meta-${game}/artifact/data.json`), 'utf8')
          if (data.length <= 8 * 1024 * 1024) setMetadata = JSON.parse(data)
        } catch { /* Missing public rules must not prevent reading the actual equipment. */ }
        snapshot = { profile, uid, facts: profileFacts(profile, score, setMetadata) }
        reason = 'ready'
      } } })
    if (!(await allowed())) return { status: 'cancelled' }
    if (['context_busy', 'cancelled', 'timeout', 'failed'].includes(result.status))
      return { status: result.status === 'failed' ? reason === 'ready' ? 'unavailable' : reason : result.status }
    return snapshot ? { status: 'ready', snapshot } : { status: reason }
  }
  async render({ e, request, capability, snapshot, allowed, onReply }) {
    const original = imageReplyEvent(e, onReply)
    return this.bridge.execute({ capability, args: { character: request.character }, original,
      targetUserId: request.targetUserId, allowed,
      profileHook: { run: async event => {
        // Native ProfileDetail consumes _profile and skips auto-refresh/ranking.
        event._profile = snapshot.profile
        event.uid = snapshot.uid
      } } })
  }
}
