import test from 'node:test'
import assert from 'node:assert/strict'
import { GachaError, selectSrAccount, selectSrToken, gachaJson, requestSrAuthKey,
  srLogApi, syncSrGacha, SrGachaService } from '../lib/sr-gacha.js'
import { prepareSrGacha } from '../lib/sr-gacha-runtime.js'

const account = { uid: '100000001', ltuid: '111', region: 'prod_gf_cn' }
const response = data => ({ ok: true, json: async () => data })
const row = (id, uid = account.uid) => ({ id, uid })
function event(msg = '#星铁更新抽卡记录') {
  const replies = []
  return { msg, user_id: '12345', self_id: '88888', isGroup: true, replies,
    reply: async text => { replies.push(text); return { message_id: 1 } },
    user: { getUid: game => { assert.equal(game, 'sr'); return account.uid },
      getUidData: (uid, game) => { assert.equal(game, 'sr'); return { uid, type: 'ck', ltuid: '111' } } } }
}
function modelFixture() {
  const saved = new Map(), requests = [], fullFlags = []
  const model = {
    pool: [[11, '角色'], [12, '光锥'], [21, '角色联动'], [22, '光锥联动'], [1, '常驻'], [2, '新手']]
      .map(([type, typeName]) => ({ type, typeName })),
    isFetchFullLog: async () => false,
    setFetchFullLog: async flag => { fullFlags.push(flag) },
    readJson() { const list = saved.get(this.type) || []; return { list, ids: new Map(list.map(r => [r.id, r.id])) } },
    async getAllLog(ids, key) {
      requests.push([this.type, key, ids])
      const result = await this.logApi({ gacha_type: this.type })
      return { hasErr: false, list: result.data.list.filter(r => this.fetchFullLog || !ids.has(r.id)) }
    },
    mergeGachaData(remote, local) { return [...remote, ...local.filter(r => !remote.some(item => item.id === r.id))] },
    writeJson(rows) { saved.set(this.type, rows) },
  }
  return { model, saved, requests, fullFlags }
}

test('星铁扫码更新只匹配星铁入口；关闭开关不接管', async () => {
  const calls = []
  const service = new SrGachaService({ getConfig: async () => ({ srGacha: { enabled: true } }),
    prepare: async e => { calls.push(e.msg); return async () => ({ ok: true, lines: [] }) } })
  for (const msg of ['#更新抽卡记录', '%更新抽卡记录', '#绝区零更新抽卡记录', '*导出抽卡记录', '*获取抽卡记录', '*更新抽卡记录123'])
    assert.equal(await service.handle(event(msg)), false)
  for (const msg of ['*更新抽卡记录', '＊刷新抽卡记录', '#星铁更新抽卡记录']) {
    service.cooldowns.clear()
    assert.equal(await service.handle(event(msg)), true)
  }
  assert.equal(calls.length, 3)
  service.getConfig = async () => ({ srGacha: { enabled: false } })
  assert.equal(await service.handle(event()), false)
})

test('只选择消息发送者当前星铁CK账号，不采用消息中的 UID/被@用户/原神 UID', () => {
  const e = event()
  Object.assign(e, { at: '54321', uid: '200000002', msg: '#星铁更新抽卡记录' })
  assert.deepEqual(selectSrAccount(e), account)
  e.user.getUidData = () => ({ uid: account.uid, type: 'reg', ltuid: '111' })
  assert.throws(() => selectSrAccount(e), /扫码登录/)
  e.user_id = '../other'
  assert.throws(() => selectSrAccount(e), /无法识别/)
})

test('国服官服/B服正确区分；不把海外账号发送给国服接口', () => {
  const e = event()
  e.user.getUid = () => '500000001'
  assert.equal(selectSrAccount(e).region, 'prod_qd_cn')
  e.user.getUid = () => '800000001'
  assert.throws(() => selectSrAccount(e), /其他区服/)
})

test('凭证按米游社账号匹配，兼容旧单条格式，缺失/注入/v2无mid均拒绝', () => {
  const right = { stuid: 111, stoken: 'v2_FAKE', mid: 'fake-mid' }
  const records = { '200000009': { stuid: 222, stoken: 'wrong' }, '200000001': right }
  assert.equal(selectSrToken(records, '111'), 'stuid=111;stoken=v2_FAKE;mid=fake-mid;')
  assert.equal(selectSrToken(right, '111'), selectSrToken(records, '111'))
  for (const bad of [{}, { stuid: 111, stoken: 'v2_FAKE' }, { stuid: 111, stoken: 'fake;stuid=222' },
    { stuid: 111, stoken: 'fake', mid: 'bad\r\nheader' }])
    assert.throws(() => selectSrToken(bad, '111'), /扫码凭证/)
})

test('换取凭证采用星铁game_biz、UID及区服，不发送原神参数', async () => {
  const calls = []
  const fetcher = async (url, options) => { calls.push({ url, ...options }); return response({ retcode: 0, data: { authkey: 'fake-key' } }) }
  assert.equal(await requestSrAuthKey({ fetcher, account, headers: { Cookie: 'fake' } }), 'fake-key')
  assert.equal(calls[0].url, 'https://api-takumi.mihoyo.com/binding/api/genAuthKey')
  assert.deepEqual(JSON.parse(calls[0].body), { auth_appid: 'webview_gacha', game_biz: 'hkrpg_cn', game_uid: 100000001, region: 'prod_gf_cn' })
  assert.equal(calls[0].redirect, 'error')
  assert.ok(calls[0].signal instanceof AbortSignal)
})

test('网络异常/官方错误正文不会泄露凭证', async () => {
  await assert.rejects(gachaJson(async () => { throw new Error('authkey=SECRET') }, 'https://example.test'),
    e => e instanceof GachaError && !e.message.includes('SECRET'))
  await assert.rejects(requestSrAuthKey({ account, fetcher: async () => response({ retcode: -100, message: 'SECRET' }) }),
    e => /扫码登录/.test(e.message) && !e.message.includes('SECRET'))
})

test('普通池与联动池接口、分页参数正确；空池成功；错UID及坏响应拒绝', async () => {
  const urls = []
  const api = srLogApi(async url => { urls.push(new URL(url)); return response({ retcode: 0, data: { list: [] } }) }, account, 'a+b/c=')
  await api({ gacha_type: 11, page: 3, end_id: '900000000000000001' })
  await api({ gacha_type: 21 })
  await api({ gacha_type: 22 })
  assert.match(urls[0].pathname, /\/getGachaLog$/)
  assert.match(urls[1].pathname, /\/getLdGachaLog$/)
  assert.match(urls[2].pathname, /\/getLdGachaLog$/)
  assert.equal(urls[0].searchParams.get('page'), '3')
  assert.equal(urls[0].searchParams.get('end_id'), '900000000000000001')
  assert.equal(urls[0].searchParams.get('authkey'), 'a+b/c=')
  assert.equal(urls[0].searchParams.get('region'), 'prod_gf_cn')
  for (const data of [{ retcode: 0, data: { list: [row('1', '200000002')] } }, { retcode: 0, data: {} }, { retcode: -101 }])
    await assert.rejects(srLogApi(async () => response(data), account, 'secret')({ gacha_type: 11 }), GachaError)
})

test('六类池复用分页和存储，已有记录保留，空角色池不阻断其他池', async () => {
  const { model, saved, requests } = modelFixture()
  saved.set(12, [row('1')])
  const api = async ({ gacha_type }) => ({ data: { list: gacha_type === 11 ? [] : [row('2'), row('1')] } })
  const result = await syncSrGacha(model, account, 'fake-key', api)
  assert.equal(result.ok, true)
  assert.equal(requests.length, 6)
  assert.equal(model.uid, account.uid)
  assert.equal(saved.has(11), false)
  assert.deepEqual(saved.get(12).map(r => r.id), ['2', '1'])
  assert.match(result.lines[1], /新增 1 条/)
  await syncSrGacha(model, account, 'fake-key', api)
  assert.equal(saved.get(12).length, 2)
})

test('全量更新沿用原合并逻辑，保留历史记录，成功后关闭一次性标志', async () => {
  const { model, saved, fullFlags } = modelFixture()
  model.isFetchFullLog = async () => true
  saved.set(11, [row('2'), row('1')])
  const result = await syncSrGacha(model, account, 'fake', async () => ({ data: { list: [row('3'), row('2')] } }))
  assert.equal(result.ok, true)
  assert.deepEqual(saved.get(11).map(r => r.id), ['3', '2', '1'])
  assert.deepEqual(fullFlags, [false])
  assert.match(result.lines[0], /新增 1 条/)
})

test('中途失败保留已成功卡池，失败池旧记录不动，不假报全部成功', async () => {
  const { model, saved, requests, fullFlags } = modelFixture()
  model.isFetchFullLog = async () => true
  saved.set(12, [row('1')])
  const result = await syncSrGacha(model, account, 'fake', async ({ gacha_type }) => {
    if (gacha_type === 12) throw new Error('SECRET')
    return { data: { list: [row('2')] } }
  })
  assert.equal(result.ok, false)
  assert.equal(requests.length, 2)
  assert.deepEqual(saved.get(12), [row('1')])
  assert.deepEqual(saved.get(11), [row('2')])
  assert.deepEqual(fullFlags, [])
  assert.ok(!JSON.stringify(result).includes('SECRET'))
})

test('同用户跨群/机器人并发只执行一次，冷却不依赖聊天开关和Key', async () => {
  let finish, now = 0, calls = 0
  const pending = new Promise(resolve => { finish = resolve })
  const service = new SrGachaService({ getConfig: async () => ({ enabled: false, srGacha: { enabled: true, cooldownMs: 30000 } }),
    now: () => now, prepare: async () => { calls++; return () => pending } })
  const first = service.handle(event())
  await new Promise(resolve => setImmediate(resolve))
  const second = event(); second.self_id = '99999'; second.group_id = '99999'
  await service.handle(second)
  assert.match(second.replies[0], /正在更新/)
  finish({ ok: true, lines: [] }); await first
  await service.handle(second)
  assert.match(second.replies[1], /30 秒/)
  assert.equal(calls, 1)
  now = 30001
  await service.handle(second)
  assert.equal(calls, 2)
})

test('凭证准备失败后释放锁，可扫码后重试，异常正文不出现在回复', async () => {
  const e = event()
  const service = new SrGachaService({ getConfig: async () => ({ srGacha: { enabled: true } }), prepare: async () => { throw new Error('SECRET') } })
  await service.handle(e)
  assert.equal(service.running.size, 0)
  assert.equal(service.cooldowns.size, 0)
  assert.ok(!e.replies.join('').includes('SECRET'))
})

test('运行适配读取本人凭证，用当前米游社账号选取；不构造原神凭证对象或修改原事件', async () => {
  const e = event(), { model } = modelFixture(), calls = []
  let derived, readPath
  class Api {
    constructor() { throw new Error('must not choose GS credentials') }
    getDs() { return 'fake-ds' }
    getHeaders(_, type) { assert.equal(type, 'authKey'); return { DS: this.getDs(), Cookie: this.cookies, Host: 'api-takumi.mihoyo.com' } }
  }
  class Model { constructor(value) { derived = value; return model } }
  const fetcher = async (url, options) => {
    calls.push([url, options])
    return response(url.includes('genAuthKey') ? { retcode: 0, data: { authkey: 'fake-key' } } : { retcode: 0, data: { list: [] } })
  }
  const task = await prepareSrGacha(e, account, {
    load: async () => [{ default: Api }, { default: Model }, { default: { parse: JSON.parse } }, { default: fetcher }],
    readFile: async url => { readPath = url.pathname; return JSON.stringify({ wrong: { stuid: 222, stoken: 'wrong' },
      right: { stuid: 111, stoken: 'v2_FAKE', mid: 'mid' } }) },
  })
  assert.match(readPath, /xiaoyao-cvs-plugin\/data\/yaml\/12345.yaml$/)
  assert.equal(calls.length, 0)
  assert.equal((await task()).ok, true)
  assert.equal(calls.length, 7)
  assert.match(calls[0][1].headers.Cookie, /stuid=111;/)
  assert.equal(derived.isSr, true)
  assert.equal(e.msg, '#星铁更新抽卡记录')
  assert.equal(e.cookie, undefined)
  assert.equal(e.authkey, undefined)
})
