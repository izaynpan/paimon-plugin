import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CommandBridge, commandManifest } from '../lib/command-bridge.js'

// Read-only diagnostic. Never imports the Yunzai loader or starts a plugin.
const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('../../../', import.meta.url))
const bridge = new CommandBridge({ root })
const framework = await bridge.revisionMatches('.', commandManifest.revisions.framework)
console.log(`框架版本：${framework ? '匹配' : '未匹配/不可读取'}（要求 ${commandManifest.revisions.framework}）`)
let compatible = 0
for (const [id, target] of Object.entries(commandManifest.targets)) {
  const ok = await bridge.compatible(target)
  if (ok) compatible++
  console.log(`${ok ? 'OK' : '待核对'} ${id}`)
}
console.log(`兼容签名匹配 ${compatible}/${Object.keys(commandManifest.targets).length}；还需运行时已加载、权限、群开关及业务数据允许。`)
if (compatible !== Object.keys(commandManifest.targets).length) process.exitCode = 1
