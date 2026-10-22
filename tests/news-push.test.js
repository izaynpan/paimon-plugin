import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NewsPush, newsOptions } from '../lib/news-push.js'
import { NewsProvider, isPreview } from '../lib/news-provider.js'
import { NewsStore } from '../lib/news-store.js'
import { appendNewsVideoCovers } from '../lib/news-video-cover.js'
import { createNewsRenderer, newsDeliveryStatus, readLegacyNewsConfig, selectNewsBot } from '../lib/news-runtime.js'

const start = 1800000000000
const post = (id = '1', game = 'gs', type = 3, extra = {}) =>
  ({ id, game, type, title: '版本资讯', createdAt: start - 1000, ...extra })
function fixture(overrides = {}) {
  let now = start
  const config = { enabled: false, newsPush: { enabled: true } }
  const legacy = { maxNum: 0, banWord: {}, gsinfoGroup: { 11: [99], 22: [99] },
    gsannounceGroup: { 11: [99] }, srinfoGroup: { 11: [99] }, zzzinfoGroup: { 11: [99] } }
  const items = [post()]
  const calls = [], logs = [], fetches = []
  const store = { records: {}, clocks: {}, load: async () => {}, save: async () => {} }
  const service = new NewsPush({ getConfig: async () => config, getLegacy: async () => legacy,
    provider: { list: async (game, type) => { fetches.push([game, type]); return items.filter(i => i.game === game && i.type === type) } },
    store, selectBot: bots => ({ botId: bots[0] }), wasSent: async () => false,
    render: async item => item, send: async (_, item) => { calls.push(item); return 'sent' },
    now: () => now, logger: (...args) => logs.push(args), ...overrides })
  return { service, config, legacy, items, calls, logs, store, fetches, advance: n => { now += n } }
}

test('资讯默认关闭；独立于聊天开关与 Key，安全限制有效', async () => {
  assert.equal(newsOptions({}).enabled, false)
  assert.equal(newsOptions({ newsPush: { sendIntervalMs: 1 } }).gapMs, 30000)
  assert.deepEqual(newsOptions({ newsPush: { games: ['gs', 'gs', 'bad'] } }).games, ['gs'])
  const f = fixture()
  f.config.newsPush.enabled = false
  await f.service.tick()
  assert.equal(f.fetches.length, 0)
  f.config.newsPush.enabled = true
  await f.service.tick()
  assert.equal(f.calls.length, 1)
})

test('旧推送未关闭则不联网不发送；配置读取异常也停止', async () => {
  for (const maxNum of [1, null, undefined, -1]) {
    const f = fixture()
    f.legacy.maxNum = maxNum
    await f.service.tick()
    assert.equal(f.calls.length, 0)
    assert.equal(f.fetches.length, 0)
    f.legacy.maxNum = 0
    await f.service.tick()
    assert.equal(f.calls.length, 0, '原推送活跃后必须重新初始化才能接管')
  }
  const f = fixture()
  f.service.getLegacy = async () => { throw new Error('bad yaml') }
  await f.service.tick()
  assert.equal(f.calls.length, 0)
})

test('三游戏同群共用30秒间隔，多Bot订阅不会重复；不同群可同轮发送', async () => {
  const f = fixture()
  f.legacy.gsinfoGroup[11].push(98)
  f.items.push(post('2', 'sr'), post('3', 'zzz'))
  await f.service.tick()
  assert.equal(f.calls.length, 2)
  f.advance(29999)
  await f.service.tick()
  assert.equal(f.calls.length, 2)
  f.advance(1)
  await f.service.tick()
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls[2].game, 'sr')
  f.advance(30000)
  await f.service.tick()
  assert.equal(f.calls.length, 4)
  assert.equal(f.calls[3].game, 'zzz')
})

test('活动栏目只补前瞻且遵守屏蔽词，超时和未来帖子不进入队列', async () => {
  const f = fixture()
  f.legacy.banWord.gs = '屏蔽'
  f.items.splice(0, 1, post('1', 'gs', 2, { title: '《原神》X版本前瞻特别节目预告' }),
    post('2', 'gs', 2, { title: '有奖活动' }), post('3', 'gs', 2, { title: '屏蔽前瞻特别节目预告' }),
    post('4', 'gs', 3, { createdAt: start - 7200001 }), post('5', 'gs', 3, { createdAt: start + 1000 }))
  await f.service.tick()
  assert.deepEqual(f.calls.map(i => i.id), ['1'])
  assert.equal(f.service.pending.size, 0)
  assert.equal(isPreview('版本前瞻直播预告'), true)
  f.config.newsPush.includePreviews = false
  f.service.invalidate()
  f.advance(30000)
  const count = f.fetches.length
  await f.service.tick()
  assert.ok(f.fetches.slice(count).every(([, type]) => type !== 2))
})

test('旧Bot任一个去重记录存在都不重发；公告资讯重复文章同群仅一次', async () => {
  let checked
  const f = fixture({ wasSent: async (_, bots) => { checked = bots; return true } })
  await f.service.tick()
  assert.deepEqual(checked, ['11', '22'])
  assert.equal(f.calls.length, 0)
  const g = fixture()
  g.items.push(post('1', 'gs', 1))
  await g.service.tick()
  g.advance(30000)
  await g.service.tick()
  assert.equal(g.calls.length, 1)
})

test('单一栏目失败不影响其他游戏；并发抓取不超过3个', async () => {
  let active = 0, maximum = 0
  const f = fixture({ provider: { list: async (game, type) => {
    active++; maximum = Math.max(maximum, active)
    await new Promise(resolve => setTimeout(resolve, 2))
    active--
    if (game === 'gs') throw new Error('upstream')
    return game === 'sr' && type === 3 ? [post('2', 'sr')] : []
  } } })
  await f.service.tick()
  assert.equal(maximum, 3)
  assert.equal(f.calls[0].game, 'sr')
})

test('定时任务重入共用在途运行，不重复抓取或发送', async () => {
  let release
  const wait = new Promise(resolve => { release = resolve })
  const f = fixture({ render: async item => { await wait; return item } })
  const first = f.service.tick()
  assert.equal(f.service.tick(), first)
  release()
  await first
  assert.equal(f.calls.length, 1)
})

test('渲染期间关闭、撤订阅、恢复旧推送或卸载均阻止迟到发送', async () => {
  for (const change of [f => { f.config.newsPush.enabled = false }, f => { f.legacy.gsinfoGroup = {} },
    f => { f.legacy.maxNum = 1 }, f => { f.service.disposed = true; f.service.invalidate() },
    f => { f.legacy.banWord.gs = '版本' }, f => { f.config.newsPush.games = ['sr'] }]) {
    const f = fixture()
    f.service.render = async item => { change(f); return item }
    await f.service.tick()
    assert.equal(f.calls.length, 0)
  }
})

test('抓取期间重载作废旧批次；重载后可重新扫描', async () => {
  const f = fixture()
  f.service.provider.list = async () => { f.service.invalidate(); return [post()] }
  await f.service.tick()
  assert.equal(f.calls.length, 0)
  assert.equal(f.service.pending.size, 0)
})

test('写入发送预约后撤权仍不会提交消息', async () => {
  const f = fixture()
  f.store.save = async () => { f.config.newsPush.enabled = false }
  await f.service.tick()
  assert.equal(f.calls.length, 0)
  assert.equal(f.store.records['99:gs:1'], undefined)
})

test('渲染失败及明确拒绝最多尝试三次，一分钟后重试，不阻塞其他帖', async () => {
  let attempts = 0
  const f = fixture({ render: async item => {
    if (item.id === '1') { attempts++; throw new Error('render') }
    return item
  } })
  f.items.push(post('2'))
  await f.service.tick()
  f.advance(5000)
  await f.service.tick()
  assert.deepEqual(f.calls.map(i => i.id), ['2'])
  assert.equal(attempts, 1)
  for (let i = 0; i < 4; i++) { f.advance(60000); await f.service.tick() }
  assert.equal(attempts, 3)
  let sends = 0
  const g = fixture({ send: async () => { sends++; return sends === 1 ? 'failed' : 'sent' } })
  await g.service.tick()
  g.advance(30000)
  await g.service.tick()
  assert.equal(sends, 1)
  g.advance(30000)
  await g.service.tick()
  assert.equal(sends, 2)
  assert.equal(g.store.records['99:gs:1'].status, 'sent')
})

test('协议异常或回执不明记为待核查，不自动重发；成功时间决定间隔', async () => {
  const f = fixture({ send: async () => { throw new Error('connection lost') } })
  await f.service.tick()
  f.advance(60000)
  await f.service.tick()
  assert.equal(f.store.records['99:gs:1'].status, 'uncertain')
  assert.equal(f.service.pending.size, 0)
  const g = fixture()
  g.items.push(post('2'))
  g.service.send = async (_, item) => { g.calls.push(item); g.advance(20000); return 'sent' }
  await g.service.tick()
  g.advance(10000)
  await g.service.tick()
  assert.equal(g.calls.length, 1)
  g.advance(20000)
  await g.service.tick()
  assert.equal(g.calls.length, 2)
})

test('去重读取失败或日志写入失败时不冒险发送', async () => {
  const f = fixture({ wasSent: async () => { throw new Error('redis') } })
  await f.service.tick()
  assert.equal(f.calls.length, 0)
  const g = fixture()
  g.store.save = async () => { throw new Error('disk') }
  await g.service.tick()
  assert.equal(g.calls.length, 0)
  assert.equal(g.store.records['99:gs:1'], undefined, '未提交协议时写失败应撤销内存预约')
  g.store.save = async () => {}
  await g.service.tick()
  assert.equal(g.calls.length, 1)
})

test('发送回执判定覆盖空ID、部分成功、嵌套错误和明确拒绝', () => {
  assert.equal(newsDeliveryStatus({ message_id: ['a'], data: [{ message_id: 'a' }] }), 'sent')
  assert.equal(newsDeliveryStatus({ message_id: [], data: [new Error('fail')] }), 'uncertain')
  assert.equal(newsDeliveryStatus({ message_id: ['a'], data: [{ message_id: 'a' }, new Error('fail')] }), 'uncertain')
  assert.equal(newsDeliveryStatus({ retcode: 1400 }), 'failed')
  assert.equal(newsDeliveryStatus({ retcode: 1 }), 'uncertain')
  assert.equal(newsDeliveryStatus(undefined), 'uncertain')
  assert.equal(newsDeliveryStatus({ message_id: 'abc' }), 'sent')
})

test('离线Bot或不在群内的Bot跳过，选取下一个可用订阅Bot', () => {
  const group = { sendMsg() {} }
  const bots = { 11: { gl: new Map(), pickGroup: () => group },
    22: { gl: new Map([[99, {}]]), pickGroup: () => group } }
  assert.equal(selectNewsBot(['10', '11', '22'], '99', bots).botId, '22')
  assert.equal(selectNewsBot(['10', '11'], '99', bots), null)
})

test('发送记录、失败计数及群节奏跨重启保存；损坏记录禁止加载', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-news-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'delivery.json')
  const store = new NewsStore(file)
  await store.load()
  const f = fixture({ store })
  await f.service.tick()
  const restored = new NewsStore(file)
  const g = fixture({ store: restored })
  g.items.push(post('2'))
  await g.service.tick()
  assert.equal(g.calls.length, 0)
  g.advance(30000)
  await g.service.tick()
  assert.deepEqual(g.calls.map(i => i.id), ['2'])
  restored.records['99:gs:3'] = { status: 'uncertain', at: start, attempts: 1, retryAt: 0 }
  await restored.save(start)
  const uncertain = new NewsStore(file)
  const h = fixture({ store: uncertain })
  h.items.splice(0, 1, post('3'))
  h.advance(60000)
  await h.service.tick()
  assert.equal(h.calls.length, 0)
  await fs.writeFile(file, '{}')
  await assert.rejects(new NewsStore(file).load())
})

test('旧配置按genshin浅合并读取，缺失用户文件不自动创建或接管', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paimon-legacy-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const defaults = path.join(dir, 'plugins/genshin/defSet/mys')
  const user = path.join(dir, 'plugins/genshin/config')
  await fs.mkdir(defaults, { recursive: true }); await fs.mkdir(user, { recursive: true })
  await fs.writeFile(path.join(defaults, 'pushNews.yaml'), JSON.stringify({ maxNum: 1, banWord: { gs: 'a', sr: 'b' } }))
  await assert.rejects(readLegacyNewsConfig({ base: dir, parse: JSON.parse }))
  await fs.writeFile(path.join(user, 'mys.pushNews.yaml'), JSON.stringify({ maxNum: 0, banWord: { gs: 'c' } }))
  assert.deepEqual(await readLegacyNewsConfig({ base: dir, parse: JSON.parse }), { maxNum: 0, banWord: { gs: 'c' } })
})

test('公共请求使用30秒缓存桶、校验响应和超时，不访问模型API', async () => {
  let now = start
  const urls = []
  const provider = new NewsProvider({ now: () => now, fetchImpl: async url => {
    urls.push(new URL(url))
    return new Response(JSON.stringify({ retcode: 0, data: { list: [{ post: { post_id: '7', subject: '前瞻', created_at: start / 1000 } }, { post: {} }] } }))
  } })
  assert.equal((await provider.list('gs', 2))[0].id, '7')
  await provider.list('gs', 2)
  assert.equal(urls[0].searchParams.get('_paimon'), urls[1].searchParams.get('_paimon'))
  now += 30000
  await provider.list('gs', 2)
  assert.notEqual(urls[0].searchParams.get('_paimon'), urls[2].searchParams.get('_paimon'))
  assert.equal(urls[0].hostname, 'bbs-api-static.miyoushe.com')
  provider.fetch = async () => new Response('{"retcode":-1,"data":{}}')
  await assert.rejects(provider.list('gs', 3))
  provider.fetch = async () => new Response('{"retcode":0,"data":{"list":{}}}')
  await assert.rejects(provider.list('gs', 3))
  provider.fetch = async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  await assert.rejects(provider.list('gs', 3, { timeoutMs: 5 }))
})

test('复用原新闻图片渲染并替换其无超时请求，渲染空结果不发送', async () => {
  let apiCalled = false
  class Model {
    constructor(e) { assert.equal(e.isSr, true) }
    async newsDetail() { await this.postData('getPostFull', {}); return { data: { post: {} } } }
    async render() { return ['image'] }
    replyMsg(img, title) { return [title, ...img] }
  }
  const render = createNewsRenderer({ request: async () => { apiCalled = true } }, async () => ({ default: Model }))
  const options = { signal: new AbortController().signal }
  const result = await render(post('1', 'sr'), { botId: '11' }, options)
  assert.equal(apiCalled, true)
  assert.equal(result[0], '崩坏星穹铁道资讯推送：版本资讯')
  Model.prototype.render = async () => []
  await assert.rejects(render(post('1', 'sr'), { botId: '11' }, options))
})

test('视频资讯在实际渲染参数中补封面，不新增标题标注、原帖链接或请求', async () => {
  const cover = 'https://upload-bbs.miyoushe.com/upload/example-cover.jpg'
  const original = '原始正文\n第二行'
  let calls = 0, captured
  class Model {
    async newsDetail() {
      const result = await this.postData('getPostFull', {})
      return { dataConent: result.data.post.post.content, data: result.data.post }
    }
    async render(param) { captured = param; return ['image'] }
    replyMsg(img, title) { return [title, ...img] }
  }
  const render = createNewsRenderer({ request: async () => {
    calls++
    return { data: { post: { post: { content: original, images: [], structured_content: JSON.stringify([
      { insert: original }, { insert: { vod: { cover, resolutions: [{ url: 'https://example.com/video.mp4' }] } } },
    ]) } } } }
  } }, async () => ({ default: Model }))
  for (const game of ['gs', 'sr', 'zzz']) {
    const result = await render(post('1', game), { botId: '11' }, { signal: new AbortController().signal })
    assert.ok(captured.dataConent.startsWith(original))
    assert.ok(captured.dataConent.includes(`<img src="${cover}"`))
    assert.equal(captured.data.post.content, original)
    assert.equal(/<a\b|视频资讯|article\/|video\.mp4/.test(captured.dataConent), false)
    assert.equal(result.length, 2)
    assert.ok(result[0].endsWith('资讯推送：版本资讯'))
  }
  assert.equal(calls, 3)
})

test('普通图文、缺少封面或结构化字段损坏时正文逐字保留', () => {
  const body = '<p>普通图文</p><img src="https://upload-bbs.miyoushe.com/original.png">'
  for (const value of [undefined, null, '', '{bad', '{}', 'null', '[]', '[null,{},1]',
    [{ insert: { image: 'https://upload-bbs.miyoushe.com/another.png' } }], [{ insert: { vod: {} } }]])
    assert.equal(appendNewsVideoCovers(body, value), body)
  assert.equal(appendNewsVideoCovers(undefined, []), undefined)
})

test('多个视频按原顺序补图，重复封面和正文已有封面不重复添加', () => {
  const first = 'https://upload-bbs.miyoushe.com/first.png'
  const second = 'https://upload-bbs.miyoushe.com/second.jpg'
  const operations = [first, first, second].map(cover => ({ insert: { vod: { cover } } }))
  const html = appendNewsVideoCovers('正文', operations)
  assert.equal((html.match(/<img /g) || []).length, 2)
  assert.ok(html.indexOf(first) < html.indexOf(second))
  assert.equal(appendNewsVideoCovers(html, operations), html)
  const existing = `<img src='${first}?x-oss-process=image/resize,w_600'>`
  assert.equal(appendNewsVideoCovers(existing, operations).split(first).length - 1, 1)
  const lazy = `<img data-src="${first}">`
  assert.ok(appendNewsVideoCovers(lazy, operations).includes(`<img src="${first}"`))
})

test('封面只接收合法官方HTTPS图片地址，属性转义不引入HTML', () => {
  const invalid = ['javascript:alert(1)', 'file:///etc/passwd', 'http://127.0.0.1/a',
    'https://127.0.0.1/a', 'https://miyoushe.com.evil.example/a', 'https://user:pass@upload-bbs.miyoushe.com/a',
    'https://upload-bbs.miyoushe.com:123/a', {}, null]
  assert.equal(appendNewsVideoCovers('原文', invalid.map(cover => ({ insert: { vod: { cover } } }))), '原文')
  const html = appendNewsVideoCovers('原文', [{ insert: { vod: { cover: 'https://upload-bbs.miyoushe.com/a.png?a=1&b="<>\'' } } }])
  assert.ok(html.includes('&amp;b='))
  assert.equal(html.includes('<>'), false)
  assert.equal((html.match(/<img /g) || []).length, 1)
})
