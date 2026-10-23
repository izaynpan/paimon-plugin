import fs from 'node:fs/promises'
import vm from 'node:vm'

// Unmodified local TRSS loader snapshot. Only its dependencies are mocked;
// tests execute the real deal/accept/rule/permission/context implementation.
const source = await fs.readFile(new URL('../fixtures/framework-loader.txt', import.meta.url), 'utf8')
export function createCommandLoader(Runtime) {
  const cfg = { bot: {}, master: {}, getGroup: () => ({}), getOther: () => ({}) }
  const color = value => value
  const loader = vm.runInNewContext(source.replace(/^import .*$/gm, '')
    .replace('global.plugin = plugin', '').replace('global.segment = segment', '')
    .replace('export default new PluginsLoader()', 'new PluginsLoader()'), {
    cfg, Runtime, setTimeout, clearTimeout,
    logger: { blue: color, yellow: color, green: color, cyan: color, red: color },
    Bot: { makeLog() {}, getTimeDiff() { return '' }, String: String },
    lodash: { isEmpty: value => !Object.keys(value || {}).length, truncate: String },
  })
  return { loader, cfg, Runtime }
}
