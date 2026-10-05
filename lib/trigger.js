export function extractText(e) {
  if (!Array.isArray(e?.message)) return String(e?.msg || "").trim()
  const parts = []
  for (const item of e.message) {
    if (item?.type === "text" && typeof item.text === "string") parts.push(item.text)
    else if (item?.type === "at" && String(item.qq) !== String(e.self_id))
      parts.push("@" + (item.name || item.text || item.qq))
  }
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

export function isIgnoredCommand(text, prefixes = []) {
  const value = String(text || "").trim()
  return prefixes.some(prefix => prefix && value.startsWith(String(prefix)))
}

export function sessionKeyFor(e) {
  if (e?.isGroup) return "group:" + e.group_id
  if (e?.isPrivate) return "private:user:" + e.user_id
  return ""
}

export function stripTriggerName(text, nicknames = []) {
  let result = String(text || "")
  for (const nickname of nicknames) if (nickname) result = result.replaceAll(String(nickname), "")
  return result.replace(/\s+/g, " ").trim()
}

export function isGroupAllowed(groupId, config) {
  const whitelist = config?.groupWhitelist
  if (!whitelist?.enabled) return true
  if (!Array.isArray(whitelist.groups) || groupId == null) return false
  const id = String(groupId).trim()
  return Boolean(id) && whitelist.groups.some(group => String(group).trim() === id)
}

export function evaluateTrigger({ e, text, config, hasActiveSession = false }) {
  const trigger = config?.trigger || {}
  const normalized = String(text || "").trim()
  if (!normalized) return { accepted: false, reason: "empty", text: "" }
  if (trigger.ignoreBotSelf !== false && String(e?.user_id) === String(e?.self_id))
    return { accepted: false, reason: "bot-self", text: normalized }
  if (isIgnoredCommand(normalized, trigger.ignoreCommandPrefixes))
    return { accepted: false, reason: "command", text: normalized }

  if (e?.isPrivate) {
    const accepted = hasActiveSession
      ? config?.conversation?.collectPrivateFollowupWithoutTrigger !== false
      : trigger.privateTrigger !== false
    return { accepted, reason: accepted ? "private" : "private-disabled", text: normalized }
  }

  if (!e?.isGroup) return { accepted: false, reason: "unsupported-scene", text: normalized }
  if (!isGroupAllowed(e.group_id, config))
    return { accepted: false, reason: "group-not-whitelisted", text: normalized }
  if (hasActiveSession && config?.conversation?.collectAllNonCommandInActiveGroupSession !== false)
    return { accepted: true, reason: "active-group-session", text: normalized }

  const nicknames = Array.isArray(trigger.nicknames) ? trigger.nicknames.filter(Boolean) : []
  const byMention = trigger.groupMentionTrigger !== false && e.atBot === true
  const byNickname =
    trigger.groupNicknameTrigger !== false && nicknames.some(name => normalized.includes(String(name)))
  if (!byMention && !byNickname)
    return { accepted: false, reason: "group-not-triggered", text: normalized }

  const cleaned = trigger.stripTriggerName ? stripTriggerName(normalized, nicknames) : normalized
  return {
    accepted: true,
    reason: byMention ? "group-mention" : "group-nickname",
    text: cleaned || "（用户在呼唤你）",
  }
}

export function messageFromEvent(e, text) {
  const nickname = [e.sender?.card, e.sender?.nickname, e.nickname]
    .find(value => typeof value === "string" && value.trim())
  return {
    userId: String(e.user_id),
    displayName: String(e.sender?.card || e.sender?.nickname || e.nickname || e.user_id),
    nickname: nickname?.trim() || "",
    text: String(text).trim(),
    timestamp: Date.now(),
    event: e,
  }
}
