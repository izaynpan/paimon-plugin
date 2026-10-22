import plugin from '../../../lib/plugins/plugin.js'
import { srGachaRule } from '../lib/sr-gacha.js'
import { srGachaService } from '../lib/sr-gacha-runtime.js'

export class PaimonSrGacha extends plugin {
  constructor() {
    super({ name: '派蒙星铁抽卡更新', dsc: '使用扫码登录凭证更新星铁抽卡记录',
      event: 'message', priority: 50, rule: [{ reg: srGachaRule, fnc: 'update', log: false }] })
  }
  async update(e) { return srGachaService.handle(e) }
}
