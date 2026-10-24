import { fileURLToPath } from 'node:url'
import { PaimonConfig } from './config.js'
import { RenderGuard } from './render-guard.js'
import { ownsLocalBrowser } from './render-browser-owner.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const log = (level, msg) => globalThis.Bot?.makeLog?.(level, msg, 'PaimonMemory')
const ttl = 30 * 86400

export async function startRenderGuard({ config = new PaimonConfig(), getLoader = async () =>
  (await import('../../../lib/renderer/loader.js')).default } = {}) {
  const settings = await config.load()
  if (settings.resourceGuard?.enabled !== true) return null
  const loader = await getLoader()
  const renderer = loader.getRenderer('puppeteer')
  const number = (key, fallback, min, max) => {
    const v = Number(settings.resourceGuard[key])
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  }
  const guard = new RenderGuard(renderer, {
    ownsBrowser: browser => ownsLocalBrowser(browser, root), log,
    renderTimeoutMs: number('renderTimeoutMs', 60000, 10000, 120000),
    pageTimeoutMs: number('pageTimeoutMs', 30000, 5000, 60000),
    maxQueue: number('maxQueue', 20, 1, 50),
    refresh: async (browser, key) => {
      if (!key) return
      const endpoint = browser.wsEndpoint(), current = await redis.get(key)
      if (current === endpoint) await redis.expire(key, ttl)
      else if (!current) await redis.set(key, endpoint, { EX: ttl, NX: true })
    },
    forget: async (browser, key) => {
      if (key && await redis.get(key) === browser.wsEndpoint()) await redis.del(key)
    },
  }).install()
  for (const other of loader.renderers.values()) guard.attachRenderer(other)
  const onExit = () => guard.dispose()
  Bot.on('exit', onExit)
  const timer = setInterval(() => { void guard.renew() }, 300000)
  timer.unref?.()
  log('mark', `render_guard_ready: 后端=${[...loader.renderers.keys()].join(',')}，共享截图并发=1，队列有界，退出回收及缓存续期已开启`)
  return { guard, async dispose() {
    clearInterval(timer)
    Bot.off('exit', onExit)
    await guard.uninstall()
  } }
}
