import fs from "node:fs/promises"
import path from "node:path"
import { pluginRoot } from "./paths.js"

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function deepMerge(base, override) {
  if (!isObject(base)) return override
  const result = { ...base }
  if (!isObject(override)) return result
  for (const [key, value] of Object.entries(override))
    result[key] = isObject(value) && isObject(base[key]) ? deepMerge(base[key], value) : value
  return result
}

async function readYaml(file, parser) {
  const content = await fs.readFile(file, "utf8")
  if (parser) return parser(content) || {}
  const { default: YAML } = await import("yaml")
  return YAML.parse(content) || {}
}

export class PaimonConfig {
  constructor({ root = pluginRoot, env = process.env, watcherFactory, yamlParser } = {}) {
    this.root = path.resolve(root)
    this.env = env
    this.watcherFactory = watcherFactory
    this.yamlParser = yamlParser
    this.configDir = path.join(this.root, "config")
    this.defaultFile = path.join(this.configDir, "default.yaml")
    this.userFile = path.join(this.configDir, "config.yaml")
    this.cache = null
    this.persona = ""
    this.stickers = {}
    this.watcher = null
    this.loading = null
  }

  async ensureUserConfig() {
    await fs.mkdir(this.configDir, { recursive: true })
    try {
      await fs.access(this.userFile)
    } catch {
      await fs.copyFile(this.defaultFile, this.userFile)
    }
  }

  async load({ force = false } = {}) {
    if (this.cache && !force) return this.cache
    if (this.loading) return this.loading
    this.loading = (async () => {
      await this.ensureUserConfig()
      const defaults = await readYaml(this.defaultFile, this.yamlParser)
      const user = await readYaml(this.userFile, this.yamlParser)
      const config = deepMerge(defaults, user)
      const personaFile = path.resolve(this.configDir, config.persona?.file || "persona.md")
      const stickerFile = path.resolve(this.configDir, config.stickers?.configFile || "stickers.yaml")
      this.persona = await fs.readFile(personaFile, "utf8").catch(() => "")
      this.stickers = await readYaml(stickerFile, this.yamlParser).catch(() => ({}))
      const envName = String(config.deepseek?.apiKeyEnv || "DEEPSEEK_API_KEY")
      config.deepseek.apiKey = String(this.env[envName] || config.deepseek?.apiKey || "").trim()
      this.cache = config
      return config
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async reload() {
    this.cache = null
    return this.load({ force: true })
  }

  async startWatching(onReload) {
    await this.load()
    if (this.watcher) return this.watcher
    const watcherFactory =
      this.watcherFactory || (await import("chokidar")).default.watch
    this.watcher = watcherFactory(this.configDir, { ignoreInitial: true })
    this.watcher.on("change", async () => {
      try {
        const config = await this.reload()
        onReload?.(config)
        globalThis.Bot?.makeLog?.("mark", "paimon-plugin 配置已重新加载", "Paimon")
      } catch (error) {
        globalThis.Bot?.makeLog?.("error", ["paimon-plugin 配置重载失败", error], "Paimon")
      }
    })
    return this.watcher
  }

  async close() {
    await this.watcher?.close?.()
    this.watcher = null
  }

  getPersona() {
    return this.persona
  }

  getStickers() {
    return this.stickers
  }
}

export const configManager = new PaimonConfig()
export { pluginRoot }
