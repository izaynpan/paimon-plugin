import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { pluginRoot } from '../paths.js'
import { parseMarkdown, hash, PARSER_VERSION } from './markdown.js'
import { KnowledgeIndex } from './unified-index.js'
import { buildCharacters, CHARACTER_VERSION } from './characters.js'

const revisionPattern = /^[a-f0-9]{32}$/
const snapshotRevision = s => hash(JSON.stringify({ parser: s.parserVersion, manifest: s.manifest,
  aliases: s.aliases, sources: s.sources, chunks: s.chunks,
  ...(s.characters ? { characters: s.characters } : {}) })).slice(0, 32)
function prepareIndex(snapshot) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./index-worker.js', import.meta.url), { workerData: snapshot,
      execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) })
    worker.unref()
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('knowledge index load timeout')) }, 10000)
    worker.once('message', data => {
      clearTimeout(timer)
      resolve(Object.assign(Object.create(KnowledgeIndex.prototype), data))
    })
    worker.once('error', error => { clearTimeout(timer); reject(error) })
    worker.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(new Error('knowledge worker exited')) } })
  })
}
async function atomic(file, content) {
  const temp = file + '.' + randomUUID() + '.tmp'
  await fs.mkdir(path.dirname(file), { recursive: true })
  try { await fs.writeFile(temp, content, { flag: 'wx' }); await fs.rename(temp, file) }
  finally { await fs.rm(temp, { force: true }) }
}
export async function buildSnapshot({ root = pluginRoot, sourceRoot = path.join(root, 'knowledge/genshinlore-md'), characters = false } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'knowledge/sources.json'), 'utf8'))
  const aliases = JSON.parse(await fs.readFile(path.join(root, 'knowledge/aliases.json'), 'utf8'))
  if (manifest.schemaVersion !== 1 || aliases.schemaVersion !== 1 || !Array.isArray(aliases.groups) ||
      !aliases.groups.every(g => Array.isArray(g) && g.length && g.every(a => typeof a === 'string' && a.length <= 80))) throw new Error('invalid knowledge metadata')
  if (!Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100) throw new Error('invalid source list')
  const chunks = [], sources = [], warnings = [], files = new Set()
  for (const source of manifest.files) {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(source.file) || files.has(source.file)) throw new Error('invalid or duplicate source filename')
    files.add(source.file)
    const raw = await fs.readFile(path.join(sourceRoot, source.file))
    if (!raw.length || raw.length > 10_000_000) throw new Error('invalid source size: ' + source.file)
    const parsed = parseMarkdown(raw.toString('utf8'), { ...manifest, ...source })
    if (!parsed.chunks.length) throw new Error('empty parsed source: ' + source.file)
    warnings.push(...parsed.warnings.map(w => source.file + ':' + w))
    chunks.push(...parsed.chunks)
    sources.push({ file: source.file, title: source.title, sha256: hash(raw), bytes: raw.length, chunks: parsed.chunks.length })
  }
  if (warnings.length) throw new Error('source validation failed: ' + warnings.slice(0, 10).join('; '))
  const characterData = characters ? await buildCharacters(root) : null
  const extension = characterData ? { characters: characterData } : {}
  const revision = snapshotRevision({ parserVersion: PARSER_VERSION, manifest, aliases, sources, chunks, ...extension })
  return { schemaVersion: 1, parserVersion: PARSER_VERSION, revision, createdAt: new Date().toISOString(),
    manifest, aliases, sources, chunks, warnings, ...extension }
}

export class KnowledgeStore {
  constructor({ root = pluginRoot, directory = path.join(root, 'data/knowledge') } = {}) {
    this.root = root; this.directory = directory; this.current = null; this.loading = null
  }
  async locked(action) {
    await fs.mkdir(this.directory, { recursive: true })
    const lock = path.join(this.directory, 'update.lock')
    const handle = await fs.open(lock, 'wx').catch(error => { throw new Error('knowledge update locked: ' + error.code) })
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await action() }
    finally { await handle.close(); await fs.rm(lock, { force: true }) }
  }
  async readPointer() {
    const p = JSON.parse(await fs.readFile(path.join(this.directory, 'active.json'), 'utf8'))
    if (!revisionPattern.test(p.revision) || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error('invalid knowledge pointer')
    return p
  }
  async readVersion(revision, expectedHash) {
    if (!revisionPattern.test(revision)) throw new Error('invalid knowledge revision')
    const raw = await fs.readFile(path.join(this.directory, 'versions', revision + '.json'))
    if (raw.length > 80_000_000 || expectedHash && hash(raw) !== expectedHash) throw new Error('knowledge integrity check failed')
    const snapshot = JSON.parse(raw.toString('utf8'))
    if (snapshot.schemaVersion !== 1 || snapshot.parserVersion !== PARSER_VERSION || snapshot.revision !== revision ||
        !Array.isArray(snapshot.chunks) || !snapshot.chunks.length || !snapshot.aliases?.groups ||
        snapshot.characters && (snapshot.characters.version !== CHARACTER_VERSION || !Array.isArray(snapshot.characters.chunks) || snapshot.characters.chunks.length > 100000) ||
        snapshotRevision(snapshot) !== revision) throw new Error('invalid knowledge snapshot')
    return { snapshot, sha256: hash(raw) }
  }
  async build({ sourceRoot, activate = true, characters } = {}) {
    return this.locked(async () => {
      if (characters === undefined) {
        try {
          const pointer = await this.readPointer()
          characters = Boolean((await this.readVersion(pointer.revision, pointer.sha256)).snapshot.characters)
        } catch (error) { if (error.code !== 'ENOENT') throw error; characters = false }
      }
      const snapshot = await buildSnapshot({ root: this.root, sourceRoot, characters })
      const file = path.join(this.directory, 'versions', snapshot.revision + '.json')
      let stored
      try { stored = await this.readVersion(snapshot.revision) }
      catch (e) { if (e.code !== 'ENOENT') throw e }
      if (!stored) {
        await atomic(file, JSON.stringify(snapshot))
        stored = await this.readVersion(snapshot.revision)
      }
      // Validate that the complete snapshot can be loaded before publishing its pointer.
      await prepareIndex(stored.snapshot)
      if (activate) await this.activateUnlocked(stored)
      return stored.snapshot
    })
  }
  async activateUnlocked({ snapshot, sha256 }) {
    let previous
    try { previous = await this.readPointer() } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (previous?.revision === snapshot.revision && previous.sha256 === sha256) return previous
    const pointer = { revision: snapshot.revision, sha256, previous: previous ? { revision: previous.revision, sha256: previous.sha256 } : null }
    await atomic(path.join(this.directory, 'active.json'), JSON.stringify(pointer, null, 2) + '\n')
    return pointer
  }
  async rollback(revision) {
    return this.locked(async () => {
      const pointer = await this.readPointer()
      const target = revision || pointer.previous?.revision
      if (!target) throw new Error('no previous knowledge version')
      const version = await this.readVersion(target, target === pointer.previous?.revision ? pointer.previous.sha256 : undefined)
      await prepareIndex(version.snapshot)
      return this.activateUnlocked(version)
    })
  }
  async load({ staleWhileRevalidate = false } = {}) {
    const previous = () => ({ index: this.current.index, issue: 'refreshing_snapshot' })
    if (this.loading) return staleWhileRevalidate && this.current ? previous() : this.loading
    this.loading = (async () => {
      let p
      try {
        p = await this.readPointer()
        if (this.current?.snapshot.revision === p.revision && this.current.sha256 === p.sha256) return { index: this.current.index, issue: '' }
        const version = await this.readVersion(p.revision, p.sha256)
        const index = await prepareIndex(version.snapshot)
        this.current = { ...version, index }
        return { index, issue: '' }
      } catch (error) {
        // A broken update never replaces a working in-memory snapshot.
        if (this.current) return { index: this.current.index, issue: 'using_previous_snapshot' }
        if (p?.previous) {
          const version = await this.readVersion(p.previous.revision, p.previous.sha256)
          const index = await prepareIndex(version.snapshot)
          this.current = { ...version, index }
          return { index, issue: 'using_previous_snapshot' }
        }
        throw error
      }
    })().finally(() => { this.loading = null })
    if (staleWhileRevalidate && this.current) {
      // Keep answering on a complete old snapshot while the new worker prepares all collections.
      void this.loading.catch(() => {})
      return previous()
    }
    return this.loading
  }
}
