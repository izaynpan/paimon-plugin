// Repair the known Miyoushe HTML placeholders only; retain the surrounding rich text.
// This is not a general HTML sanitizer or a structured-content-to-HTML converter.
const escape = value => String(value).replace(/[&"<>']/g, c =>
  ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' })[c])
const decode = value => value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
  const name = entity.slice(1, -1).toLowerCase()
  if (name[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' })[name]
  const n = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : entity
})
function attribute(tag, name) {
  const attrs = /([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
  for (const m of tag.matchAll(attrs)) if (m[1].toLowerCase() === name)
    return decode(m[2] ?? m[3] ?? m[4])
  return ''
}
function officialUrl(value, card = false) {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value)
    const domains = card ? ['miyoushe.com', 'mihoyo.com', 'mihoyogift.com'] : ['miyoushe.com', 'mihoyo.com']
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !domains.some(d => url.hostname === d || url.hostname.endsWith('.' + d))) return null
    return url
  } catch { return null }
}
function key(value, card = false) {
  const url = officialUrl(value, card)
  if (!url) return null
  url.hash = ''
  if (!card) url.searchParams.delete('x-oss-process')
  return url.href
}
function image(value) {
  const url = officialUrl(value)
  if (!url) return null
  // Preserve aspect ratio: a tall poster remains tall and is split by the renderer.
  if (url.hostname === 'upload-bbs.miyoushe.com')
    url.searchParams.set('x-oss-process', 'image/resize,w_600/quality,q_80/auto-orient,0/interlace,1/format,jpg')
  return `<img src="${escape(url.href)}" loading="eager" style="display:block;max-width:100%;height:auto;opacity:1" />`
}

// Locate balanced div spans, ignoring comments and raw script/style text. Quoted
// '>' characters are part of the tag, not the end of a card or image container.
function blocks(body, className) {
  const tokens = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<\/?[a-z][a-z\d-]*\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/gi
  const stack = [], result = []
  for (const m of body.matchAll(tokens)) {
    const tag = m[0]
    if (/^<div\b/i.test(tag)) stack.push({ start: m.index, tag,
      match: attribute(tag, 'class').split(/\s+/).includes(className) })
    else if (/^<\/div\s*>/i.test(tag)) {
      const open = stack.pop()
      if (open?.match) result.push({ start: open.start, end: m.index + tag.length,
        html: body.slice(open.start, m.index + tag.length) })
    }
  }
  return result.sort((a, b) => a.start - b.start)
}

export function restoreNewsImages(body, post = {}) {
  if (typeof body !== 'string') return body
  let operations
  try { operations = typeof post.structured_content === 'string' ? JSON.parse(post.structured_content) : post.structured_content }
  catch {}
  if (!Array.isArray(operations)) operations = []
  const entries = operations.filter(op => op?.insert && Object.hasOwn(op.insert, 'image'))
  const urls = entries.length ? entries.map(op => op.insert.image) : (Array.isArray(post.images) ? post.images : [])
  const slots = blocks(body, 'ql-image')
  const aligned = slots.length === urls.length && slots.every((slot, i) => {
    const tag = slot.html.match(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/i)?.[0]
    const src = tag && attribute(tag, 'src')
    return !src || (key(src) && key(src) === key(urls[i]))
  })
  const edits = []
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const tags = [...slot.html.matchAll(/<img\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/gi)]
    if (tags.length !== 1) continue
    const tag = tags[0][0], src = attribute(tag, 'src'), style = attribute(tag, 'style')
    const hidden = /(?:^|;)\s*(?:opacity\s*:\s*0(?:\.0*)?(?:\s*!important)?\s*(?:;|$)|display\s*:\s*none\b|visibility\s*:\s*hidden\b)/i.test(style)
    if (src && !hidden) continue
    const direct = src || attribute(tag, 'data-src')
    const replacement = image(direct || (aligned ? urls[i] : null))
    if (!replacement) throw new Error('news_image_mapping_incomplete')
    edits.push({ ...slot, value: `<div class="ql-image"><div class="ql-image-box">${replacement}</div></div>` })
  }
  const cards = operations.map(op => op?.insert?.link_card).filter(Boolean)
  for (const slot of blocks(body, 'ql-link-card')) {
    if (!/card-offline|goods_disable\.png/i.test(slot.html)) continue
    const anchor = slot.html.match(/<a\b(?:"[^"]*"|'[^']*'|[^'">])*\/?\s*>/i)?.[0]
    const href = anchor && key(attribute(anchor, 'href'), true)
    if (!href) continue
    const card = cards.find(c => [c.origin_url, c.landing_url].some(url => key(url, true) === href))
    const cover = card && image(card.cover)
    if (!cover || typeof card.title !== 'string' || !card.title.trim()) continue
    edits.push({ ...slot, value: `<div class="paimon-news-card" style="margin:16px 0;padding:12px;border:1px solid #ddd">${cover}<p>${escape(card.title)}</p></div>` })
  }
  let end = body.length, output = ''
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    if (edit.end > end) throw new Error('news_image_markup_overlap')
    output = edit.value + body.slice(edit.end, end) + output
    end = edit.start
  }
  return body.slice(0, end) + output
}
