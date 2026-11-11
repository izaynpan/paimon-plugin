import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

export const starterIds = ['v2-01', 'v2-03', 'v2-05', 'v2-07', 'v2-09', 'v2-11', 'v2-13', 'v2-15', 'v2-17', 'v2-19', 'v2-21', 'v2-24']
export function reviewPayload(manifest, review) {
  // Explicit allowlist: never embed model names, mode mapping, selection IDs, or requests.
  if (!manifest.runId) throw new Error('盲评缺少独立运行标识')
  return { version: 2, runId: manifest.runId, fingerprint: manifest.fingerprint, starterIds,
    rows: review.map(r => ({ id: r.id, repeat: r.repeat, turn: r.turn, prompt: r.prompt,
      variants: r.variants.map(v => ({ label: v.label, reply: v.reply, error: v.error, shouldReply: v.shouldReply,
        history: v.history.map(h => ({ reply: h.reply, skipped: h.skipped,
          messages: h.messages.map(m => ({ text: m.text })) })) })) })) }
}
export async function writeReviewPage({ dir, manifest, review }) {
  // Also upgrades an already generated batch: random labels differ across runs.
  if (!manifest.runId) {
    manifest.runId = randomUUID()
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  const template = await fs.readFile(fileURLToPath(new URL('../knowledge/paimon-style/review-template.html', import.meta.url)), 'utf8')
  const payload = JSON.stringify(reviewPayload(manifest, review)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  await fs.writeFile(path.join(dir, 'review.html'), template.replace('/*REVIEW_DATA*/', () => payload))
}
