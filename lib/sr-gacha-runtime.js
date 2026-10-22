import fs from 'node:fs/promises'
import { PaimonConfig } from './config.js'
import { GachaError, SrGachaService, selectSrToken, requestSrAuthKey, srLogApi, syncSrGacha } from './sr-gacha.js'

const config = new PaimonConfig()
export async function prepareSrGacha(e, account, { readFile = fs.readFile, load = () => Promise.all([
  import('../../xiaoyao-cvs-plugin/model/mys/mihoyoApi.js'),
  import('../../genshin/model/gachaLog.js'), import('yaml'), import('node-fetch'),
]) } = {}) {
  let Api, Model, parse, fetcher
  try {
    const modules = await load()
    Api = modules[0].default; Model = modules[1].default
    parse = modules[2].default.parse; fetcher = modules[3].default
  } catch {
    throw new GachaError('星铁扫码更新需要已安装的逍遥插件和 genshin 抽卡模块，请联系主人检查。')
  }
  let records
  try {
    records = parse(await readFile(new URL(`../../xiaoyao-cvs-plugin/data/yaml/${e.user_id}.yaml`, import.meta.url), 'utf8'))
  } catch {
    throw new GachaError('未找到扫码登录凭证，请先私聊发送 #扫码登录。')
  }
  const cookie = selectSrToken(records, account.ltuid)
  // No constructor: it otherwise selects credentials using a Genshin UID.
  // Reuse only the installed provider's stateless DS/header implementation.
  const api = Object.assign(Object.create(Api.prototype), { cookies: cookie, isOs: false })
  if (typeof api.getHeaders !== 'function' || typeof api.getDs !== 'function')
    throw new GachaError('当前逍遥插件的凭证接口不兼容，请联系主人更新适配。')
  const headers = api.getHeaders(undefined, 'authKey')
  if (!headers?.DS || headers.Cookie !== cookie || headers.Host !== 'api-takumi.mihoyo.com')
    throw new GachaError('当前逍遥插件的凭证请求格式已变化，请联系主人更新适配。')
  // A separate event keeps the original command free of credentials and mutations.
  const derived = { user_id: e.user_id, self_id: e.self_id, game: 'sr', isSr: true,
    isGroup: e.isGroup, isPrivate: e.isPrivate, msg: '#星铁更新抽卡记录',
    logFnc: '[派蒙星铁抽卡]', reply: e.reply.bind(e) }
  const model = new Model(derived)
  return async () => {
    const authkey = await requestSrAuthKey({ fetcher, headers, account })
    return syncSrGacha(model, account, authkey, srLogApi(fetcher, account, authkey))
  }
}

export const srGachaService = new SrGachaService({ getConfig: () => config.reload(), prepare: prepareSrGacha })
