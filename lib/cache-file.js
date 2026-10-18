import fs from "node:fs/promises"
import path from "node:path"

// One writer per file. A failed replacement leaves the previous snapshot intact.
export class CacheFile {
  constructor(file, { maxBytes = 16000000, logger = () => {} } = {}) {
    this.file = file
    this.maxBytes = maxBytes
    this.logger = logger
    this.tail = Promise.resolve()
  }

  async read() {
    if (!this.file) return null
    try {
      if ((await fs.stat(this.file)).size > this.maxBytes) throw new Error("size")
      const value = JSON.parse(await fs.readFile(this.file, "utf8"))
      if (value?.version !== 1 || !Array.isArray(value.entries)) throw new Error("schema")
      return value.entries
    } catch (error) {
      if (error.code !== "ENOENT") this.logger("warn", "限期缓存读取失败，忽略损坏快照")
      return null
    }
  }

  save(entries, persist) {
    if (!this.file) return Promise.resolve(true)
    const data = persist && entries.length ? JSON.stringify({ version: 1, entries }) : null
    const operation = this.tail.then(async () => {
      if (!data) {
        await fs.rm(this.file, { force: true })
        await fs.rm(this.file + ".tmp", { force: true })
        return
      }
      if (Buffer.byteLength(data) > this.maxBytes) throw new Error("size")
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const temp = this.file + ".tmp"
      await fs.writeFile(temp, data, { encoding: "utf8", mode: 0o600 })
      await fs.rename(temp, this.file)
    })
    this.tail = operation.then(() => true).catch(() => {
      this.logger("warn", "限期缓存保存失败，本次数据可能无法跨重启恢复")
      return false
    })
    return this.tail
  }
}
