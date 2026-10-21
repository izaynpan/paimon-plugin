export const newsGames = { gs: 2, sr: 6, zzz: 8 }
export const newsNames = { gs: '原神', sr: '崩坏星穹铁道', zzz: '绝区零' }

// Deliberately narrow: the activity feed also contains contests and giveaways.
export function isPreview(subject) {
  return /前瞻.*(?:特别节目|直播)|特别节目.*预告/u.test(subject)
}

export class NewsProvider {
  constructor({ fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now } = {}) {
    this.fetch = fetchImpl
    this.now = now
  }

  async request(action, params, { signal, timeoutMs = 10000 } = {}) {
    const list = action === 'getNewsList'
    const paths = {
      getNewsList: 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList',
      getPostFull: 'https://bbs-api.miyoushe.com/post/wapi/getPostFull',
      emoticon: 'https://bbs-api.miyoushe.com/misc/api/emoticon_set',
    }
    if (!paths[action]) throw new Error('news_unsupported_action')
    const url = new URL(paths[action])
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    // A shared 30-second bucket avoids repeatedly using a ten-minute CDN entry.
    // This does not guarantee that upstream publication itself has no delay.
    if (list) url.searchParams.set('_paimon', String(Math.floor(this.now() / 30000)))
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, timeoutMs)
    try {
      const response = await this.fetch(url.toString(), {
        signal: controller.signal,
        headers: { Referer: 'https://www.miyoushe.com', 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' },
      })
      if (!response.ok) throw new Error(`news_http_${response.status}`)
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 4 * 1024 * 1024) { abort(); throw new Error('news_response_too_large') }
        chunks.push(Buffer.from(chunk))
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (controller.signal.aborted) throw new Error('news_request_aborted')
      if (result?.retcode !== 0 || !result.data) throw new Error('news_api_error')
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async list(game, type, options) {
    const result = await this.request('getNewsList', { gids: newsGames[game], type, page_size: 20 }, options)
    if (!Array.isArray(result.data.list)) throw new Error('news_invalid_list')
    return result.data.list.flatMap(({ post } = {}) => {
      if (!post || !/^\d{1,20}$/.test(String(post.post_id)) || typeof post.subject !== 'string' ||
          !Number.isFinite(Number(post.created_at)) || Number(post.created_at) <= 0) return []
      return [{ game, type, id: String(post.post_id), title: post.subject.slice(0, 500), createdAt: Number(post.created_at) * 1000 }]
    })
  }
}
