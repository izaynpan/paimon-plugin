import { fileURLToPath } from 'node:url'
import { commandText } from './command-catalog.js'

export const commandSynthetic = Symbol('paimon.command.synthetic')
const rootPath = fileURLToPath(new URL('../../../', import.meta.url))
const fields = ['self_id', 'user_id', 'group_id', 'message_id', 'message_type', 'sub_type', 'post_type', 'time',
  'seq', 'rand', 'font', 'from_id', 'to_id', 'isPrivate', 'isGroup', 'isMaster', 'only_reply_at', 'atBot', 'hasAlias',
  'bot', 'friend', 'group', 'member', 'reply_id', 'source', 'file', 'img', 'logText']
const external = entry => entry.key !== 'paimon-plugin' && !entry.key?.startsWith('paimon-plugin/')
const matches = (rule, text) => {
  try { return new RegExp(rule.reg.source ?? rule.reg, rule.reg.flags?.replace(/[gy]/g, '') || '').test(text) }
  catch { return false }
}

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

// Reuse the currently running dispatcher's normal accept/rule/permission path.
// No plugin business methods, Git revisions or file hashes are pinned here.
export class CommandBridge {
  constructor({ root = rootPath, dependencies, importModule = p => import(p) } = {}) {
    Object.assign(this, { root, dependencies, importModule })
  }
  async deps() {
    if (this.dependencies) return this.dependencies
    const [loader, config] = await Promise.all([
      import('../../../lib/plugins/loader.js'), import('../../../lib/config/config.js'),
    ])
    return { loader: loader.default, cfg: config.default }
  }
  supported(loader) {
    return Array.isArray(loader.priority) && ['deal', 'checkBlack', 'checkDisable', 'filtEvent', 'filtPermission',
      'dealEvent', 'reply', 'count', 'checkLimit', 'setLimit'].every(key => typeof loader[key] === 'function')
  }
  async permitted(e, entry, rule) {
    const { loader } = await this.deps()
    if (!loader.checkBlack(e) || !loader.checkDisable({ ...entry.plugin, e }) ||
        !loader.filtEvent(e, entry.plugin) || (rule?.event && !loader.filtEvent(e, rule))) return false
    // Read-only permission precheck; actual execution still uses filtPermission.
    const permission = rule?.permission
    if (!permission || permission === 'all' || e.isMaster) return true
    if (permission === 'master' || !e.isGroup) return false
    if (permission === 'owner') return !!e.member?.is_owner || e.sender?.role === 'owner'
    if (permission === 'admin') return !!e.member?.is_owner || !!e.member?.is_admin || ['owner', 'admin'].includes(e.sender?.role)
    return false
  }
  async available(_capability, e) {
    try {
      const { loader } = await this.deps()
      // This is dispatcher availability, not a promise that a particular command
      // has a handler or will succeed. The normal command flow decides that.
      return this.supported(loader) && loader.checkBlack(e)
    } catch { return false }
  }
  async recognizes(parsed, e, capabilities, entities) {
    const { loader } = await this.deps()
    const msg = parsed.internal || ({ gs: '#', sr: '#星铁', zzz: '#绝区零' })[parsed.game] + parsed.body
    let knownEntity = false
    for (const c of capabilities.filter(c => c.game === parsed.game)) for (const slot of Object.values(c.slots))
      if (slot.entity && (await entities?.inText(c.game, slot.entity, parsed.body))?.length) knownEntity = true
    for (const entry of loader.priority.filter(external)) for (const rule of entry.plugin?.rule || []) {
      const source = rule.reg.source ?? rule.reg
      // Broad dispatch rules aren't proof that a misspelled entity exists.
      if (!source.endsWith('$') || !/[\u3400-\u9fff]/.test(source) ||
          !knownEntity && /\.[*+]|\\[sSwW][*+]/.test(source)) continue
      if (matches(rule, msg) && await this.permitted(e, entry, rule)) return true
    }
    return false
  }
  async execute({ capability, args, original, targetUserId, allowed, onReply = () => {}, profileHook }) {
    // Internal, program-owned hook for a Genshin analysis snapshot. Never accept
    // this option from model arguments or copy _profile from a user event.
    if (profileHook && (capability.id !== 'gs.panel.show' || typeof profileHook.run !== 'function'))
      return { status: 'rejected', attempts: 0, successes: 0 }
    if (targetUserId && (!original.isGroup || !/^\d+$/.test(String(targetUserId)) || !/^(gs|sr)\.panel\.show$/.test(capability.id)))
      return { status: 'rejected', attempts: 0, successes: 0 }
    const { loader } = await this.deps()
    if (!this.supported(loader)) return { status: 'unavailable', attempts: 0, successes: 0 }
    let attempts = 0, successes = 0, active = true, current, blocked, failed = false
    const pending = new Set()
    const track = promise => {
      if (!promise || typeof promise.then !== 'function') return promise
      pending.add(promise)
      promise.then(() => pending.delete(promise), () => { failed = true; pending.delete(promise) })
      return promise
    }
    const drain = async () => { while (pending.size && active) await Promise.allSettled([...pending]) }
    const live = record => loader.priority.includes(record.entry) && record.entry.class === record.Class &&
      record.entry.plugin === record.plugin && (!record.rule || record.plugin.rule?.includes(record.rule))
    const valid = async record => active && !blocked && loader.checkBlack(original) && await allowed() && active && !blocked &&
      (!record || live(record) && await this.permitted(original, record.entry, record.rule))
    const send = (fn, values) => track((async () => {
      if (!(await valid(current)) || !active) return false
      attempts++
      const value = await fn(...values)
      if (value !== false && value !== null && !value?.error) { successes++; onReply(value) }
      return value
    })())
    const command = commandText(capability, args, true)
    const e = deriveCommandEvent(original, command, capability.game)
    // Keep the real sender and permissions. The original plugin selects the
    // queried account through the same @ segment as a manually typed command.
    if (targetUserId) e.message.push({ type: 'at', qq: String(targetUserId) })
    // dealEvent concatenates text segments; do not feed it an already parsed msg.
    e.msg = ''
    // Let normal accept hooks capture the framework-normalized command (e.g.
    // #星铁...), rather than handing them an unnormalized * alias as original_msg.
    delete e.original_msg
    e.reply = (...values) => send(original.reply.bind(original), values)
    for (const key of ['friend', 'group']) if (e[key]) {
      const channel = e[key]
      e[key] = new Proxy(channel, { get(object, key) {
        const value = Reflect.get(object, key, object)
        if (typeof value !== 'function') return value
        return ['sendFile', 'sendMsg', 'sendForwardMsg'].includes(String(key))
          ? (...values) => send(value.bind(object), values) : value.bind(object)
      } })
    }
    const task = async () => {
      if (!(await valid())) return { status: 'cancelled', attempts, successes }
      // A per-call facade never patches the shared loader, classes or rules.
      const scope = Object.create(loader)
      scope.priority = loader.priority.filter(external).map(entry => {
        const record = { entry, Class: entry.class, plugin: entry.plugin }
        const plugin = Object.assign(Object.create(Object.getPrototypeOf(entry.plugin)), entry.plugin)
        plugin.rule = (entry.plugin.rule || []).map(rule => ({ ...rule,
          reg: new RegExp(rule.reg.source ?? rule.reg, rule.reg.flags?.replace(/[gy]/g, '') || '') }))
        // Never inject a generated command into a user's pending interactive input.
        if (typeof plugin.getContext === 'function') {
          const getContext = plugin.getContext
          plugin.getContext = function (...args) {
            const value = getContext.apply(this, args)
            if (value && Object.keys(value).length) blocked = 'context_busy'
            return {}
          }
        }
        const Class = new Proxy(entry.class, { construct(Target, values) {
          const instance = new Target(...values)
          let depth = 0
          for (const key of ['render', 'renderImg']) if (typeof instance[key] === 'function') {
            const render = instance[key].bind(instance)
            instance[key] = (...args) => track(render(...args))
          }
          for (const key of new Set(['accept', ...plugin.rule.map(r => r.fnc)])) if (typeof instance[key] === 'function') {
            const handle = instance[key].bind(instance)
            instance[key] = async (...args) => {
              // Registered methods can call one another as ordinary helpers.
              // Only the outer framework invocation is a new dispatch decision.
              if (depth) return handle(...args)
              const rule = key === 'accept' ? undefined : entry.plugin.rule?.find(r =>
                r.fnc === key && (!r.event || loader.filtEvent(e, r)) && matches(r, e.msg))
              current = { ...record, rule }
              if ((key !== 'accept' && !rule) || !(await valid(current))) {
                blocked ||= 'cancelled'
                return key === 'accept' ? 'return' : true
              }
              depth++
              try {
                if (profileHook && key !== 'accept') {
                  if (entry.key !== 'miao-plugin') return false
                  await profileHook.run(e)
                  if (!(await valid(current))) { blocked ||= 'cancelled'; return true }
                  if (profileHook.readOnly) return true
                }
                const result = await handle(...args)
                await drain()
                // Replies followed by false must not cause a second execution.
                return attempts ? key === 'accept' ? 'return' : true : result
              } catch (error) { failed = true; throw error }
              finally { depth-- }
            }
          }
          return instance
        } })
        return { ...entry, plugin, class: Class }
      })
      // The source event already passed ingress rate limits and has a wrapped
      // reply. Reprocessing either would double count/rate-limit one user action.
      scope.count = () => {}
      scope.reply = () => {}
      scope.setLimit = () => {}
      scope.checkLimit = event => !(event.group && (event.group.mute_left > 0 ||
        event.group.all_muted && !event.group.is_admin && !event.group.is_owner))
      await scope.deal(e)
      await drain()
      return { status: attempts ? successes ? 'responded' : 'failed' : blocked || (failed ? 'failed' : 'no_response'), attempts, successes }
    }
    let timer
    try {
      return await Promise.race([task().catch(() => ({ status: 'failed', attempts, successes })),
        new Promise(resolve => { timer = setTimeout(() => { active = false; resolve({ status: 'timeout', attempts, successes }) }, capability.timeoutMs || 30000) })])
    } finally { active = false; clearTimeout(timer) }
  }
}
