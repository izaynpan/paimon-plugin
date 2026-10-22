// Explicit command adapter. Credentials never enter the chat/model pipeline.
export const srGachaRule = '^(?:[*＊]|[#＃]星铁)(?:更新|刷新)抽卡记录$'
const command = new RegExp(srGachaRule)
const loginHelp = '请先私聊发送 #扫码登录，并切换到要更新的星铁 UID 后重试。'
export class GachaError extends Error {}

export function selectSrAccount(e) {
  if (!/^\d{1,20}$/.test(String(e.user_id || ''))) throw new GachaError('无法识别当前用户。')
  const uid = String(e.user?.getUid?.('sr') || '')
  const data = e.user?.getUidData?.(uid, 'sr')
  if (!uid || data?.type !== 'ck' || !/^\d+$/.test(String(data.ltuid || '')) || String(data.uid) !== uid)
    throw new GachaError(`当前星铁 UID 未绑定有效登录凭证。${loginHelp}`)
  if (!/^[125]\d{8}$/.test(uid))
    throw new GachaError('扫码更新暂支持星铁国服；其他区服请继续使用原抽卡链接导入功能。')
  return { uid, ltuid: String(data.ltuid), region: uid[0] === '5' ? 'prod_qd_cn' : 'prod_gf_cn' }
}

export function selectSrToken(records, ltuid) {
  const entries = records?.stuid ? [records] : Object.values(records || {})
  const token = entries.find(t => t && String(t.stuid) === ltuid && typeof t.stoken === 'string' && t.stoken)
  const valid = v => typeof v === 'string' && /^[A-Za-z0-9._~+\/-]+=*$/.test(v) && v.length <= 8192
  if (!token || !valid(token.stoken) || token.mid && !valid(token.mid) ||
      token.stoken.startsWith('v2_') && !token.mid)
    throw new GachaError(`当前星铁账号没有可用的扫码凭证。${loginHelp}`)
  return `stuid=${ltuid};stoken=${token.stoken};${token.mid ? `mid=${token.mid};` : ''}`
}

export async function gachaJson(fetcher, url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetcher(url, { ...options, signal: controller.signal, redirect: 'error' })
    if (!response.ok) throw new Error('http')
    return await response.json()
  } catch {
    // Fetch errors can contain the URL/authkey. Never forward the raw error.
    throw new GachaError('星铁抽卡接口请求失败或超时，请稍后重试。')
  } finally { clearTimeout(timer) }
}

export async function requestSrAuthKey({ fetcher, headers, account }) {
  const res = await gachaJson(fetcher, 'https://api-takumi.mihoyo.com/binding/api/genAuthKey', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_appid: 'webview_gacha', game_biz: 'hkrpg_cn',
      game_uid: Number(account.uid), region: account.region }),
  })
  if (res?.retcode !== 0 || typeof res.data?.authkey !== 'string' || !res.data.authkey)
    throw new GachaError(`星铁抽卡凭证获取失败。${loginHelp}`)
  return res.data.authkey
}

export function srLogApi(fetcher, account, authkey) {
  return async ({ gacha_type, page = 1, end_id = 0 }) => {
    const action = [21, 22].includes(Number(gacha_type)) ? 'getLdGachaLog' : 'getGachaLog'
    const query = new URLSearchParams({ authkey_ver: '1', lang: 'zh-cn', game_biz: 'hkrpg_cn',
      authkey, region: account.region, gacha_type, page, end_id, size: 20 })
    const result = await gachaJson(fetcher,
      `https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/${action}?${query}`)
    if (result?.retcode !== 0 || !Array.isArray(result.data?.list))
      throw new GachaError('星铁抽卡记录读取失败，请稍后重试；如持续失败，请重新 #扫码登录。')
    if (result.data.list.some(row => String(row?.uid) !== account.uid || !/^\d+$/.test(String(row?.id || ''))))
      throw new GachaError('返回的抽卡记录与当前星铁账号不匹配，已停止更新。')
    return result
  }
}

export async function syncSrGacha(model, account, authkey, logApi) {
  for (const method of ['getAllLog', 'readJson', 'writeJson', 'mergeGachaData', 'isFetchFullLog', 'setFetchFullLog'])
    if (typeof model[method] !== 'function') throw new GachaError('当前 genshin 抽卡模块不兼容，请联系主人更新适配。')
  if (!Array.isArray(model.pool) || model.pool.length !== 6 ||
      ![11, 12, 21, 22, 1, 2].every(type => model.pool.some(p => p.type === type)))
    throw new GachaError('当前 genshin 星铁卡池配置不兼容，请联系主人更新适配。')
  model.uid = account.uid
  model.logApi = logApi
  model.fetchFullLog = await model.isFetchFullLog()
  const results = []
  for (const pool of model.pool) {
    model.type = pool.type
    model.typeName = pool.typeName
    try {
      const local = model.readJson()
      const remote = await model.getAllLog(local.ids, authkey)
      if (remote?.hasErr || !Array.isArray(remote?.list)) throw new Error('records')
      const added = remote.list.filter(row => !local.ids.has(String(row.id))).length
      if (remote.list.length) {
        const merged = model.fetchFullLog ? model.mergeGachaData(remote.list, local.list) : remote.list.concat(local.list)
        model.writeJson(merged)
      }
      results.push(`[${pool.typeName}]新增 ${added} 条`)
    } catch {
      // Stop on failure; previously saved pools remain intact and retries dedupe.
      return { ok: false, lines: [...results, `[${pool.typeName}]更新失败，后续卡池未更新，请稍后重试。`] }
    }
  }
  if (model.fetchFullLog) await model.setFetchFullLog(false)
  return { ok: true, lines: results }
}

export class SrGachaService {
  constructor({ getConfig, prepare, now = Date.now }) {
    Object.assign(this, { getConfig, prepare, now })
    this.running = new Set()
    this.cooldowns = new Map()
  }
  async handle(e) {
    if (!command.test(String(e.msg || ''))) return false
    const config = await this.getConfig()
    if (config.srGacha?.enabled !== true) return false
    const key = String(e.user_id)
    const reply = text => e.reply(text, false, { at: !!e.isGroup })
    if (this.running.has(key)) { await reply('星铁抽卡记录正在更新，请等待本次完成。'); return true }
    for (const [id, until] of this.cooldowns) if (until <= this.now()) this.cooldowns.delete(id)
    if (this.cooldowns.has(key)) {
      await reply(`请在 ${Math.ceil((this.cooldowns.get(key) - this.now()) / 1000)} 秒后再更新星铁抽卡记录。`)
      return true
    }
    this.running.add(key)
    try {
      const account = selectSrAccount(e)
      const task = await this.prepare(e, account)
      const cooldown = Number(config.srGacha.cooldownMs)
      this.cooldowns.set(key, this.now() + (Number.isFinite(cooldown) ? Math.min(3600000, Math.max(30000, cooldown)) : 300000))
      await reply(`星铁 UID ${account.uid} 抽卡记录获取中，请稍等……`)
      const result = await task()
      await reply([`星铁 UID ${account.uid} 抽卡记录${result.ok ? '更新完成' : '未全部更新成功'}`, ...result.lines,
        '可发送 *抽卡记录 或 *全部记录 查看。'].join('\n'))
    } catch (error) {
      await reply(error instanceof GachaError ? error.message : '星铁抽卡记录更新失败，请联系主人检查依赖或稍后重试。')
    } finally { this.running.delete(key) }
    return true
  }
}
