import { approvedCapabilities, commandOptions } from './command-catalog.js'
import { commandSynthetic } from './command-bridge.js'
import { extractText, isGroupAllowed, sessionKeyFor } from './trigger.js'
import { MiaoProfileProvider } from './miao-profile-provider.js'
import { buildAnalysisMessages, publicBuildQuery } from './build-analysis-prompt.js'
import { completeWithResearch, searchIntent } from './research.js'
import { readKnowledge } from './knowledge-provider.js'
import { abortable, searchApiKey } from './web-search.js'
import { randomUUID } from 'node:crypto'

export const buildAnalysisOptions = config => ({ enabled: config.buildAnalysis?.enabled === true,
  games: Array.isArray(config.buildAnalysis?.games) ? config.buildAnalysis.games.filter(g => g === 'gs') : ['gs'],
  includePanelImage: config.buildAnalysis?.includePanelImage !== false,
  searchMode: config.buildAnalysis?.searchMode === 'off' ? 'off' : 'auto' })
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const intentPattern = /提升|改进|优化|分析|评[价估]|练度|毕业|怎么(?:改|配|养|培养)|如何(?:改|配|养|培养)/
const followPattern = /这(?:套|个面板|个角色).*(?:哪里|怎么|如何|还|要).*(?:改|提升|优化|养)|这套.*(?:分析|评价)/
const fingerprint = config => JSON.stringify([config.deepseek?.apiKey, config.deepseek?.baseUrl, searchApiKey(config),
  config.webSearch, config.knowledge, config.buildAnalysis])
const failedResult = { reply: '', origin: 'command', emotion: 'neutral', failed: true }
const hints = {
  unbound: '还没找到绑定的原神账号，请先私聊发送 #扫码登录，完成后再试试吧',
  missing: '还没有这个角色的可用面板。请账号本人发送 #米游社更新面板，更新后再来分析吧',
  unavailable: '这次没能读取面板，可以先用原来的面板指令查看，稍后再试分析',
  disabled: '面板功能暂时没有开启，开启后再来分析吧',
  unsupported: '这个角色暂时不能读取原神面板，请先确认原插件能显示它的面板',
  context_busy: '你还有其他功能的交互没结束，先完成或退出后再试吧',
  timeout: '这次读取面板等得太久啦，稍后再试试吧',
}

export class BuildAnalysis {
  constructor({ commands, getConfig, disposed = () => false, profileProvider, log = async () => {}, now = Date.now }) {
    Object.assign(this, { commands, getConfig, disposed, log, now })
    this.provider = profileProvider || new MiaoProfileProvider({ bridge: commands.bridge })
    this.jobs = new Set(); this.contexts = new Map(); this.versions = new Map(); this.events = new WeakMap(); this.executed = new Map()
    this.admissions = new Map()
  }
  key(e) { return sessionKeyFor(e) + ':' + e.user_id }
  messageKey(e) { return e.message_id == null ? e : [e.self_id, this.key(e), e.message_id].join(':') }
  enabled(e, config) {
    const options = buildAnalysisOptions(config), routing = commandOptions(config)
    return !this.disposed() && config.enabled === true && options.enabled && options.games.includes('gs') &&
      routing.enabled && routing.invoke && !!config.deepseek?.apiKey && e && !e[commandSynthetic] &&
      String(e.user_id) !== String(e.self_id) && (e.isGroup ? isGroupAllowed(e.group_id, config) : e.isPrivate && config.trigger?.privateTrigger !== false) &&
      approvedCapabilities(config).some(c => c.id === 'gs.panel.show')
  }
  async request(e, config) {
    if (!this.enabled(e, config)) return null
    let text = extractText(e)
    if (text.length > 500 || /^[#＃*＊%％]/.test(text) || /[“”「」"`]|如果|假如|他说|她说|有人说|转述|举例|翻译|改写/.test(text)) return null
    // A no-network constraint is not a cancellation of the analysis itself.
    const { forbid, refresh: searchRefresh } = searchIntent(text)
    text = text.replace(/(?:不要|不用|不必|别|禁止|无需).{0,5}(?:联网|上网|搜索|查网)/g, '')
      .replace(/只(?:用|看|根据).{0,6}(?:知识库|本地)(?:资料)?/g, '')
    if (/不要|不用|别(?:给|帮|分析|看|查)|取消|停止/.test(text) || !(intentPattern.test(text) || followPattern.test(text))) return null
    for (let i = 0; i < 3; i++) {
      text = text.replace(/^\s*(?:好(?:的)?|嗯|那)[，,\s]+/, '')
      for (const name of config.trigger?.nicknames || ['派蒙', '派大王']) text = text.replace(new RegExp('^\\s*' + escape(name) + '[，,：:\\s]*'), '')
    }
    for (const at of e.message || []) if (at.type === 'at') text = text.replace('@' + (at.name || at.text || at.qq), '')
    text = text.trim().replace(/^(?:请|帮我)?(?:重新|再|现在)?(?:联网|上网)(?:查(?:一下|下)?|核对(?:一下|下)?|确认(?:一下|下)?)?[，,\s]*/, '')
    if (/星铁|星穹铁道|绝区零/.test(text.slice(text.lastIndexOf('的') + 1))) return null
    const key = this.key(e), previous = this.contexts.get(key)
    if (previous && this.now() - previous.at >= 120000) this.contexts.delete(key)
    const roleText = text.replace(/(?:还能|还可以|还|可以)?(?:怎么|如何)?(?:提升|优化|改进|培养|养成|毕业|练度)/g, '面板')
    const matches = (await this.commands.entities.inText('gs', 'character', roleText + '面板')).sort((a, b) => b[0].length - a[0].length)
      .filter(([alias], i, all) => !all.slice(0, i).some(([longer]) => longer.includes(alias)))
    const roles = [...new Set(matches.map(([, name]) => name))]
    if (!roles.length && followPattern.test(text)) {
      if (!previous || this.now() - previous.at >= 120000) return { hint: '你想分析哪个角色的面板？说一下角色名字吧' }
      if ((e.message || []).some(m => m.type === 'at' && String(m.qq) !== String(e.self_id)))
        return { hint: '请把要分析的角色名字也说一下吧' }
      return { character: previous.character, targetUserId: previous.targetUserId, forbid, searchRefresh, refresh: false }
    }
    const publicTopic = /技能|机制|命座|剧情|故事|台词|攻略|配队|传说|设定|生日|强度/.test(text)
    const personal = /我的|本人的|自己的|这套|面板/.test(text) || /分析|评估|评价/.test(text) && !publicTopic ||
      matches.some(([alias]) => new RegExp('.+的\\s*' + escape(alias)).test(text)) ||
      (e.message || []).some(m => m.type === 'at' && String(m.qq) !== String(e.self_id))
    if (!personal) return null // Public "芙宁娜怎么培养" remains a public guide.
    if (roles.length !== 1) return { hint: '请一次指定一个原神角色，派蒙再结合面板分析吧' }
    const alias = matches.find(([, name]) => name === roles[0])[0]
    let prefix = text.slice(0, text.indexOf(alias)).replace(/^(?:原神|提瓦特)[，,：:\s]+/, '')
      .replace(/(?:原神|提瓦特)\s*$/, '').trim()
    const refresh = /(?:更新|刷新)(?:一下|下)?(?:我的)?面板.*(?:再|然后).*(?:分析|提升|评[价估])/.test(text)
    if (refresh) prefix = prefix.replace(/^.*?(?:再|然后)/, '')
    // Only an exact possessive target is resolved; never turn arbitrary chat into a nickname.
    prefix = prefix.replace(/^(?:请|麻烦|帮我|给我|我想|我要|能不能|可以|换成|改成|这套|再|分析|评估|评价|看看|看下|看一下|看|一下|下|[，,：:\s])+/, '')
    let targetName = prefix.endsWith('的') ? prefix.slice(0, -1).trim() : ''
    if (['我', '自己', '本人'].includes(targetName)) targetName = ''
    if (prefix && !prefix.endsWith('的')) return null
    const target = await this.commands.targets.resolve(e, targetName)
    if (!['self', 'resolved'].includes(target.status)) return { hint: '还没确定你指的是哪位群友，请直接 @ 对方并说一下角色名字吧' }
    if (refresh && target.userId) return { hint: '请账号本人先发送 #米游社更新面板；查看和分析可以指定群友，更新只操作自己的账号' }
    return { character: roles[0], targetUserId: target.userId, refresh, forbid, searchRefresh }
  }
  cancel(e, clearContext = true) {
    const key = this.key(e)
    this.versions.set(key, (this.versions.get(key) || 0) + 1)
    for (const job of this.jobs) if (job.key === key) job.controller.abort()
    if (clearContext) this.contexts.delete(key)
    while (this.versions.size > 2000) this.versions.delete(this.versions.keys().next().value)
  }
  admit(e, request) {
    // Protocol redelivery must not cancel the first execution of this message.
    const id = this.messageKey(e)
    for (const [key, record] of this.admissions) if (this.now() - record.at > 300000) this.admissions.delete(key)
    const previous = this.admissions.get(id)
    if (previous) { this.events.set(e, { ...previous, e }); return }
    this.cancel(e)
    const record = { request, version: this.versions.get(this.key(e)), at: this.now() }
    this.events.set(e, { e, ...record }); this.admissions.set(id, record)
    while (this.admissions.size > 2000) this.admissions.delete(this.admissions.keys().next().value)
  }
  select(messages, events) {
    const records = events.map((e, i) => {
      const record = e && this.events.get(e), m = messages[i]
      return record && m && !m.preTrigger && m.origin !== 'pre_trigger' && m.source !== 'history' &&
        String(m.userId) === String(e.user_id) ? record : null
    }).filter(Boolean)
    const candidates = records.filter(record => record.version === this.versions.get(this.key(record.e)))
    // An already admitted but revoked analysis must not fall back to ordinary
    // chat/model command routing and resurrect the cancelled request.
    if (!candidates.length) return records.length ? { ...records.at(-1), cancelled: true } : null
    const last = candidates.at(-1)
    return new Set(candidates.map(c => this.key(c.e))).size > 1
      ? { ...last, request: { hint: '这一批有几位旅行者想分析面板，请一次指定一位和一个角色吧' } } : last
  }
  revalidate(config) {
    for (const job of this.jobs) if (!this.enabled(job.e, config) || fingerprint(config) !== job.fingerprint) job.controller.abort()
    if (!config.enabled || !buildAnalysisOptions(config).enabled) this.contexts.clear()
  }
  endSession(key) {
    for (const job of this.jobs) if (sessionKeyFor(job.e) === key) job.controller.abort()
    for (const k of this.contexts.keys()) if (k.startsWith(key + ':')) this.contexts.delete(k)
  }
  dispose() { for (const job of this.jobs) job.controller.abort(); this.contexts.clear(); this.events = new WeakMap(); this.executed.clear(); this.admissions.clear() }

  async run({ selection, config, client, service, knowledgeProvider, persona, sendText, onImage, sessionAllowed }) {
    const { e, request, version } = selection, key = this.key(e)
    const id = this.messageKey(e)
    for (const [k, at] of this.executed) if (this.now() - at > 300000) this.executed.delete(k)
    if (this.executed.has(id)) return failedResult
    this.executed.set(id, this.now())
    while (this.executed.size > 2000) this.executed.delete(this.executed.keys().next().value)
    const taskId = randomUUID(), startedAt = this.now()
    const controller = new AbortController(), job = { key, e, controller, fingerprint: fingerprint(config) }
    this.jobs.add(job)
    let imageSent = false, textSent = false, status = 'cancelled'
    const allowed = async () => {
      this.revalidate(await this.getConfig())
      return !controller.signal.aborted && version === this.versions.get(key) && await sessionAllowed()
    }
    const send = async text => {
      if (text && await allowed()) textSent = Boolean(await sendText(e, text, allowed, controller.signal)) || textSent
    }
    const timer = setTimeout(() => controller.abort(), 60000)
    const options = buildAnalysisOptions(config)
    const caps = approvedCapabilities(config), capability = caps.find(c => c.id === 'gs.panel.show')
    try {
      if (!(await allowed())) return failedResult
      if (request.hint) { await send(request.hint); status = 'clarify'; return { ...failedResult, failed: !textSent, reply: textSent ? request.hint : '' } }
      let before
      if (request.refresh) {
        const refreshCap = caps.find(c => c.id === 'gs.panel.refreshMys')
        if (!refreshCap) { await send('面板更新目前未启用，先开启更新功能或手动更新后再分析吧'); return { ...failedResult, failed: !textSent } }
        before = await abortable(this.provider.read({ e, request, capability, allowed }), controller.signal)
        await abortable(this.commands.bridge.execute({ capability: refreshCap, args: {}, original: e, allowed, onReply: onImage }), controller.signal)
      }
      const loaded = await abortable(this.provider.read({ e, request, capability, allowed }), controller.signal)
      await this.log('build_analysis_profile', { taskId, status: loaded.status,
        scoreAvailable: !!loaded.snapshot?.facts.score }, config)
      if (loaded.status !== 'ready') {
        status = loaded.status
        if (status !== 'cancelled') await send(hints[status] || hints.unavailable)
        return { ...failedResult, failed: !textSent, reply: textSent ? '面板分析未取得数据，已给出提示' : '' }
      }
      const snapshot = loaded.snapshot
      if (!(await allowed())) return failedResult
      const refreshConfirmed = !!(request.refresh && snapshot.facts.updatedAt &&
        (!before?.snapshot?.uid || before.snapshot.uid === snapshot.uid) &&
        snapshot.facts.updatedAt !== before?.snapshot?.facts.updatedAt && Date.parse(snapshot.facts.updatedAt) >= this.now() - 60000)
      // Advice does not wait for the renderer, and a rendering failure never retries an image.
      const imageTask = options.includePanelImage ? abortable(this.provider.render({ e, request, capability, snapshot, allowed,
        onReply: value => { imageSent = true; onImage?.(value) } }), controller.signal).catch(() => null) : Promise.resolve(null)
      const privateConfig = { ...config, logging: { ...config.logging, includePrompt: false, includeResponse: false },
        webSearch: { ...config.webSearch, includeSources: true,
          enabled: config.webSearch?.enabled === true && options.searchMode === 'auto' && !request.forbid },
        conversation: { ...config.conversation, selectiveGroupReply: false } }
      const publicQuery = (_kind, round) => publicBuildQuery(request.character, round)
      const providerArgs = { config: privateConfig, session: { scene: e.isGroup ? 'group' : 'private', sessionBatches: [] },
        replyBatchMessages: [{ text: (request.searchRefresh ? '重新联网核对：' : '') + publicQuery('local', 0) }],
        participantMemories: [], knowledgeRequest: {} }
      const knowledge = await readKnowledge(knowledgeProvider, providerArgs, { signal: controller.signal })
      const response = await completeWithResearch({ client, service, config: privateConfig,
        messages: buildAnalysisMessages({ facts: snapshot.facts, persona, imageRequested: options.includePanelImage,
          refreshed: request.refresh, refreshConfirmed }), knowledge, provider: knowledgeProvider, providerArgs,
        signal: controller.signal, allowed, publicQuery, trace: { type: 'build_analysis', taskId },
        log: (event, data) => this.log(event, { ...data, type: 'build_analysis', taskId }, privateConfig) })
      await imageTask
      let reply = typeof response.data?.reply === 'string' ? response.data.reply.trim().slice(0, 6000) : ''
      if (!reply) reply = '面板已经读取到，但这次还没整理出可靠的提升建议，稍后再试试吧'
      if (options.includePanelImage && !imageSent) reply += '\n这次面板图片没能发出来，先参考文字分析吧'
      await send(reply)
      if (textSent && await allowed()) {
        this.contexts.set(key, { character: request.character, targetUserId: request.targetUserId, at: this.now() })
        while (this.contexts.size > 500) this.contexts.delete(this.contexts.keys().next().value)
      }
      status = textSent ? 'complete' : 'cancelled'
    } catch {
      if (!controller.signal.aborted) { status = 'failed'; await send('这次没能完成可靠的养成分析，已有的面板可以先看看，稍后再试试吧') }
    } finally {
      clearTimeout(timer); controller.abort(); this.jobs.delete(job)
      await this.log('build_analysis_summary', { taskId, status, imageSent, textSent, game: 'gs', durationMs: this.now() - startedAt }, config)
    }
    // Keep only a non-personal outcome in conversation; never persist the DTO/advice.
    return { reply: imageSent || textSent ? '角色面板分析已处理' : '', emotion: 'neutral', origin: 'command',
      failed: !imageSent && !textSent, followUpComplete: false, followUpMeta: null }
  }
}
