import { KnowledgeStore } from './knowledge/store.js'
import { knowledgeOptions } from './knowledge/options.js'

export function createKnowledgeProvider({ store = new KnowledgeStore() } = {}) {
  const requests = new WeakMap()
  return async function getKnowledgeContext(args = {}) {
    const options = knowledgeOptions(args.config)
    const empty = { text: '', citations: [], status: 'miss', freshness: 'unknown', revision: 'none', topicType: 'lore' }
    if (!options.enabled || options.provider === 'none') return { ...empty, retrievalReason: 'disabled' }
    if (args.signal?.aborted) return { ...empty, status: 'error', retrievalReason: 'cancelled' }
    try {
      const token = args.knowledgeRequest
      let pending = token && requests.get(token)
      if (!pending) {
        pending = store.load()
        if (token) requests.set(token, pending)
      }
      const { index, issue } = await pending
      if (args.signal?.aborted) return { ...empty, status: 'error', retrievalReason: 'cancelled' }
      const result = index.search(args, options)
      const text = result.matches.map(m => m.block).join('\n\n')
      return { ...empty, text, revision: index.snapshot.revision, status: text ? 'partial' : 'miss',
        // Similarity cannot establish full coverage or current canon. No invented verification date.
        freshness: 'unknown', truncated: result.truncated,
        retrievalReason: issue || (result.plan.ambiguous ? 'ambiguous_reference' : result.plan.outsideScope ? 'outside_lore_scope' : text ? 'matched' : 'no_match'),
        citations: result.matches.map(m => ({ id: m.id, title: '《日月全事》·' + m.title,
          file: m.file, headingPath: m.headingPath, lineStart: m.lineStart, lineEnd: m.lineEnd,
          edition: m.edition, contentKind: m.contentKind, uncertain: m.uncertain,
          coverage: m.headingPath.join(' / '), verifiedThroughVersion: m.verifiedThroughVersion,
        })),
        dependencies: result.plan.entities.map(g => g[0]),
        verifiedThroughVersion: index.snapshot.manifest.verifiedThroughVersion || '',
      }
    } catch { return { ...empty, status: 'error', retrievalReason: 'index_unavailable' } }
  }
}
export const getKnowledgeContext = createKnowledgeProvider()

const clip = (value, limit) => String(value || "").slice(0, limit)

// Providers must assess coverage for this question, not just document similarity.
// Legacy providers remain usable, but without metadata cannot assert freshness.
export function normalizeKnowledge(value, now = Date.now()) {
  const source = value && typeof value === "object" ? value : {}
  const text = clip(source.text, 18000)
  const truncated = source.truncated === true || String(source.text || "").length > text.length
  let status = ["complete", "partial", "miss", "error"].includes(source.status)
    ? source.status : text ? "partial" : "miss"
  if (status === "complete" && truncated) status = "partial"
  let freshness = ["applicable", "outdated", "unknown"].includes(source.freshness)
    ? source.freshness : "unknown"
  const validUntil = Date.parse(source.validUntil)
  const validFrom = Date.parse(source.validFrom)
  if (source.validUntil && !Number.isFinite(validUntil) || source.validFrom && !Number.isFinite(validFrom))
    freshness = "unknown"
  if ((Number.isFinite(validUntil) && validUntil <= now) ||
      (Number.isFinite(validFrom) && validFrom > now)) freshness = "outdated"
  return { text, status: status === "complete" && !text ? "miss" : status, freshness, truncated,
    retrievalReason: clip(source.retrievalReason, 80),
    revision: clip(source.revision, 120), currentVersion: clip(source.currentVersion, 120),
    verifiedAt: clip(source.verifiedAt, 80), validFrom: clip(source.validFrom, 80), validUntil: clip(source.validUntil, 80),
    topicType: clip(source.topicType, 80), verifiedThroughVersion: clip(source.verifiedThroughVersion, 80),
    dependencies: (Array.isArray(source.dependencies) ? source.dependencies : []).slice(0, 20).map(item => clip(item, 120)),
    citations: (Array.isArray(source.citations) ? source.citations : []).slice(0, 12).map(item => ({
      id: clip(item?.id, 80), title: clip(item?.title, 200), url: clip(item?.url, 2048),
      publishedAt: clip(item?.publishedAt, 80), verifiedThroughVersion: clip(item?.verifiedThroughVersion, 80),
      coverage: clip(item?.coverage, 400),
      file: clip(item?.file, 160), edition: clip(item?.edition, 160),
      headingPath: (Array.isArray(item?.headingPath) ? item.headingPath : []).slice(0, 8).map(s => clip(s, 200)),
      lineStart: Number.isSafeInteger(item?.lineStart) && item.lineStart > 0 ? item.lineStart : null,
      lineEnd: Number.isSafeInteger(item?.lineEnd) && item.lineEnd > 0 ? item.lineEnd : null,
      contentKind: ['compilation', 'compiler_commentary'].includes(item?.contentKind) ? item.contentKind : 'unknown',
      uncertain: item?.uncertain === true,
    })),
  }
}

export async function readKnowledge(provider, args, { timeoutMs = 1500, signal } = {}) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  let timer, stop
  try {
    if (signal?.aborted) return normalizeKnowledge({ status: "error" })
    const cancelled = new Promise(resolve => {
      stop = () => resolve({ status: "error" })
      controller.signal.addEventListener("abort", stop, { once: true })
      timer = setTimeout(abort, timeoutMs)
    })
    return normalizeKnowledge(await Promise.race([
      Promise.resolve().then(() => provider({ ...args, signal: controller.signal }))
        .catch(() => ({ status: "error" })), cancelled,
    ]))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", stop)
    controller.abort()
  }
}

export default { getKnowledgeContext }
