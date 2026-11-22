import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandOptions } from './command-catalog.js'
import { extractText } from './trigger.js'
import { webSearchOptions } from './web-search.js'

// Only constructed from a resolved role or an exact public light-cone entry.
const byRole = { game: 'sr', row: 'E05', id: 'sr.signature.wiki', template: '{name}专武' }
const byName = { ...byRole, id: 'sr.lightcone.wiki', template: '{name}' }
const nativePlugins = ['Atlas', 'xiaoyao-cvs-plugin']
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
  const view = /^(?:(?:我想|我要|请|麻烦)?(?:帮我|给我)?(?:看看|看一看|看一下|看下|看|查一下|查下|查|发一下|发下|发一张|发个)\s*)?(.+?)(?:的)?图鉴(?:吧|呗|吗)?$/.exec(text)
  const ask = /^(.+?)(?:的)?(?:专武|专属光锥|专锥)(?:叫(?:什么|啥)(?:名字)?|是(?:什么|啥|哪(?:一)?(?:个|张)|哪把))(?:呀|啊|呢|来着)?$/.exec(text)
  if (!view && !ask) return
  const subject = view?.[1]?.replace(/^[「《]|[」》]$/g, '')
  const role = ask?.[1] ?? /^(.*?)(?:的)?(?:专武|专属光锥|专锥)$/.exec(subject)?.[1]
  if (role === undefined && !safeName(subject)) return
  return { mode: ask ? 'identify' : 'image', role, subject, forbid,
    reference: role !== undefined && /^(?:这|那)(?:个|把|张)?$|^(?:她|他|它|刚才说的|刚才那个|刚刚那个|)$/.test(role) }
}

// Require an explicit role/weapon relation, not co-occurrence in a build guide.
// Use an explicit official attribution or agreement across distinct sites.
export function coneEvidence(character, weapons, sources) {
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
        const relation = '(?:专武|专属光锥|专锥|专属五星光锥)'
        const link = '(?:的|限定五星光锥|五星光锥|光锥|是|为|名为|叫作|叫|即|[\\s「」《》“”：:·—-])*'
        if (![role + '\\s*的?\\s*' + relation + link + cone, cone + link + role + '的?' + relation]
          .some(pattern => new RegExp(pattern).test(field))) continue
        if (!votes.has(name)) votes.set(name, new Set())
        // Keep subdomains of the same publisher together.
        const parts = host.split('.')
        const suffixLength = /\.(?:com\.cn|co\.uk|com\.tw|com\.hk)$/.test(host) ? 3 : 2
        const official = ['sr.mihoyo.com', 'hsr.hoyoverse.com'].includes(host)
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

export async function coneCard(root, entry) {
  if (!safeName(entry?.name) || !safeName(entry.type)) return null
  const dir = path.join(root, 'plugins/miao-plugin/resources/meta-sr/weapon', entry.type, entry.name)
  const data = await json(path.join(dir, 'data.json'))
  if (data.name !== entry.name || data.type !== entry.type || !data.skill?.desc) return null
  const stats = [['hp', '生命值'], ['atk', '攻击力'], ['def', '防御力']].map(([key, label]) =>
    ({ label, value: Math.round(data.baseAttr?.[key]) }))
  if (stats.some(stat => !Number.isFinite(stat.value))) return null
  const skill = plain(data.skill.desc).replace(/\$(\d+)\[(i|f\d*)\]/g, (_, index) =>
    data.skill.tables?.[index]?.join(' / ') || '？')
  const art = path.join(dir, 'splash.webp')
  try { await fs.access(art) } catch { return null }
  return { name: entry.name, type: entry.type, star: data.star, stats, skill, skillName: data.skill.name,
    art: pathToFileURL(art).href, saveId: 'cone-' + String(data.id).replace(/\D/g, '') }
}

export class LightConeAtlas {
  constructor(commands) { this.commands = commands }

  async select(messages, events, session, config) {
    const options = commandOptions(config)
    if (!options.enabled || !options.invoke || options.disabledRows.includes('E05')) return
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
      const context = prior?.signatureCone
      if (earlier?.role && !earlier.reference) { query.role = earlier.role; query.forbid ||= earlier.forbid }
      else if (context && context.userId === String(m.userId)) return { ...query, e, character: context.character,
        name: context.name, forbid: query.forbid || context.forbid }
      else return { e, hint: '你想看哪位角色的专武图鉴呀？' }
    }
    if (query.role !== undefined) {
      const role = query.role.replace(/^(?:星铁|星穹铁道|崩铁)[，,\s]*/, '')
      const character = await entities.resolve('sr', 'character', role)
      if (!safeName(character)) return
      if (role === query.role && (await entities.resolve('gs', 'character', role) || await entities.resolve('zzz', 'character', role)))
        return { e, hint: '你说的是星铁的角色吗？带上游戏名再说一次吧' }
      return { ...query, e, character }
    }
    const name = await entities.resolve('sr', 'weapon', query.subject)
    if (safeName(name)) return { ...query, e, name }
  }

  async run(request, { config, service, signal, allowed, onSearch, log, onReply }) {
    const { e, character } = request, bridge = this.commands.bridge
    let name = request.name
    const result = (reply, failed = false) => ({ reply, failed, emotion: 'neutral', origin: 'command',
      ...(!failed && (name || character) ? { signatureCone: { userId: String(e.user_id), character, name, forbid: request.forbid } } : {}) })
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
      const args = { name: value }
      const out = await bridge.execute({ capability, args, original: e, allowed, onReply, pluginKeys: nativePlugins })
      await log('command_execution', { capabilityId: capability.id, row: capability.row, status: out.status, attempts: out.attempts })
      if (out.successes) return result('已发送' + (name || character + '专武') + '的光锥图鉴')
      if (out.status === 'context_busy') return tell('先完成现在的交互，再来看光锥图鉴吧')
      if (out.attempts || out.status === 'cancelled') return result('', true)
      if (out.status !== 'no_response' && out.status !== 'failed') return tell('这次没能打开光锥图鉴，稍后再试试吧')
    }
    const root = bridge.root
    if (!name && character) {
      const cvs = await json(path.join(root, 'plugins/xiaoyao-cvs-plugin/resources/sr/weapon/data.json'))
      const names = new Set(Object.values(cvs).filter(v => Number(v?.star) === 5 && Array.isArray(v.belongRole) && v.belongRole.includes(character))
        .map(v => v.name).filter(safeName))
      if (names.size === 1) [name] = names
      if (request.mode === 'image') {
        const done = await native(byRole, character)
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
    const entries = Object.values(await json(path.join(root, 'plugins/miao-plugin/resources/meta-sr/weapon/data.json')))
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
        sources = await service.lookup('崩坏星穹铁道 ' + character + ' 专属五星光锥 专武名称', {
          config, options, stats, signal: lookupSignal, allowed, revision: 'sr-signature-cone', needDetails: true })
      } catch { /* Unavailable evidence leaves the name unresolved. */ }
      const evidence = coneEvidence(character, entries.map(v => v.name), sources)
      await log('light_cone_lookup', { search: stats.search, fetch: stats.fetch, sources: sources.length, confirmed: Boolean(evidence.name) })
      if (evidence.conflict || evidence.name && localName && evidence.name !== localName) {
        name = null
        return tell('查到的专武名称有出入，这次还不能确定是哪张')
      }
      name = evidence.name || localName
    }
    if (!name) return tell('还没核实' + character + '的专武名称，暂时没法确认是哪张光锥')
    if (request.mode === 'identify') return tell(character + '的专武叫「' + name + '」')
    if (!localName) {
      const done = await native(byName, name)
      if (done) return done
    }
    const card = await coneCard(root, entries.find(v => v.name === name))
    if (card && e.runtime?.render && await allowed()) {
      const image = await e.runtime.render('paimon-plugin', 'light-cone/index', card, { retType: 'base64' })
      if (image && await allowed()) {
        const sent = await e.reply(image)
        if (sent === false || sent === null || sent?.error) return result('', true)
        onReply()
        await log('light_cone_render', { status: 'sent' })
        return result('已发送「' + name + '」的光锥图鉴')
      }
    }
    return tell('光锥是「' + name + '」，这次没拿到图鉴图片')
  }
}
