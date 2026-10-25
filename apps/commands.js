import plugin from '../../../lib/plugins/plugin.js'
import { paimonRuntime, paimonLog } from '../lib/paimon-runtime.js'

export class PaimonCommandObserver extends plugin {
  constructor() {
    super({ name: '派蒙指令观察', event: 'message', priority: -100000,
      rule: [{ reg: '^[#＃*＊%％]', fnc: 'loginGuide', log: false }] })
  }
  async accept(e) {
    try { await paimonRuntime.commands.observe(e); await paimonRuntime.commands.rewritePanelRefresh(e) }
    catch { paimonLog('warn', '指令回复观察不可用') }
    return false
  }
  async loginGuide(e) { return paimonRuntime.commands.loginGuide(e) }
}
export class PaimonCommandSuggestion extends plugin {
  constructor() {
    super({ name: '派蒙指令纠错', event: 'message', priority: 99998,
      rule: [{ reg: '', fnc: 'suggest', log: false }] })
  }
  async suggest(e) {
    try { return await paimonRuntime.commands.suggest(e) }
    catch { paimonLog('warn', '指令纠错本轮跳过'); return false }
  }
}
