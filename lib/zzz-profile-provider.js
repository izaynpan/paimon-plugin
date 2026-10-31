import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { number, label, freeze, silentProfileEvent, imageReplyEvent } from './profile-values.js'

// ZZZ values already carry their display unit. Parse only a complete numeric
// string; never guess that 0.5 means 50%, or use parseFloat on arbitrary text.
export function zzzStat(property, field = 'final') {
  const raw = property?.[field]
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^[+-]?\d+(?:\.\d+)?%?$/.test(text)) return null
  const value = Number(text.replace('%', ''))
  if (!Number.isFinite(value)) return null
  const name = label(property.property_name)
  return { key: String(property.property_id), name, value, unit: text.endsWith('%') ? 'percent_points'
    : /能量自动回复|闪能自动累积|锐能自动累积/.test(name) ? 'per_second' : 'points' }
}

export function zzzProfileFacts(profile, character, propertyName, scored = true) {
  const equips = Array.isArray(profile.equip) ? profile.equip : profile.equip ? [profile.equip] : []
  const hasScore = scored && profile.scoreWeight && equips.length > 0 && equips.every(e => number(e.score) !== null)
  return freeze({ game: 'zzz', character, level: number(profile.level), constellation: number(profile.rank),
    element: label(profile.element_str), profession: number(profile.avatar_profession),
    weapon: { name: label(profile.weapon?.name), level: number(profile.weapon?.level), refinement: number(profile.weapon?.star) },
    talents: (profile.skills || []).slice(0, 12).map(s => ({ type: number(s.skill_type), level: number(s.level) })),
    attributes: (profile.properties || []).map(p => zzzStat(p)).filter(Boolean),
    baseAttributes: (profile.properties || []).map(p => zzzStat(p, 'base')).filter(Boolean),
    artifacts: equips.slice(0, 6).map(e => ({ position: number(e.equipment_type), name: label(e.name), level: number(e.level),
      rarity: label(e.rarity), set: label(e.equip_suit?.name),
      main: (e.main_properties || []).map(p => zzzStat(p, 'base')).filter(Boolean),
      substats: (e.properties || []).map(p => zzzStat(p, 'base')).filter(Boolean),
      score: hasScore ? number(e.score) : null, grade: hasScore ? label(e.comment) : '' })),
    score: hasScore ? { total: number(profile.equip_score), grade: label(profile.equip_comment), rule: label(profile.weightRule),
      weights: Object.entries(profile.scoreWeight).filter(([id, v]) => /^\d{1,6}$/.test(id) && number(v) !== null)
        .map(([id, weight]) => ({ key: id, name: label(propertyName(id)), weight })) } : null,
    // The current ZZZ panel file is an array without per-role time/source.
    // File mtime can be changed by another role, and is not evidence of freshness.
    updatedAt: null, source: 'ZZZ-Plugin 本地面板（原记录未提供角色更新时间和来源）',
    conditions: '装备属性快照；队伍、敌人、战斗触发增益与操作未知。驱动盘评分不是伤害提升百分比；未知时间不得宣称实时。' })
}

export class ZzzProfileProvider {
  constructor({ bridge, readFile = fs.readFile } = {}) { this.bridge = bridge; this.readFile = readFile }
  async modules() {
    const load = file => this.bridge.importModule(pathToFileURL(path.join(this.bridge.root, 'plugins/ZZZ-Plugin/dist', file)).href)
    const [avatar, convert, property, settings] = await Promise.all([
      load('lib/avatar.js'), load('lib/convert.js'), load('lib/convert/property.js'), load('lib/settings.js'),
    ])
    return { format: avatar.formatPanelData, char: convert.char, propertyName: property.idToName, settings: settings.default }
  }
  async read({ e, request, capability, allowed }) {
    if (capability.id !== 'zzz.panel.show' || request.game !== 'zzz') return { status: 'unsupported' }
    let snapshot, reason = 'unavailable'
    const result = await this.bridge.execute({ capability, args: { character: request.character },
      original: silentProfileEvent(e), targetUserId: request.targetUserId, allowed,
      profileHook: { readOnly: true, run: async (event, instance) => {
        const { format, char, propertyName, settings } = await this.modules()
        if (request.targetUserId && settings.getConfig('config')?.query?.others === false) { reason = 'target_disabled'; return }
        const roleId = char.aliasToId(request.character)
        if (!roleId) { reason = 'unsupported'; return }
        if (typeof instance.getUID !== 'function' || typeof format !== 'function') return
        let uid
        const sender = event.user_id
        try { uid = await instance.getUID() } catch { reason = 'unbound'; return }
        finally { event.user_id = sender } // Native getUID switches it for @ queries; retain permission identity.
        if (!/^\d{1,12}$/.test(String(uid))) { reason = 'unbound'; return }
        if (!(await allowed())) return
        let rows
        try {
          const data = await this.readFile(path.join(this.bridge.root, 'plugins/ZZZ-Plugin/data/panel', String(uid) + '.json'), 'utf8')
          if (data.length > 8 * 1024 * 1024) throw new Error('profile too large')
          rows = JSON.parse(data)
        } catch (error) { reason = error.code === 'ENOENT' ? 'missing' : 'unavailable'; return }
        const raw = Array.isArray(rows) && rows.find(row => String(row.id) === String(roleId))
        if (!raw || !Array.isArray(raw.properties) || !raw.properties.length) { reason = 'missing'; return }
        let profile = null
        // formatPanelData constructs the native Avatar, chooses its dynamic
        // weights and calls each Equip.get_score. No copied scoring formulas.
        try { profile = format(structuredClone(raw)) } catch { /* Raw numeric facts can still support limited advice. */ }
        const facts = zzzProfileFacts(profile || raw, request.character, propertyName, !!profile)
        snapshot = { profile, uid, facts, authorized: () => !request.targetUserId || settings.getConfig('config')?.query?.others !== false }
        reason = 'ready'
      } } })
    if (!(await allowed()) || ['cancelled', 'context_busy', 'timeout'].includes(result.status)) return { status: result.status === 'context_busy' ? result.status : 'cancelled' }
    if (result.status === 'failed') return { status: reason === 'ready' ? 'unavailable' : reason }
    if (snapshot && !snapshot.authorized()) return { status: 'target_disabled' }
    return snapshot ? { status: 'ready', snapshot } : { status: reason }
  }
  async render({ e, request, capability, snapshot, allowed, onReply }) {
    if (!snapshot.profile) return { status: 'unavailable' }
    return this.bridge.execute({ capability, args: { character: request.character }, original: imageReplyEvent(e, onReply),
      targetUserId: request.targetUserId, allowed, profileHook: { readOnly: true, run: async (event, instance) => {
        const { settings } = await this.modules()
        if (request.targetUserId && settings.getConfig('config')?.query?.others === false) return
        if (!(await allowed())) return
        await snapshot.profile.get_detail_assets()
        if (!(await allowed()) || request.targetUserId && settings.getConfig('config')?.query?.others === false) return
        // Use the real plugin's renderer/template with the already scored object.
        // getCharPanelTool would reconstruct/reread and start a preamble timer.
        const image = await instance.render('panel/card.html', { uid: snapshot.uid, charData: snapshot.profile }, { retType: 'base64' })
        if (image && await allowed() && (!request.targetUserId || settings.getConfig('config')?.query?.others !== false)) await event.reply(image)
      } } })
  }
}
