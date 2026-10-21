import plugin from '../../../lib/plugins/plugin.js'
import { newsRuntime } from '../lib/news-runtime.js'

export class PaimonNews extends plugin {
  constructor() {
    super({ name: '派蒙资讯推送', dsc: '原神、星铁、绝区零公告资讯与前瞻预告', rule: [],
      task: { name: '派蒙资讯推送', cron: '*/5 * * * * *', log: false, fnc: () => newsRuntime.service.tick() } })
  }

  async init() {
    try {
      await newsRuntime.initialize()
      this.addCleanup?.(() => newsRuntime.dispose(), () => newsRuntime.initialize())
    } catch {
      globalThis.Bot?.makeLog?.('error', '资讯推送初始化失败，请检查派蒙配置', 'PaimonNews')
      return 'return'
    }
  }
}
