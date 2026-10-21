import fs from 'node:fs/promises'
import path from 'node:path'

// Unlike disposable caches, an unreadable delivery journal must stop delivery.
export class NewsStore {
  constructor(file) {
    this.file = file
    this.loaded = false
    this.records = {}
    this.clocks = {}
  }

  async load() {
    if (this.loaded) return
    try {
      if ((await fs.stat(this.file)).size > 8000000) throw new Error('news_journal_size')
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (data?.version !== 1 || !data.records || !data.clocks ||
          Array.isArray(data.records) || Array.isArray(data.clocks) ||
          typeof data.records !== 'object' || typeof data.clocks !== 'object') throw new Error('news_journal_schema')
      for (const [key, value] of Object.entries(data.records)) {
        if (!/^\d+:(gs|sr|zzz):\d+$/.test(key) || !value ||
            !['sent', 'uncertain', 'failed'].includes(value.status) ||
            !Number.isFinite(value.at) || !Number.isInteger(value.attempts) || value.attempts < 0 ||
            !Number.isFinite(value.retryAt)) throw new Error('news_journal_record')
      }
      for (const [key, value] of Object.entries(data.clocks))
        if (!/^\d+$/.test(key) || !Number.isFinite(value)) throw new Error('news_journal_clock')
      this.records = data.records
      this.clocks = data.clocks
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.loaded = true
  }

  async save(now) {
    const cutoff = now - 48 * 3600000
    for (const [key, value] of Object.entries(this.records)) if (value.at < cutoff) delete this.records[key]
    for (const [key, value] of Object.entries(this.clocks)) if (value < cutoff) delete this.clocks[key]
    const data = JSON.stringify({ version: 1, records: this.records, clocks: this.clocks })
    if (Buffer.byteLength(data) > 8000000) throw new Error('news_journal_size')
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    await fs.writeFile(this.file + '.tmp', data, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(this.file + '.tmp', this.file)
  }
}
