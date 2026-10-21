import { isPreview, newsGames } from './news-provider.js'

const bounded = (v, fallback, min, max) => Number.isFinite(Number(v)) && v !== null && v !== ''
  ? Math.min(max, Math.max(min, Number(v))) : fallback
export function newsOptions(config = {}) {
  const c = config.newsPush || {}
  return {
    enabled: c.enabled === true,
    games: [...new Set((Array.isArray(c.games) ? c.games : ['gs', 'sr', 'zzz']).filter(g => Object.hasOwn(newsGames, g)))],
    pollMs: bounded(c.pollIntervalMs, 30000, 30000, 600000),
    gapMs: bounded(c.sendIntervalMs, 30000, 30000, 600000),
    maxAgeMs: bounded(c.maxAgeHours, 2, 0.5, 24) * 3600000,
    timeoutMs: bounded(c.requestTimeoutMs, 10000, 1000, 30000),
    previews: c.includePreviews !== false,
  }
}

export function newsRoutes(item, legacy) {
  const config = legacy[`${item.game}${item.type === 1 ? 'announce' : 'info'}Group`]
  const routes = new Map()
  for (const [botId, groups] of Object.entries(config || {})) {
    if (!/^\d+$/.test(botId) || !Array.isArray(groups)) continue
    for (const group of groups) {
      const groupId = String(group)
      if (!/^\d+$/.test(groupId)) continue
      if (!routes.has(groupId)) routes.set(groupId, [])
      if (!routes.get(groupId).includes(botId)) routes.get(groupId).push(botId)
    }
  }
  return routes
}

function eligible(item, options, legacy, now) {
  if (!options.games.includes(item.game) || now - item.createdAt > options.maxAgeMs || item.createdAt > now) return false
  if (item.type === 2 && (!options.previews || !isPreview(item.title))) return false
  const pattern = legacy.banWord?.[item.game]
  // A malformed pattern fails this source closed, rather than dropping all filtering.
  if (pattern && new RegExp(pattern).test(item.title)) return false
  return true
}

export class NewsPush {
  constructor({ getConfig, getLegacy, provider, store, selectBot, wasSent, render, send,
    now = Date.now, logger = () => {} }) {
    Object.assign(this, { getConfig, getLegacy, provider, store, selectBot, wasSent, render, send, now, logger })
    this.pending = new Map()
    this.nextPoll = 0
    this.disposed = false
    this.generation = 0
    this.warnings = new Map()
    this.takeoverReady = true
  }

  warn(code) {
    if (this.now() < (this.warnings.get(code) || 0)) return
    this.warnings.set(code, this.now() + 300000)
    this.logger('warn', code)
  }

  invalidate() {
    this.generation++
    this.controller?.abort()
    this.pending.clear()
    this.nextPoll = 0
  }

  async dispose() {
    this.disposed = true
    this.invalidate()
    await this.running
  }

  async context() {
    const options = newsOptions(await this.getConfig())
    if (this.disposed || !options.enabled) return null
    if (!this.takeoverReady) {
      this.warn('news_restart_required: 原推送曾处于开启状态；请设 maxNum=0 后重启 Yunzai 再接管')
      return null
    }
    const legacy = await this.getLegacy()
    if (legacy.maxNum !== 0 && legacy.maxNum !== '0') {
      this.takeoverReady = false
      this.warn('news_legacy_active: 请先将 genshin 用户推送配置 maxNum 设为 0；本轮不接管')
      return null
    }
    return { options, legacy }
  }

  tick() {
    if (this.running || this.disposed) return this.running || Promise.resolve()
    this.running = this.run().catch(error => {
      const code = /^(news_[a-z_]+|E[A-Z]+)$/.test(error?.code || error?.message || '') ? (error.code || error.message) : 'invalid_state'
      this.warn(`news_tick_failed ${code}: 本轮暂停，请检查配置、接口或推送记录文件`)
    })
      .finally(() => { this.running = null })
    return this.running
  }

  async run() {
    const ctx = await this.context()
    if (!ctx) { this.invalidate(); return }
    await this.store.load()
    if (!this.journalChecked) {
      this.journalChecked = true
      for (const [key, value] of Object.entries(this.store.records))
        if (value.status === 'uncertain' && this.now() - value.at < 48 * 3600000)
          this.logger('warn', `news_uncertain ${key}: 恢复了未确认发送记录，请核查；不自动重发`)
    }
    const generation = this.generation
    this.controller = new AbortController()
    const signal = this.controller.signal
    if (this.now() >= this.nextPoll) {
      this.nextPoll = this.now() + ctx.options.pollMs
      await this.poll(ctx, signal)
    }
    if (this.disposed || signal.aborted || generation !== this.generation) return
    const groups = new Set()
    const ordered = [...this.pending.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt || a[1].id.localeCompare(b[1].id))
    for (const [key, item] of ordered) {
      if (this.disposed || signal.aborted || generation !== this.generation) break
      const latest = await this.context()
      if (!latest) { this.invalidate(); break }
      if (!eligible(item, latest.options, latest.legacy, this.now()) || !newsRoutes(item, latest.legacy).has(item.groupId)) {
        this.pending.delete(key)
        continue
      }
      const record = this.store.records[key]
      if (record && (record.status !== 'failed' || record.attempts >= 3)) { this.pending.delete(key); continue }
      if (record?.retryAt > this.now() || groups.has(item.groupId) ||
          this.now() - (this.store.clocks[item.groupId] ?? -Infinity) < latest.options.gapMs) continue
      const bots = newsRoutes(item, latest.legacy).get(item.groupId)
      const target = this.selectBot(bots, item.groupId)
      if (!target) { this.warn('news_no_bot: 部分订阅群暂无可用机器人'); continue }
      // Read every configured bot's original dedup key, since the new queue is per group.
      if (await this.wasSent(item, bots)) {
        this.store.records[key] = { status: 'sent', at: this.now(), attempts: 0, retryAt: 0 }
        await this.store.save(this.now())
        this.pending.delete(key)
        continue
      }
      groups.add(item.groupId)
      let message
      try {
        message = await this.render(item, target, { signal, timeoutMs: latest.options.timeoutMs })
        if (!message) throw new Error('news_empty_render')
      } catch {
        if (!signal.aborted) await this.fail(key, record)
        continue
      }
      const final = await this.context()
      if (!final || signal.aborted || generation !== this.generation) break
      const finalBots = newsRoutes(item, final.legacy).get(item.groupId) || []
      if (!eligible(item, final.options, final.legacy, this.now()) || !finalBots.includes(target.botId) ||
          !this.selectBot([target.botId], item.groupId)) continue
      if (this.now() - (this.store.clocks[item.groupId] ?? -Infinity) < final.options.gapMs) continue
      const attempts = (record?.attempts || 0) + 1
      // Journal before protocol submission. A crash or ambiguous acknowledgement must
      // not turn into an automatic duplicate on restart.
      this.store.records[key] = { status: 'uncertain', at: this.now(), attempts, retryAt: 0 }
      const previousClock = this.store.clocks[item.groupId]
      this.store.clocks[item.groupId] = this.now()
      try { await this.store.save(this.now()) }
      catch (error) {
        if (record) this.store.records[key] = record
        else delete this.store.records[key]
        if (previousClock === undefined) delete this.store.clocks[item.groupId]
        else this.store.clocks[item.groupId] = previousClock
        throw error
      }
      const beforeSend = await this.context()
      if (!beforeSend || signal.aborted || generation !== this.generation ||
          !eligible(item, beforeSend.options, beforeSend.legacy, this.now()) ||
          !newsRoutes(item, beforeSend.legacy).get(item.groupId)?.includes(target.botId)) {
        delete this.store.records[key]
        await this.store.save(this.now())
        continue
      }
      let status = 'uncertain'
      try { status = await this.send(target, message) } catch {}
      this.store.clocks[item.groupId] = this.now()
      if (status === 'sent') {
        this.store.records[key] = { status, at: this.now(), attempts, retryAt: 0 }
        this.pending.delete(key)
        this.logger('mark', `news_sent ${item.game}/${item.id} group=${item.groupId}`)
      } else if (status === 'failed') {
        await this.fail(key, record)
      } else {
        this.pending.delete(key)
        this.logger('warn', `news_uncertain ${item.game}/${item.id} group=${item.groupId}: 回执不明确，请核查；不自动重发`)
      }
      await this.store.save(this.now())
    }
  }

  async fail(key, previous) {
    this.store.records[key] = { status: 'failed', at: this.now(), attempts: (previous?.attempts || 0) + 1, retryAt: this.now() + 60000 }
    await this.store.save(this.now())
    this.logger('warn', `news_failed ${key}: 最多尝试三次，重试至少间隔一分钟`)
  }

  async poll({ options, legacy }, signal) {
    const jobs = options.games.flatMap(game => [1, 3, ...(options.previews ? [2] : [])]
      .filter(type => newsRoutes({ game, type }, legacy).size)
      .map(type => ({ game, type })))
    let cursor = 0
    // Bound total requests to three concurrent public reads; one failed feed does
    // not prevent other games/categories from entering the queue.
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => {
      while (cursor < jobs.length && !signal.aborted) {
        const { game, type } = jobs[cursor++]
        try {
          const items = await this.provider.list(game, type, { signal, timeoutMs: options.timeoutMs })
          if (signal.aborted) return
          for (const item of items) {
            if (!eligible(item, options, legacy, this.now())) continue
            for (const groupId of newsRoutes(item, legacy).keys()) {
              const key = `${groupId}:${game}:${item.id}`
              const record = this.store.records[key]
              if (record && (record.status !== 'failed' || record.attempts >= 3)) continue
              if (this.pending.size >= 2000 && !this.pending.has(key)) { this.warn('news_queue_full'); continue }
              this.pending.set(key, { ...item, groupId })
            }
          }
        } catch { if (!signal.aborted) this.warn(`news_source_failed ${game}/${type}`) }
      }
    }))
  }
}
