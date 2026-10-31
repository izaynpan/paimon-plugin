export const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
export const label = value => typeof value === 'string' ? value.slice(0, 80) : ''
export const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
export function silentProfileEvent(e) {
  const silent = { ...e, reply: async () => false }
  for (const key of ['group', 'friend']) if (e[key]) silent[key] = new Proxy(e[key], {
    get: (obj, field) => /^send/.test(String(field)) ? async () => false
      : typeof obj[field] === 'function' ? obj[field].bind(obj) : obj[field],
  })
  return silent
}
export function imageReplyEvent(e, onReply) {
  const isImage = value => Array.isArray(value) ? value.some(isImage) : value?.type === 'image' ||
    typeof value === 'string' && /^(?:base64:\/\/|\[CQ:image,)/.test(value)
  return { ...e, reply: async (...values) => {
    const result = await e.reply(...values)
    if (isImage(values[0]) && result !== false && result !== null && !result?.error) onReply?.(result)
    return result
  } }
}
