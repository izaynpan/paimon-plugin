import { commandCatalog, commandText, selectedRows } from '../lib/command-catalog.js'

// Historical script name retained for existing operator instructions.
// No imports of the framework/plugins, no credentials, network or dispatch.
let errors = 0
const ids = new Set()
for (const c of commandCatalog) {
  const args = Object.fromEntries(Object.entries(c.slots).map(([key, s]) =>
    [key, s.default ?? (s.entity ? '示例名称' : s.pattern ? '5.1' : s.min)]))
  const command = commandText(c, args, true)
  if (ids.has(c.id) || !/^[#*%]/.test(command) || /[\r\n{}]/.test(command)) {
    errors++; console.log('模板异常：' + c.id)
  }
  ids.add(c.id)
}
console.log(`已检查 ${selectedRows.length} 个批准功能族、${commandCatalog.length} 个标准指令模板，异常 ${errors} 项。`)
console.log('已取消 Git 版本/文件哈希锁定。此检查不代表功能在线；实际由运行中的框架按当前规则、权限和插件状态处理。')
if (errors) process.exitCode = 1
