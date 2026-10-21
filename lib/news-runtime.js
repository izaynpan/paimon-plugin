import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PaimonConfig } from './config.js'
import { pluginRoot } from './paths.js'
import { NewsProvider, newsGames, newsNames } from './news-provider.js'
import { NewsStore } from './news-store.js'
import { NewsPush } from './news-push.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
export async function readLegacyNewsConfig({ base = root, parse } = {}) {
  parse ||= (await import('yaml')).default.parse
  const defaults = parse(await fs.readFile(path.join(base, 'plugins/genshin/defSet/mys/pushNews.yaml'), 'utf8'))
  const user = parse(await fs.readFile(path.join(base, 'plugins/genshin/config/mys.pushNews.yaml'), 'utf8'))
  if (!defaults || !user || typeof defaults !== 'object' || typeof user !== 'object' ||
      Array.isArray(defaults) || Array.isArray(user)) throw new Error('news_legacy_config')
  // Same shallow merge as gsCfg.getConfig; reread so subscription removal and
  // re-enabling the old sender are checked immediately before delivery.
  return { ...defaults, ...user }
}

export function selectNewsBot(botIds, groupId, bots = globalThis.Bot) {
  for (const botId of botIds) {
    const bot = bots?.[botId]
    if (!bot?.pickGroup) continue
    if (bot.gl instanceof Map && !bot.gl.has(Number(groupId)) && !bot.gl.has(groupId)) continue
    try {
      const group = bot.pickGroup(Number(groupId))
      if (group?.sendMsg) return { botId, bot, group, groupId }
    } catch {}
  }
  return null
}

// In particular, OneBot's wrapper can resolve to { message_id: [], data: [Error] }.
// Resolving a promise alone is not a successful delivery acknowledgement.
export function newsDeliveryStatus(result) {
  const hasId = value => Array.isArray(value) ? value.length > 0 && value.every(hasId) :
    (typeof value === 'string' && value.length > 0 && value !== '0') || (typeof value === 'number' && Number.isFinite(value) && value !== 0)
  const children = Array.isArray(result?.data) ? result.data : null
  if (children?.length) {
    if (children.every(child => hasId(child?.message_id))) return 'sent'
    if (children.every(child => Number.isInteger(child?.retcode) && child.retcode !== 0 && child.retcode !== 1 && !hasId(child.message_id))) return 'failed'
    return 'uncertain'
  }
  if (hasId(result?.message_id)) return 'sent'
  if (Number.isInteger(result?.retcode) && result.retcode !== 0 && result.retcode !== 1) return 'failed'
  return 'uncertain'
}

export function createNewsRenderer(provider, importModel = () => import('../../genshin/model/mysNews.js')) {
  return async (item, target, options) => {
    const { default: Model } = await importModel()
    const model = new Model({ isGroup: true, group_id: item.groupId, self_id: target.botId,
      group: target.group, bot: target.bot, isSr: item.game === 'sr', game: item.game })
    if (typeof model.newsDetail !== 'function' || typeof model.render !== 'function' || typeof model.replyMsg !== 'function')
      throw new Error('news_renderer_incompatible')
    // Reuse formatting, not the original scheduler/random delay/cache writes.
    model.postData = (action, params) => provider.request(action, params, options)
    const param = await model.newsDetail(item.id, newsGames[item.game])
    if (!param?.data?.post || options.signal.aborted) throw new Error('news_detail_unavailable')
    const image = await model.render(param)
    if (!image || (Array.isArray(image) && (!image.length || image.some(i => !i)))) throw new Error('news_render_failed')
    if (options.signal.aborted) throw new Error('news_render_cancelled')
    return model.replyMsg(image, `${newsNames[item.game]}${item.type === 1 ? '公告' : '资讯'}推送：${item.title}`)
  }
}

export function createNewsRuntime() {
  // Own watcher/lifecycle: disabling chat, removing its key, or its whitelist does
  // not affect these explicitly configured news subscriptions.
  const config = new PaimonConfig()
  const provider = new NewsProvider()
  const logger = (level, message) => globalThis.Bot?.makeLog?.(level, message, 'PaimonNews')
  const service = new NewsPush({
    getConfig: () => config.load(), getLegacy: () => readLegacyNewsConfig(), provider,
    store: new NewsStore(path.join(pluginRoot, 'data/news-push/delivery.json')),
    selectBot: selectNewsBot,
    wasSent: async (item, botIds) => {
      if (!globalThis.redis?.get) throw new Error('news_redis_unavailable')
      for (const botId of botIds)
        if (await globalThis.redis.get(`Yz:${item.game}:mys:newPush:${botId}:${item.groupId}:${item.id}`)) return true
      return false
    },
    render: createNewsRenderer(provider),
    send: async (target, message) => newsDeliveryStatus(await target.group.sendMsg(message)),
    logger,
  })
  return {
    service,
    async initialize() {
      service.disposed = false
      await config.reload()
      try {
        const legacy = await readLegacyNewsConfig()
        service.takeoverReady = legacy.maxNum === 0 || legacy.maxNum === '0'
      } catch { service.takeoverReady = false }
      await config.startWatching(() => service.invalidate())
    },
    async dispose() {
      await service.dispose()
      await config.close()
    },
  }
}

export const newsRuntime = createNewsRuntime()
