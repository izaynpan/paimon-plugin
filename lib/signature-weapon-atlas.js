import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandCatalog, commandOptions } from './command-catalog.js'
import { extractText } from './trigger.js'
import { webSearchOptions } from './web-search.js'

// Only resolved public character and equipment names can enter native commands.
const games = {
  gs: { row: 'B05', title: '武器', searchGame: '原神', searchItem: '专属武器', official: ['ys.mihoyo.com', 'genshin.hoyoverse.com'] },
  sr: { row: 'E05', title: '光锥', searchGame: '崩坏星穹铁道', searchItem: '专属五星光锥', official: ['sr.mihoyo.com', 'hsr.hoyoverse.com'] },
}
const gsTypes = { sword: '单手剑', claymore: '双手剑', polearm: '长柄武器', catalyst: '法器', bow: '弓' }
const secondaryStats = { atkPct: '攻击力', hpPct: '生命值', defPct: '防御力', cpct: '暴击率', cdmg: '暴击伤害',
  mastery: '元素精通', recharge: '元素充能效率', phy: '物理伤害加成' }
const nativePlugins = ['Atlas', 'xiaoyao-cvs-plugin']
const gsItemWiki = commandCatalog.find(c => c.id === 'gs.item.wiki')
const safeName = name => typeof name === 'string' && name.length > 0 && name.length <= 40 &&
  !/[#*%<>/\\\r\n]/.test(name) && !['.', '..'].includes(name)
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const json = async file => { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return {} } }

function parse(input, config) {
  let text = input.trim()
  for (const name of config.trigger?.nicknames || ['派蒙']) {
    if (name && text.startsWith(name)) { text = text.slice(name.length).replace(/^[，,！!：:\s]+/, ''); break }
  }
  if (/[#＊*%＃％@\n]|别看|不要看|如果|假设|比如|他说|怎么查|如何查|攻略|推荐/.test(text)) return
  const forbid = /(?:不要|别|不用)(?:联网|上网|搜索)/.test(text)
  text = text.replace(/(?:不要|别|不用)(?:联网|上网|搜索)[，,\s]*/g, '').replace(/[，,。？！!?\s]+$/g, '')
  const gamePrefix = /^(原神|崩坏星穹铁道|星穹铁道|星铁|崩铁)[，,\s]*/
  const firstGame = gamePrefix.exec(text)?.[1]
  text = text.replace(gamePrefix, '')
  const action = /^(?:我想|我要|请|麻烦)?(?:帮我|给我)?(?:看看|看一看|看一下|看下|看|查一下|查下|查|发一下|发下|发一张|发个)\s*/
  const object = text.replace(action, '')
  const view = /^(.+?)(?:的)?图鉴(?:吧|呗|吗)?$/.exec(object) ||
    /^(.+(?:专武|专属武器|专属光锥|专锥))(?:吧|呗)?$/.exec(object)
  const ask = /^(?:我想知道|请问|问一下)?(.+?)(?:的)?(?:专武|专属武器|专属光锥|专锥)(?:叫(?:什么|啥)(?:名字)?|是(?:什么|啥|哪(?:一)?(?:个|张|把))(?:武器|光锥)?)(?:呀|啊|呢|来着)?$/.exec(text)
  if (!view && !ask) return
  const raw = ask?.[1] ?? view[1]
  const innerGame = gamePrefix.exec(raw)?.[1]
  const explicit = innerGame || firstGame
  if (innerGame && firstGame && (innerGame === '原神') !== (firstGame === '原神')) return
  let game
  if (explicit) game = explicit === '原神' ? 'gs' : 'sr'
  else if (/光锥|专锥/.test(text)) game = 'sr'
  const subject = raw.replace(gamePrefix, '').replace(/^[「《]|[」》]$/g, '')
  const role = ask ? subject : /^(.*?)(?:的)?(?:专武|专属武器|专属光锥|专锥)$/.exec(subject)?.[1]
  if (role === undefined && !safeName(subject)) return
  return { mode: ask ? 'identify' : 'image', game, role, subject, forbid,
    reference: /^(?:这|那)(?:把武器|张光锥|个光锥)$/.test(subject) ||
      role !== undefined && /^(?:这|那)(?:个|把|张)?$|^(?:她|他|它|刚才说的|刚才那个|刚刚那个|)$/.test(role) }
}

// Require an explicit role/weapon relation, not co-occurrence in a build guide.
// Use an explicit official attribution or agreement across distinct sites.
export function signatureEvidence(game, character, weapons, sources) {
  const votes = new Map()
  for (const source of sources) {
    let host
    try { host = new URL(source.url).hostname.replace(/^www\./, '') } catch { continue }
    for (const field of [source.title, source.content].filter(v => typeof v === 'string')
      .flatMap(v => v.match(/[^。！？!?\n]+[。！？!?]?/g) || [])) {
      if (!field?.includes(character)) continue
      if (/[?？]|并非|不是|并不是|并不叫|误传|辟谣|假设|如果/.test(field)) continue
      for (const name of weapons) {
        if (!safeName(name) || !field.includes(name)) continue
        const role = escape(character), cone = escape(name)
        const relation = game === 'gs' ? '(?:专武|专属(?:五星)?武器)' : '(?:专武|专属光锥|专锥|专属五星光锥)'
        const item = game === 'gs' ? '(?:限定)?五星(?:武器|单手剑|双手剑|弓|法器|长柄武器)|武器' : '(?:限定)?五星光锥|光锥'
        const link = '(?:的|' + item + '|是|为|名为|叫作|叫|即|[\\s「」《》“”：:·—-])*'
        if (![role + '\\s*的?\\s*' + relation + link + cone, cone + link + role + '的?' + relation]
          .some(pattern => new RegExp(pattern).test(field))) continue
        if (!votes.has(name)) votes.set(name, new Set())
        // Keep subdomains of the same publisher together.
        const parts = host.split('.')
        const suffixLength = /\.(?:com\.cn|co\.uk|com\.tw|com\.hk)$/.test(host) ? 3 : 2
        const official = games[game].official.includes(host)
        votes.get(name).add(official ? 'official' : parts.slice(-suffixLength).join('.'))
      }
    }
  }
  if (votes.size !== 1) return { conflict: votes.size > 1 }
  const [[name, sites]] = votes
  return { name: sites.has('official') || sites.size >= 2 ? name : null }
}

function plain(value) {
  return String(value || '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').trim()
}

async function weaponEntries(root, game) {
  const dir = path.join(root, 'plugins/miao-plugin/resources', 'meta-' + game, 'weapon')
  if (game === 'sr') return Object.values(await json(path.join(dir, 'data.json')))
  const groups = await Promise.all(Object.keys(gsTypes).map(async type =>
    Object.values(await json(path.join(dir, type, 'data.json'))).map(item => ({ ...item, type }))))
  return groups.flat()
}

export async function weaponCard(root, game, entry) {
  if (!safeName(entry?.name) || !safeName(entry.type)) return null
  const dir = path.join(root, 'plugins/miao-plugin/resources', 'meta-' + game, 'weapon', entry.type, entry.name)
  const data = await json(path.join(dir, 'data.json'))
  if (data.name !== entry.name) return null
  if (game === 'gs') {
    const attack = data.attr?.atk?.[90], bonus = data.attr?.bonusKey
    if (!Number.isFinite(attack) || !gsTypes[entry.type]) return null
    const stats = [{ label: '基础攻击力', value: Math.round(attack) }]
    const value = data.attr.bonusData?.[90]
    if (secondaryStats[bonus] && Number.isFinite(value)) stats.push({ label: secondaryStats[bonus],
      value: bonus === 'mastery' ? Math.round(value) : Number(value.toFixed(1)) + '%' })
    const skill = plain(data.affixData?.text).replace(/\$\[(\d+)\]/g, (_, index) =>
      data.affixData.datas?.[index]?.join(' / ') || '？')
    for (const file of ['gacha.webp', 'icon.webp']) {
      const art = path.join(dir, file)
      try { await fs.access(art) } catch { continue }
      return { name: data.name, type: gsTypes[entry.type], star: data.star, stats, skill, skillName: data.affixTitle,
        category: '武器', level: 90, refinement: '精炼 1 至 5 阶', art: pathToFileURL(art).href, saveId: 'weapon-' + data.id }
    }
    return null
  }
  if (data.type !== entry.type || !data.skill?.desc) return null
  const stats = [['hp', '生命值'], ['atk', '攻击力'], ['def', '防御力']].map(([key, label]) =>
    ({ label, value: Math.round(data.baseAttr?.[key]) }))
  if (stats.some(stat => !Number.isFinite(stat.value))) return null
  const skill = plain(data.skill.desc).replace(/\$(\d+)\[(i|f\d*)\]/g, (_, index) =>
    data.skill.tables?.[index]?.join(' / ') || '？')
  const art = path.join(dir, 'splash.webp')
  try { await fs.access(art) } catch { return null }
  return { name: entry.name, type: entry.type, star: data.star, stats, skill, skillName: data.skill.name,
    category: '光锥', level: 80, refinement: '叠影 1 至 5 阶', art: pathToFileURL(art).href, saveId: 'cone-' + String(data.id).replace(/\D/g, '') }
}

export class SignatureWeaponAtlas {
  constructor(commands) { this.commands = commands }

  async select(messages, events, session, config) {
    const options = commandOptions(config)
    if (!options.enabled || !options.invoke || Object.values(games).every(g => options.disabledRows.includes(g.row))) return
    const current = messages.map((m, i) => ({ m, e: events[i] })).filter(({ m, e }) => e &&
      !m.preTrigger && m.origin !== 'pre_trigger' && m.source !== 'history' && String(m.userId) === String(e.user_id) &&
      (m.messageId == null || String(e.message_id) === String(m.messageId)))
    if (!current.length || new Set(current.map(({ m }) => m.userId)).size > 1) return
    const { m, e } = current.at(-1)
    const query = parse(extractText(e), config)
    if (!query || !this.commands.enabled(e, config) || e.message?.some(v => v.type === 'at' && String(v.qq) !== String(e.self_id))) return
    const entities = this.commands.entities
    if (query.reference) {
      const previous = current.at(-2)
      const earlier = previous && parse(extractText(previous.e), config)
      const prior = !previous && session.sessionBatches?.findLast(b =>
        b.messages?.some(msg => String(msg.userId) === String(m.userId) && !msg.preTrigger))
      const context = prior?.signatureWeapon
      if (earlier?.role && !earlier.reference && (!query.game || !earlier.game || query.game === earlier.game)) {
        query.role = earlier.role; query.game ||= earlier.game; query.forbid ||= earlier.forbid
      } else if (context && context.userId === String(m.userId) && (!query.game || query.game === context.game)) {
        if (options.disabledRows.includes(games[context.game].row)) return
        return { ...query, e, game: context.game, row: games[context.game].row, character: context.character,
          name: context.name, forbid: query.forbid || context.forbid }
      } else return { e, hint: '你想看哪位角色的专武图鉴呀？' }
    }
    const isRole = query.role !== undefined
    const matches = []
    for (const game of query.game ? [query.game] : ['gs', 'sr', 'zzz']) {
      const name = await entities.resolve(game, isRole ? 'character' : 'weapon', isRole ? query.role : query.subject)
      if (safeName(name)) matches.push({ game, name })
    }
    if (matches.length > 1) return { e, hint: '这个名字对应多个游戏，带上游戏名再说一次吧' }
    const match = matches[0]
    if (!match || !games[match.game] || options.disabledRows.includes(games[match.game].row)) return
    return { ...query, e, game: match.game, row: games[match.game].row, [isRole ? 'character' : 'name']: match.name }
  }

  async run(request, { config, service, signal, allowed, onSearch, log, onReply }) {
    const { e, game, character, row } = request, bridge = this.commands.bridge
    const byName = game === 'sr' ? { game, row, id: 'sr.lightcone.wiki', template: '{name}' } : gsItemWiki
    const title = games[game]?.title || '武器'
    let name = request.name
    const result = (reply, failed = false) => ({ reply, failed, emotion: 'neutral', origin: 'command',
      ...(!failed && (name || character) ? { signatureWeapon: { game, userId: String(e.user_id), character, name, forbid: request.forbid } } : {}) })
    const key = this.commands.key(e)
    if (this.commands.executed.has(key) || !(await allowed()) || !await bridge.available(byName, e) ||
        e.group?.mute_left > 0 || e.group?.all_muted && !e.group.is_admin && !e.group.is_owner) return result('', true)
    this.commands.executed.set(key, this.commands.now())
    if (this.commands.executed.size > 10000) this.commands.executed.delete(this.commands.executed.keys().next().value)
    const tell = async text => {
      if (!await allowed()) return result('', true)
      const sent = await e.reply(text)
      if (sent === false || sent === null || sent?.error) return result('', true)
      onReply()
      return result(text)
    }
    if (request.hint) return tell(request.hint)
    const native = async (capability, value) => {
      const args = game === 'gs' ? { item: value } : { name: value }
      const out = await bridge.execute({ capability, args, original: e, allowed, onReply, pluginKeys: nativePlugins })
      await log('command_execution', { capabilityId: capability.id, row: capability.row, status: out.status, attempts: out.attempts })
      if (out.successes) return result('已发送' + (name || character + '专武') + '的' + title + '图鉴')
      if (out.status === 'context_busy') return tell('先完成现在的交互，再来看' + title + '图鉴吧')
      if (out.attempts || out.status === 'cancelled') return result('', true)
      if (out.status !== 'no_response' && out.status !== 'failed') return tell('这次没能打开' + title + '图鉴，稍后再试试吧')
    }
    const root = bridge.root
    if (!name && character && game === 'gs') {
      const names = (await this.commands.entities.genshinSignatureNames(character)).filter(safeName)
      if (names.length > 1) return tell(character + '的专武别名对应多把武器，请带上武器名查图鉴吧')
      name = names[0]
    }
    if (!name && character && game === 'sr') {
      const cvs = await json(path.join(root, 'plugins/xiaoyao-cvs-plugin/resources/sr/weapon/data.json'))
      const names = new Set(Object.values(cvs).filter(v => Number(v?.star) === 5 && Array.isArray(v.belongRole) && v.belongRole.includes(character))
        .map(v => v.name).filter(safeName))
      if (names.size === 1) [name] = names
      if (request.mode === 'image') {
        const done = await native({ ...byName, id: 'sr.signature.wiki', template: '{name}专武' }, character)
        if (done) return done
      }
    }
    // The name may already be known from a previous answer or CVS metadata.
    // Try that exact native command before reaching for a public search.
    const localName = name
    if (name && request.mode === 'image') {
      const done = await native(byName, name)
      if (done) return done
    }
    if (name && request.mode === 'identify') return tell(character + '的专武叫「' + name + '」')
    const entries = (await weaponEntries(root, game))
      .filter(v => safeName(v?.name) && safeName(v.type))
    const options = webSearchOptions(config)
    if ((!name || request.mode === 'image') && character && options.enabled && options.maxSearches && !request.forbid) {
      onSearch()
      if (!await allowed()) return result('', true)
      const stats = { search: 0, fetch: 0, successful: 0, cacheHits: 0, errors: [] }
      const timeout = AbortSignal.timeout(options.timeoutMs)
      const lookupSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
      let sources = []
      try {
        sources = await service.lookup(games[game].searchGame + ' ' + character + ' ' + games[game].searchItem + ' 专武名称', {
          config, options, stats, signal: lookupSignal, allowed, revision: game + '-signature-weapon', needDetails: true })
      } catch { /* Unavailable evidence leaves the name unresolved. */ }
      const evidence = signatureEvidence(game, character, entries.map(v => v.name), sources)
      await log('signature_weapon_lookup', { game, search: stats.search, fetch: stats.fetch, sources: sources.length, confirmed: Boolean(evidence.name) })
      if (evidence.conflict || evidence.name && localName && evidence.name !== localName) {
        name = null
        return tell('查到的专武名称有出入，这次还不能确定是哪张')
      }
      name = evidence.name || localName
    }
    if (!name) return tell('还没核实' + character + '的专武名称')
    if (request.mode === 'identify') return tell(character + '的专武叫「' + name + '」')
    if (!localName) {
      const done = await native(byName, name)
      if (done) return done
    }
    const card = await weaponCard(root, game, entries.find(v => v.name === name))
    if (card && e.runtime?.render && await allowed()) {
      const image = await e.runtime.render('paimon-plugin', 'weapon-atlas/index', card, { retType: 'base64' })
      if (image && await allowed()) {
        const sent = await e.reply(image)
        if (sent === false || sent === null || sent?.error) return result('', true)
        onReply()
        await log('signature_weapon_render', { game, status: 'sent' })
        return result('已发送「' + name + '」的' + title + '图鉴')
      }
    }
    return tell(title + '是「' + name + '」，这次没拿到图鉴图片')
  }
}
