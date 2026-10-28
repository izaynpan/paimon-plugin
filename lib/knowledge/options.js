const clamp = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.floor(Number(v)))) : fallback
export function knowledgeOptions(config = {}) {
  const c = config.knowledge || {}
  return { enabled: c.enabled === true, provider: c.provider === 'none' ? 'none' : 'genshin-lore',
    topK: clamp(c.topK, 6, 2, 8), maxContextChars: clamp(c.maxContextChars, 10000, 2000, 16000),
    includeSources: c.includeSources === true, characters: c.characters === true, lore: c.lore !== false }
}
