const timeout = Symbol('timeout')
async function bounded(promise, ms) {
  let timer
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(timeout), ms) })]) }
  finally { clearTimeout(timer) }
}

// One renderer instance, one queue. No global prototype changes or process kills.
export class RenderGuard {
  constructor(renderer, { ownsBrowser, refresh = async () => {}, forget = async () => {},
    log = () => {}, renderTimeoutMs = 60000, closeTimeoutMs = 5000, settleTimeoutMs = 2000,
    maxQueue = 20, pageTimeoutMs = 30000 } = {}) {
    Object.assign(this, { renderer, ownsBrowser, refresh, forget, log, renderTimeoutMs,
      closeTimeoutMs, settleTimeoutMs, maxQueue, pageTimeoutMs })
    this.queue = []
    this.disposed = false
    this.blocked = false
    this.active = false
    this.recycle = false
    this.managed = new WeakSet()
  }

  install() {
    const r = this.renderer
    if (!r || r.id !== 'puppeteer' || typeof r.browserInit !== 'function' ||
        typeof r.restart !== 'function' || typeof r.screenshot !== 'function' || !this.ownsBrowser ||
        r.config?.wsEndpoint || r.paimonRenderGuard) throw new Error('render_guard_incompatible')
    const names = ['browserInit', 'restart', 'screenshot', 'render', 'captureScreenshot', 'puppeteerTimeout', 'pageGotoParams']
    this.original = Object.fromEntries(names.map(name => [name, { own: Object.hasOwn(r, name), value: r[name] }]))
    this.originalLaunchTimeout = r.config?.timeout
    this.originalProtocolTimeout = r.config?.protocolTimeout
    this.initOriginal = r.browserInit.bind(r)
    // Queue before the framework's template lock so same-template requests are bounded too.
    this.entry = 'screenshot'
    this.captureOriginal = r[this.entry].bind(r)
    this.wrappedEntry = (...args) => this.enqueue(args)
    r[this.entry] = this.wrappedEntry
    if (this.entry === 'screenshot' && this.original.render.value === this.original.screenshot.value)
      r.render = this.wrappedEntry
    r.browserInit = () => this.initBrowser()
    r.restart = force => this.requestRecycle(force)
    // The original watchdog restarts browsers without awaiting outstanding work.
    // The guard instead closes, waits for settlement, then admits the next job.
    r.puppeteerTimeout = 0
    r.pageGotoParams = { ...r.pageGotoParams, timeout: this.pageTimeoutMs }
    if (r.config) {
      r.config.timeout = 8000
      r.config.protocolTimeout = this.renderTimeoutMs
    }
    r.paimonRenderGuard = this
    return this
  }

  async initBrowser() {
    if (this.disposed || this.blocked || this.closing) return false
    if (this.initializing) return this.initializing
    this.initializing = (async () => {
      const browser = await this.initOriginal()
      if (!browser) return false
      if (!this.managed.has(browser)) {
        if (!(await this.ownsBrowser(browser))) {
          this.blocked = true
          this.log('error', 'render_guard_unowned: 无法确认浏览器归属，停止接管截图，不关闭该实例')
          throw new Error('render_guard_unowned')
        }
        this.managed.add(browser)
      }
      if (this.disposed || this.blocked) { await this.closeBrowser(); return false }
      await this.renew(browser)
      return browser
    })().finally(() => { this.initializing = null })
    return this.initializing
  }

  async renew(browser = this.renderer.browser) {
    if (!browser || !this.managed.has(browser) || this.disposed || this.closing) return
    try { await this.refresh(browser, this.renderer.browserMacKey) }
    catch { this.log('warn', 'render_guard_cache_refresh_failed') }
  }

  enqueue(args) {
    if (this.disposed || this.blocked) return Promise.resolve(false)
    if (this.queue.length >= this.maxQueue) {
      this.log('warn', 'render_guard_queue_full: 截图队列已满，本次不接纳')
      return Promise.resolve(false)
    }
    return new Promise(resolve => { this.queue.push({ args, resolve }); void this.pump() })
  }

  async pump() {
    if (this.active) return
    this.active = true
    try {
      while (this.queue.length && !this.disposed && !this.blocked) {
        const job = this.queue.shift()
        let value = false
        try { value = await this.run(job.args) }
        catch { this.log('warn', 'render_guard_capture_failed') }
        job.resolve(value)
      }
    } finally {
      this.active = false
      if (this.disposed || this.blocked) for (const job of this.queue.splice(0)) job.resolve(false)
    }
  }

  async run(args) {
    if (this.closing) await this.closing
    if (this.recycle) await this.closeBrowser()
    if (this.disposed || this.blocked) return false
    this.recycle = false
    const work = Promise.resolve().then(() => this.captureOriginal(...args))
    // Convert rejection before racing, so timed-out tasks never reject unobserved.
    const settled = work.then(value => ({ value }), () => ({ value: false, error: true }))
    const result = await bounded(settled, this.renderTimeoutMs)
    if (result === timeout) {
      this.log('warn', 'render_guard_timeout: 截图超时，关闭本实例后再处理队列')
      await this.closeBrowser()
      if (await bounded(settled, this.settleTimeoutMs) === timeout) {
        this.blocked = true
        this.log('error', 'render_guard_unsettled: 旧截图未结束，停止新任务，请检查后重启')
      }
      return false
    }
    if (result.error || this.recycle) await this.closeBrowser()
    if (this.disposed) return false
    return result.value
  }

  requestRecycle(force = false) {
    if (this.disposed || this.closing) return Promise.resolve(false)
    const r = this.renderer
    if (!force && (!r.renderNum || r.renderNum % (r.restartNum || 100) !== 0)) return Promise.resolve(false)
    this.recycle = true
    // The next screenshot initializes lazily. Disconnection never launches a browser.
    if (!this.active) return this.closeBrowser()
    return Promise.resolve(false)
  }

  async closeBrowser() {
    if (this.closing) return this.closing
    const r = this.renderer, browser = r.browser
    if (!browser) { this.recycle = false; return }
    this.closing = (async () => {
      if (!this.managed.has(browser) && !(await this.ownsBrowser(browser))) {
        this.blocked = true
        this.log('error', 'render_guard_close_unowned: 未关闭归属不明的浏览器')
        return
      }
      this.managed.add(browser)
      r.browser = false
      const result = await bounded(Promise.resolve().then(() => browser.close()).then(() => true, () => false), this.closeTimeoutMs)
      if (result !== true) {
        // Keep a reference for a subsequent cleanup attempt; never launch a duplicate.
        r.browser = browser
        this.blocked = true
        this.log('error', 'render_guard_close_failed: 关闭未确认，禁止启动重复浏览器')
        return
      }
      try { await this.forget(browser, r.browserMacKey) } catch { this.log('warn', 'render_guard_cache_clear_failed') }
      r.shoting = []
      this.recycle = false
    })().finally(() => { this.closing = null })
    return this.closing
  }

  async dispose() {
    this.disposed = true
    for (const job of this.queue.splice(0)) job.resolve(false)
    if (this.initializing) await bounded(this.initializing.catch(() => {}), 8500)
    await this.closeBrowser()
  }

  async uninstall() {
    await this.dispose()
    // Do not restore methods while a timed-out operation can still be executing.
    if (this.active || this.initializing || this.blocked) throw new Error('render_guard_restart_required')
    const r = this.renderer
    for (const [name, original] of Object.entries(this.original)) {
      if (original.own) r[name] = original.value
      else delete r[name]
    }
    if (r.config) {
      if (this.originalLaunchTimeout === undefined) delete r.config.timeout
      else r.config.timeout = this.originalLaunchTimeout
      if (this.originalProtocolTimeout === undefined) delete r.config.protocolTimeout
      else r.config.protocolTimeout = this.originalProtocolTimeout
    }
    delete r.paimonRenderGuard
  }
}
