import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { commandManifest } from './command-bridge.js'

// Only public game dictionaries. Never load plugin entry points or user data.
export class CommandEntities {
  constructor(bridge) { this.bridge = bridge; this.cache = null }
  async index() {
    if (this.cache && Date.now() - this.cache.at < 60000) return this.cache.value
    const value = new Map()
    const put = (game, kind, alias, name = alias) => {
      if (![alias, name].every(s => typeof s === 'string' && s.length >= 2 && s.length <= 40 && !/[#*%\r\n<>/\\]/.test(s))) return
      const key = `${game}:${kind}`
      if (!value.has(key)) value.set(key, new Map())
      value.get(key).set(alias.toLowerCase(), name)
    }
    try {
      const { loader } = await this.bridge.deps()
      if (loader.priority.some(p => p.key === 'miao-plugin') &&
          await this.bridge.compatible(commandManifest.targets['miao-plugin/profile:profileDetail'])) {
        const { default: Meta } = await this.bridge.importModule(pathToFileURL(path.join(this.bridge.root, 'plugins/miao-plugin/components/Meta.js')).href)
        for (const game of ['gs', 'sr']) for (const [kind, type] of [['character', 'char'], ['weapon', 'weapon'], ['equipment', 'artiSet'], ['artifact', 'artiSet'], ['material', 'material']]) {
          const meta = Meta.create(game, type)
          for (const alias of [...Object.keys(meta.data), ...Object.keys(meta.alias), ...Object.keys(meta.alias2)]) {
            const data = meta.getData(alias)
            if (data?.name) {
              put(game, kind, alias, data.name)
              put(game, kind, data.name)
              if (kind === 'character' || kind === 'weapon') put(game, 'item', alias, data.name)
              if (kind === 'weapon') put(game, 'equipment', alias, data.name)
            }
          }
        }
      }
    } catch { /* Optional dictionaries fail closed, without a plugin import fallback. */ }
    const read = async file => { try { return JSON.parse(await fs.readFile(path.join(this.bridge.root, file), 'utf8')) } catch { return {} } }
    const partners = await read('plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json')
    for (const data of Object.values(partners)) for (const name of [data.name, data.full_name]) if (name) put('zzz', 'character', name, data.name)
    const yaml = async file => {
      try {
        const text = await fs.readFile(path.join(this.bridge.root, file), 'utf8')
        const { default: YAML } = await import('yaml')
        return YAML.parse(text) || {}
      } catch { return {} }
    }
    for (const file of ['plugins/ZZZ-Plugin/defSet/alias.yaml', 'plugins/ZZZ-Plugin/config/alias.yaml']) {
      const aliases = await yaml(file)
      for (const [name, names] of Object.entries(aliases)) if (value.get('zzz:character')?.has(name.toLowerCase()) && Array.isArray(names))
        for (const alias of names) put('zzz', 'character', alias, name)
    }
    const enemies = await yaml('plugins/Atlas/resource/enemy/OtherName.yaml')
    for (const [name, aliases] of Object.entries(enemies)) {
      put('gs', 'enemy', name)
      if (Array.isArray(aliases)) for (const alias of aliases) put('gs', 'enemy', alias, name)
    }
    for (const [game, library] of [['gs', 'Genshin-Atlas'], ['sr', 'star-rail-atlas'], ['zzz', 'zzz-atlas']]) {
      const atlas = await read(`plugins/Atlas/${library}/path.json`)
      for (const [category, entries] of Object.entries(atlas)) {
        const kind = /material for role|角色材料|突破/.test(category) ? 'character'
          : /角色|character|^role$/.test(category) ? 'character'
          : /weapon|武器|lightcone|光锥|音擎/.test(category) ? 'weapon'
          : /artifact|relic|圣遗物|遗器/.test(category) ? 'equipment'
          : /enemy|原魔|敌人/.test(category) ? 'enemy'
          : /card|七圣|卡牌/.test(category) ? 'card'
          : /material|specialty|材料|特产/.test(category) ? 'material' : null
        if (!kind || !entries || typeof entries !== 'object') continue
        for (const name of Object.keys(entries)) {
          put(game, kind, name)
          if (kind === 'equipment') put(game, 'artifact', name)
          if (kind === 'character' || kind === 'weapon') put(game, 'item', name)
          if (kind === 'weapon') put(game, 'equipment', name)
        }
      }
    }
    this.cache = { at: Date.now(), value }
    return value
  }
  async resolve(game, kind, value) { return (await this.index()).get(`${game}:${kind}`)?.get(String(value).toLowerCase()) || null }
  async inText(game, kind, text) {
    return [...((await this.index()).get(`${game}:${kind}`) || [])].filter(([alias]) => text.toLowerCase().includes(alias))
      .sort((a, b) => b[0].length - a[0].length).slice(0, 8)
  }
  async suggest(game, kind, fragment) {
    if (fragment.length < 3) return []
    return [...((await this.index()).get(`${game}:${kind}`) || [])].filter(([alias]) =>
      alias.length === fragment.length && [...alias].filter((char, i) => char !== fragment[i]).length === 1).slice(0, 3)
  }
}

export async function validateArguments(capability, input, entities) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(capability.slots, k))) return null
  const result = {}
  for (const [key, slot] of Object.entries(capability.slots)) {
    let value = input[key] ?? slot.default
    if (slot.entity) {
      if (typeof value !== 'string' || value.length > 40 || /[#*%\r\n<>/\\]/.test(value)) return null
      value = await entities.resolve(capability.game, slot.entity, value)
      if (!value) return null
    } else if (slot.values) {
      if (!slot.values.includes(value)) return null
    } else if (slot.min !== undefined) {
      if (!Number.isInteger(value) || value < slot.min || value > slot.max) return null
    } else if (slot.pattern) {
      if (typeof value !== 'string' || value.length > 15 || !(new RegExp(slot.pattern)).test(value)) return null
    } else return null
    result[key] = value
  }
  return result
}
