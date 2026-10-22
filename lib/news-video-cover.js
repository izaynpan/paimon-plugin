const escapeAttribute = value => value.replace(/[&"<>']/g, c =>
  ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', "'": '&#39;' })[c])

function coverUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !['miyoushe.com', 'mihoyo.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null
    return url
  } catch { return null }
}

function imageKey(url) {
  const key = new URL(url)
  key.searchParams.delete('x-oss-process')
  key.hash = ''
  return key.href
}

// The original news model only renders content/images. Video posts instead keep
// their cover in structured_content[].insert.vod.cover; retain the original body.
export function appendNewsVideoCovers(body, structuredContent) {
  if (typeof body !== 'string') return body
  let operations
  try { operations = typeof structuredContent === 'string' ? JSON.parse(structuredContent) : structuredContent }
  catch { return body }
  if (!Array.isArray(operations)) return body
  const seen = new Set()
  for (const match of body.matchAll(/<img\b[^>]*\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const url = coverUrl((match[1] ?? match[2] ?? match[3]).replace(/&amp;/g, '&'))
    if (url) seen.add(imageKey(url))
  }
  const images = []
  for (const operation of operations) {
    const url = coverUrl(operation?.insert?.vod?.cover)
    if (!url || seen.has(imageKey(url))) continue
    seen.add(imageKey(url))
    images.push(`<div class="ql-image-box"><img src="${escapeAttribute(url.href)}" style="max-width:100%;height:auto" /></div>`)
  }
  return body + images.join('')
}
