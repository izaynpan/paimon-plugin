import plugin from '../../../lib/plugins/plugin.js'
import { startRenderGuard } from '../lib/render-guard-runtime.js'

export class PaimonResources extends plugin {
  constructor() { super({ name: '派蒙资源管理', dsc: '受限截图队列与本地浏览器回收', rule: [] }) }
  async init() {
    let runtime
    const initialize = async () => { runtime = await startRenderGuard() }
    try { await initialize() }
    catch {
      globalThis.Bot?.makeLog?.('error', 'render_guard_init_failed: 资源管理未启用，请检查渲染器兼容性', 'PaimonMemory')
      return 'return'
    }
    this.addCleanup?.(() => runtime?.dispose(), initialize)
  }
}
