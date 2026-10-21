import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { pluginRoot } from "./paths.js"
import { stickerProfiles, intensityLevels } from "./sticker-intent.js"

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const sequence = name => /^(\d+)(?:[-_\s]|$)/.test(name) ? Number.parseInt(name, 10) : null
const strings = value => Array.isArray(value) && value.every(x => typeof x === "string")

// Resolve each component with exact case, rejecting links even on Windows.
export async function exactStickerFile(root, relative) {
  if (typeof relative !== "string" || relative.includes("\\") || !relative.startsWith("stickers/")) throw Error("invalid_path")
  const parts = relative.split("/")
  if (parts.length !== 3 || parts.some(x => !x || x === "." || x === ".." || x.includes(":")) || !/\.png$/i.test(parts[2]))
    throw Error("invalid_path")
  let current = path.resolve(root)
  for (const part of parts) {
    if (!(await fs.readdir(current)).includes(part)) throw Error("missing_or_case_mismatch")
    current = path.join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink()) throw Error("linked_asset")
  }
  const realRoot = await fs.realpath(root), real = await fs.realpath(current)
  const rel = path.relative(realRoot, real)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !(await fs.stat(real)).isFile()) throw Error("outside_assets")
  return real
}

export class StickerCatalog {
  constructor({ root = pluginRoot } = {}) { this.root = root; this.cached = null }

  async load() {
    const file = path.join(this.root, "docs/stickers/catalog.json")
    const aliasesFile = path.join(this.root, "docs/stickers/character-aliases.json")
    const stats = await Promise.all([fs.stat(file), fs.stat(aliasesFile)])
    const signature = stats.map(s => [s.size, s.mtimeMs, s.ctimeMs].join(":")).join("|")
    if (signature !== this.cached?.signature) {
      const [catalog, aliases] = await Promise.all([file, aliasesFile].map(async f => JSON.parse(await fs.readFile(f, "utf8"))))
      if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.items) || !aliases.aliases) throw Error("invalid_catalog")
      const ids = new Set(), paths = new Set(), items = []
      for (const item of catalog.items) {
        if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.path !== "string" || paths.has(item.path))
          throw Error("duplicate_or_invalid_catalog_entry")
        ids.add(item.id); paths.add(item.path)
        if (item.candidateEligible !== true || !["annotated", "reviewed"].includes(item.reviewStatus)) continue
        const parts = item.path.split("/")
        if (!/^stk_[a-f0-9]{16}$/.test(item.id) || item.id !== `stk_${digest(Buffer.from(item.path)).slice(0, 16)}` ||
            !/^[a-f0-9]{64}$/.test(item.contentHash) || parts.length !== 3 || parts[0] !== "stickers" ||
            sequence(parts[1]) !== item.directorySequence || !stickerProfiles.has(item.semanticProfile) ||
            !Object.hasOwn(intensityLevels, item.intensity) || typeof item.visibleDescription !== "string" ||
            ![item.expressionSubject, item.emotions, item.intents, item.topics, item.suitableContexts,
              item.unsuitableContexts, item.notes, item.visibleText].every(strings) ||
            !item.expressionSubject.length || item.expressionSubject.includes("未知") ||
            !item.suitableContexts.length || item.confidence?.contextualMeaning === "low") continue
        items.push(item)
      }
      this.cached = { signature, items, aliases: aliases.aliases }
    }
    const source = path.join(this.root, "stickers")
    if ((await fs.lstat(source)).isSymbolicLink()) throw Error("linked_asset_root")
    const directories = (await fs.readdir(source, { withFileTypes: true }))
      .filter(d => d.isDirectory() && !d.isSymbolicLink() && sequence(d.name) !== null)
      .sort((a, b) => sequence(b.name) - sequence(a.name) || a.name.localeCompare(b.name, "en"))
    return { ...this.cached, latestDirectories: new Set(directories.slice(0, 5).map(d => d.name)) }
  }

  async readImage(item) {
    const file = await exactStickerFile(this.root, item.path)
    const bytes = await fs.readFile(file)
    if (digest(bytes) !== item.contentHash) throw Error("changed_asset")
    return bytes
  }
}

export function groundedCharacters(intent, { current, reply, recent }, catalog) {
  const names = new Set(catalog.items.flatMap(x => x.expressionSubject))
  const normalize = name => Object.entries(catalog.aliases).find(([canonical, aliases]) =>
    canonical === name || aliases.includes(name))?.[0] || name
  const result = []
  for (const c of intent.characters) {
    const name = normalize(c.name)
    if (!names.has(name) || name === "派蒙") continue
    const aliases = [name, ...(catalog.aliases[name] || [])]
    if (!aliases.some(alias => c.evidence.includes(alias)) || !String(({ current, reply, recent })[c.source] || "").includes(c.evidence)) continue
    if (c.source === "recent" && (!c.reference || !current.includes(c.reference))) continue
    result.push(name)
  }
  return [...new Set(result)]
}

const concreteProfiles = new Set("cold cook drink eat fight gift hungry money perform reading reward secret sing sleep work".split(" "))

export function stickerCandidates(catalog, intent, context) {
  const characters = groundedCharacters(intent, context, catalog)
  const pools = { paimon: [], character: [], recent: [] }
  for (const item of catalog.items) {
    if (!intent.profiles.includes(item.semanticProfile) || intensityLevels[item.intensity] > intensityLevels[intent.intensity]) continue
    const topicMatches = item.topics.filter(topic => intent.topics.includes(topic)).length
    if (concreteProfiles.has(item.semanticProfile) && !topicMatches) continue
    const paimon = item.paimonSelfExpression === true && item.expressionSubject.length === 1 && item.expressionSubject[0] === "派蒙"
    const topical = item.expressionSubject.some(name => characters.includes(name))
    const pool = paimon ? "paimon" : topical ? "character" : catalog.latestDirectories.has(item.path.split("/")[1]) ? "recent" : null
    if (!pool) continue
    pools[pool].push({ item, score: (3 - intent.profiles.indexOf(item.semanticProfile)) * 10 + topicMatches * 3 +
      (item.tone === intent.tone ? 2 : 0) })
  }
  for (const pool of Object.keys(pools)) pools[pool] = pools[pool]
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id)).slice(0, 6).map(x => x.item)
  return { pools, hasCharacter: characters.length > 0 }
}
