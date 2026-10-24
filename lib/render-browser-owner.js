import fs from 'node:fs/promises'
import path from 'node:path'

// A cached WebSocket alone is insufficient proof of ownership. Match its listening
// socket to a Chromium process with this Yunzai workspace's Puppeteer profile.
export async function ownsLocalBrowser(browser, base) {
  if (process.platform !== 'linux') return false
  let endpoint
  try { endpoint = new URL(browser.wsEndpoint()) } catch { return false }
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) return false
  const port = Number(endpoint.port)
  const inodes = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    const lines = (await fs.readFile(table, 'utf8')).trim().split('\n').slice(1)
    for (const line of lines) {
      const cells = line.trim().split(/\s+/)
      if (cells[3] === '0A' && Number.parseInt(cells[1].split(':')[1], 16) === port) inodes.add(cells[9])
    }
  }
  if (!inodes.size) return false
  for (const pid of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      if ((await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim() !== 'chromium') continue
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
      const profile = args.find(arg => arg.startsWith('--user-data-dir='))?.slice(16)
      if (!profile || !path.resolve(profile).startsWith(path.join(base, 'temp/puppeteer') + path.sep)) continue
      for (const fd of await fs.readdir(`/proc/${pid}/fd`)) {
        const target = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')
        if (target.startsWith('socket:[') && inodes.has(target.slice(8, -1))) return true
      }
    } catch {}
  }
  return false
}
