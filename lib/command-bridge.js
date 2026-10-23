import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { commandText } from './command-catalog.js'

export const commandSynthetic = Symbol('paimon.command.synthetic')
const rootPath = fileURLToPath(new URL('../../../', import.meta.url))
const manifest = JSON.parse(await fs.readFile(new URL('./command-manifest.json', import.meta.url), 'utf8'))
const rankMethods = new Set(['abyssRank', 'deadlyRank', 'deadlyHardRank', 'holoBossRank', 'voidFrontBattleRank',
  'climbingTowerHelp', 'climbingTowerS1', 'climbingTowerS2', 'climbingTowerS3', 'climbingTowerS4'])
const fields = ['self_id', 'user_id', 'group_id', 'message_id', 'message_type', 'sub_type', 'post_type', 'time',
  'seq', 'rand', 'font', 'from_id', 'to_id', 'isPrivate', 'isGroup', 'isMaster', 'only_reply_at', 'atBot',
  'bot', 'friend', 'group', 'member', 'reply_id', 'source', 'file', 'img', 'logText']

export function deriveCommandEvent(original, command, game) {
  const e = Object.fromEntries(fields.filter(k => original[k] !== undefined).map(k => [k, original[k]]))
  e.sender = { ...original.sender }
  e[commandSynthetic] = true
  e.message = [{ type: 'text', text: command }]
  e.msg = e.raw_message = e.original_msg = command
  e.game = game
  Object.defineProperties(e, {
    isSr: { configurable: true, get: () => e.game === 'sr', set: v => { e.game = v ? 'sr' : 'gs' } },
    isGs: { configurable: true, get: () => e.game === 'gs', set: v => { e.game = v ? 'gs' : 'sr' } },
  })
  if (original.getReply) e.getReply = original.getReply.bind(original)
  return e
}

export class CommandBridge {
  constructor({ root = rootPath, dependencies, verify, importModule = p => import(p) } = {}) {
    this.root = root
    this.dependencies = dependencies
    this.verifyOverride = verify
    this.importModule = importModule
    this.hashes = new Map()
  }
  async deps() {
    if (this.dependencies) return this.dependencies
    const [loader, runtime, config] = await Promise.all([
      import('../../../lib/plugins/loader.js'), import('../../../lib/plugins/runtime.js'), import('../../../lib/config/config.js'),
    ])
    return { loader: loader.default, Runtime: runtime.default, cfg: config.default }
  }
  async hashMatches(file, expected) {
    try {
      const full = path.join(this.root, file), stat = await fs.stat(full)
      const key = `${stat.mtimeMs}:${stat.size}`
      let record = this.hashes.get(file)
      if (record?.key !== key) {
        record = { key, hash: createHash('sha256').update(await fs.readFile(full)).digest('hex') }
        this.hashes.set(file, record)
      }
      return record.hash === expected
    } catch { return false }
  }
  async compatible(target) {
    if (this.verifyOverride) return this.verifyOverride(target)
    if (!target || !(await this.revisionMatches('.', manifest.revisions.framework)) ||
        target.owner !== 'example' && !(await this.revisionMatches(`plugins/${target.owner}`, manifest.revisions[target.owner]))) return false
    if (!(await this.hashMatches(target.file, target.sha256))) return false
    const shared = ['lib/plugins/runtime.js', 'lib/plugins/loader.js', 'lib/plugins/plugin.js']
    if (target.owner === 'miao-plugin') shared.push('plugins/miao-plugin/components/App.js', 'plugins/miao-plugin/components/common/Plugin.js', 'plugins/miao-plugin/components/Meta.js')
    if (target.file.endsWith('/wiki.js') && target.owner === 'miao-plugin') shared.push('plugins/miao-plugin/apps/wiki/CharWiki.js')
    if (target.owner === 'xiaoyao-cvs-plugin') shared.push('plugins/xiaoyao-cvs-plugin/adapter/index.js')
    if (target.owner === 'ZZZ-Plugin') shared.push('plugins/ZZZ-Plugin/dist/lib/plugin.js', 'plugins/ZZZ-Plugin/dist/lib/common.js')
    for (const file of shared) if (!(await this.hashMatches(file, manifest.shared[file]))) return false
    return true
  }
  async revisionMatches(relative, prefix) {
    if (!prefix) return false
    try {
      let dir = path.join(this.root, relative, '.git')
      const stat = await fs.stat(dir)
      if (stat.isFile()) {
        const gitdir = (await fs.readFile(dir, 'utf8')).trim().match(/^gitdir: (.+)$/)?.[1]
        if (!gitdir) return false
        dir = path.resolve(path.dirname(dir), gitdir)
      }
      const head = (await fs.readFile(path.join(dir, 'HEAD'), 'utf8')).trim()
      let sha = head
      if (head.startsWith('ref: ')) {
        const ref = head.slice(5)
        if (!/^refs\/[\w./-]+$/.test(ref) || ref.includes('..')) return false
        let common = dir
        try { common = path.resolve(dir, (await fs.readFile(path.join(dir, 'commondir'), 'utf8')).trim()) } catch {}
        try { sha = (await fs.readFile(path.join(common, ref), 'utf8')).trim() }
        catch { sha = (await fs.readFile(path.join(common, 'packed-refs'), 'utf8')).split('\n').find(line => line.endsWith(' ' + ref))?.split(' ')[0] }
      }
      return /^[a-f0-9]{40,64}$/.test(sha || '') && sha.startsWith(prefix)
    } catch { return false }
  }
  async permitted(e, entry, rule) {
    const { loader, cfg } = await this.deps()
    const group = cfg.getGroup(e.self_id, e.group_id)
    if (!loader.checkBlack(e) || !loader.checkDisable({ ...entry.plugin, e }, group) ||
        !loader.filtEvent(e, entry.plugin) || (rule?.event && !loader.filtEvent(e, rule))) return false
    // Check without generating a denial reply while constructing candidates.
    const permission = rule?.permission
    if (!permission || permission === 'all') return true
    if (!['master', 'owner', 'admin'].includes(permission)) return false
    if (e.isMaster) return true
    if (!e.isGroup) return false
    if (permission === 'owner') return e.sender?.role === 'owner'
    if (permission === 'admin') return ['owner', 'admin'].includes(e.sender?.role)
    return false
  }
  async candidates(capability, e) {
    const { loader } = await this.deps()
    const result = []
    for (const id of capability.targets) {
      const target = manifest.targets[id]
      if (!target || !(await this.compatible(target))) continue
      for (const entry of loader.priority || []) {
        if (entry.key !== (target.owner === 'example' ? `${target.owner}/卡池信息查询.js` : target.owner) || entry.name !== target.name) continue
        const rules = (entry.plugin?.rule || []).filter(r => target.owner === 'xiaoyao-cvs-plugin'
          ? r.fnc === 'dispatch' : target.method === '*' ? rankMethods.has(r.fnc) : r.fnc === target.method)
        for (const rule of rules) if (await this.permitted(e, entry, rule)) result.push({ entry, target, rule })
      }
    }
    return result
  }
  async available(capability, e) {
    try { return (await this.candidates(capability, e)).length > 0 } catch { return false }
  }
  async recognizes(parsed, e, capabilities, entities) {
    const msg = parsed.internal || ({ gs: '#', sr: '#星铁', zzz: '#绝区零' })[parsed.game] + parsed.body
    for (const capability of capabilities.filter(c => c.game === parsed.game)) {
      let known = true
      for (const slot of Object.values(capability.slots)) if (slot.entity &&
          !(await entities?.inText(capability.game, slot.entity, parsed.body))?.length) known = false
      if (!known) continue
      for (const { rule, target } of await this.candidates(capability, e)) {
        if (['Atlas', 'xiaoyao-cvs-plugin'].includes(target.owner)) continue
        const source = rule.reg.source ?? rule.reg
        // Only anchored business rules, never a catch-all.
        if (!source.endsWith('$') || !/[\u3400-\u9fff]/.test(source)) continue
        if (new RegExp(source, rule.reg.flags?.replace(/[gy]/g, '') || '').test(msg)) return true
      }
    }
    return false
  }
  async execute({ capability, args, original, allowed, onReply = () => {} }) {
    const command = commandText(capability, args)
    const candidates = await this.candidates(capability, original)
    let attempts = 0, successes = 0, active = true, current
    const pending = new Set()
    const track = p => {
      if (!p || typeof p.then !== 'function') return p
      pending.add(p)
      p.then(() => pending.delete(p), () => pending.delete(p))
      return p
    }
    const send = (fn, values) => {
      const p = (async () => {
        if (!active || !(await allowed()) || !active) return false
        const { loader } = await this.deps()
        if (!current || !loader.priority.includes(current.entry) || !(await this.compatible(current.target)) ||
            !(await this.permitted(original, current.entry, current.rule)) || !active) return false
        if (!(await allowed()) || !active) return false
        attempts++
        const value = await fn(...values)
        if (value !== false && value !== null && !value?.error) { successes++; onReply(value) }
        return value
      })()
      // Observe fire-and-forget plugin sends without swallowing the caller's promise.
      return track(p)
    }
    const task = async () => {
      for (const candidate of candidates) {
        const { entry, target, rule } = candidate
        current = candidate
        const { loader, Runtime } = await this.deps()
        if (!active || !(await allowed()) || !loader.priority.includes(entry) ||
            !(await this.compatible(target)) || !(await this.permitted(original, entry, rule))) return { status: 'rejected' }
        const e = deriveCommandEvent(original, command, capability.game)
        e.reply = (...values) => send(original.reply.bind(original), values)
        // ExportLog uses channel.sendFile rather than e.reply. Preserve that channel,
        // but guard its late send with exactly the same lifecycle checks.
        for (const key of ['friend', 'group']) if (e[key]) {
          const channel = e[key]
          e[key] = new Proxy(channel, { get(object, key) {
            const value = Reflect.get(object, key, object)
            if (typeof value !== 'function') return value
            return ['sendFile', 'sendMsg', 'sendForwardMsg'].includes(String(key))
              ? (...values) => send(value.bind(object), values) : value.bind(object)
          } })
        }
        await Runtime.init(e)
        if (!active || !(await allowed())) return { status: 'rejected' }
        const instance = Object.assign(new entry.class(e), { e })
        // Some audited handlers (e.g. genshin buddy) return before renderImg's
        // promise settles. Keep their rendering and subsequent sends in this call.
        for (const method of ['renderImg', 'render']) if (typeof instance[method] === 'function') {
          const render = instance[method].bind(instance)
          instance[method] = (...args) => track(render(...args))
        }
        if (capability.prepare === 'wiki' && target.owner === 'miao-plugin') {
          await instance.accept?.(e)
          if (e.msg !== '#喵喵WIKI' || !e.char || !e.wikiMode) continue
        }
        const regex = new RegExp(rule.reg.source ?? rule.reg, rule.reg.flags?.replace(/[gy]/g, '') || '')
        if (!regex.test(e.msg)) continue
        let value
        if (target.owner === 'xiaoyao-cvs-plugin') {
          // The legacy dispatch() also scans unrelated rules. Invoke only the
          // audited selected export with its original adapter dependencies.
          const url = relative => pathToFileURL(path.join(this.root, relative)).href
          const mod = await this.importModule(url(target.file))
          if (!mod.rule?.[target.method]?.reg || !new RegExp(mod.rule[target.method].reg).test(e.msg)) continue
          const { render } = await this.importModule(url('plugins/xiaoyao-cvs-plugin/adapter/render.js'))
          const { checkAuth, getMysApi } = await this.importModule(url('plugins/xiaoyao-cvs-plugin/adapter/mys.js'))
          e.checkAuth = cfg => checkAuth(e, cfg)
          e.getMysApi = cfg => getMysApi(e, cfg)
          value = await mod[target.method](e, { render })
        } else value = await instance[rule.fnc](e)
        while (pending.size && active) await Promise.allSettled([...pending])
        if (attempts) return { status: successes ? 'responded' : 'failed', attempts, successes }
        if (value !== false) return { status: 'no_response', attempts, successes }
      }
      return { status: candidates.length ? 'no_response' : 'unavailable', attempts, successes }
    }
    let timer
    try {
      return await Promise.race([task().catch(() => ({ status: 'failed', attempts, successes })),
        new Promise(resolve => { timer = setTimeout(() => {
          active = false
          resolve({ status: 'timeout', attempts, successes })
        }, capability.timeoutMs || 30000) })])
    } finally { active = false; clearTimeout(timer) }
  }
}

export { manifest as commandManifest }
