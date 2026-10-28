import { KnowledgeStore } from './knowledge/store.js'
import { knowledgeOptions } from './knowledge/options.js'

export function createKnowledgeProvider({ store = new KnowledgeStore() } = {}) {
  const requests = new WeakMap()
  const provider = async function getKnowledgeContext(args = {}) {
    const options = knowledgeOptions(args.config)
    const empty = { text: '', citations: [], status: 'miss', freshness: 'unknown', revision: 'none', topicType: 'lore' }
    if (!options.enabled || options.provider === 'none') return { ...empty, retrievalReason: 'disabled' }
    if (args.signal?.aborted) return { ...empty, status: 'error', retrievalReason: 'cancelled' }
    try {
      const token = args.knowledgeRequest
      let pending = token && requests.get(token)
      if (!pending) {
        pending = store.load({ staleWhileRevalidate: options.characters })
        if (token) requests.set(token, pending)
      }
      const { index, issue } = await pending
      if (args.signal?.aborted) return { ...empty, status: 'error', retrievalReason: 'cancelled' }
      if (options.characters && !index.snapshot.characters) return { ...empty, status: 'error', retrievalReason: 'characters_not_built', revision: index.snapshot.revision }
      const result = index.search(args, options)
      const text = result.matches.map(m => m.block).join('\n\n')
      return { ...empty, text, revision: index.snapshot.revision, status: text ? 'partial' : 'miss',
        // Similarity cannot establish full coverage or current canon. No invented verification date.
        freshness: 'unknown', truncated: result.truncated,
        snapshotIssue: issue,
        retrievalReason: result.plan.ambiguous ? 'ambiguous_reference' : result.plan.outsideScope ? 'outside_lore_scope' : text ? 'matched' : 'no_match',
        diagnostics: result.diagnostics,
        citations: result.matches.map(m => ({ id: m.id, title: m.collection === 'characters' ? '角色资料·' + m.title : '《日月全事》·' + m.title,
          collection: m.collection, url: m.url, sourcePath: m.sourcePath, entityId: m.entityId, speaker: m.speaker, sourceRefs: m.sourceRefs,
          file: m.file, headingPath: m.headingPath, lineStart: m.lineStart, lineEnd: m.lineEnd,
          edition: m.edition, contentKind: m.contentKind, uncertain: m.uncertain,
          coverage: m.headingPath.join(' / '), verifiedThroughVersion: m.verifiedThroughVersion,
        })),
        dependencies: result.plan.entities.map(g => g[0]),
        verifiedThroughVersion: index.snapshot.manifest.verifiedThroughVersion || '',
      }
    } catch { return { ...empty, status: 'error', retrievalReason: 'index_unavailable' } }
  }
  provider.prewarm = () => store.load()
  return provider
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
    diagnostics: sanitizeDiagnostics(source.diagnostics),
    retrievalReason: clip(source.retrievalReason, 80),
    snapshotIssue: clip(source.snapshotIssue, 80),
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
      collection: ['characters', 'genshin-lore'].includes(item?.collection) ? item.collection : '',
      sourcePath: clip(item?.sourcePath, 200), entityId: clip(item?.entityId, 100), speaker: clip(item?.speaker, 100),
      sourceRefs: (Array.isArray(item?.sourceRefs) ? item.sourceRefs : []).slice(0, 8).map(r => ({
        file: clip(r.file, 160), section: clip(r.section, 100), heading: clip(r.heading, 200), sourcePath: clip(r.sourcePath, 200), url: clip(r.url, 2048) })),
      contentKind: ['compilation', 'compiler_commentary', 'character_record', 'character_dialogue', 'character_opinion'].includes(item?.contentKind) ? item.contentKind : 'unknown',
      uncertain: item?.uncertain === true,
    })),
  }
}

function sanitizeDiagnostics(value) {
  if (!value || typeof value !== 'object') return {}
  const count = v => Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0
  return { elapsedMs: count(value.elapsedMs),
    truncationReasons: (Array.isArray(value.truncationReasons) ? value.truncationReasons : []).filter(v => ['parent_limit', 'top_k', 'context_budget'].includes(v)).slice(0, 3),
    candidates: { characters: count(value.candidates?.characters), lore: count(value.candidates?.lore) },
    entities: (Array.isArray(value.entities) ? value.entities : []).slice(0, 6).map(e => ({ id: clip(e.id, 100), method: ['exact', 'alias', 'pinyin'].includes(e.method) ? e.method : 'unknown' })),
    ambiguousCandidates: (Array.isArray(value.ambiguousCandidates) ? value.ambiguousCandidates : []).slice(0, 6).map(e => ({ candidates: (e.candidates || []).slice(0, 8).map(v => clip(v, 100)) })),
    collections: Object.fromEntries(['characters', 'genshin-lore'].map(c => [c, { count: count(value.collections?.[c]?.count), chars: count(value.collections?.[c]?.chars) }])) }
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
