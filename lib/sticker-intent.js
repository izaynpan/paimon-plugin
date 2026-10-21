// These identifiers correspond to docs/stickers/profiles.txt; no chat history is stored here.
export const stickerProfiles = new Set(("agree angry annoyed awkward bored calm celebrate cheer cold comfort confident confused cook cry dizzy drink eat explain fight focus gift greet happy hide hungry idea laugh leave listen love money panic perform playful plead proud reading refuse relax reward sad scared secret shy sick silenced sing sleep surprised think tired watch wink work").split(" "))
export const intensityLevels = { 低: 1, 中: 2, 高: 3 }

export function stickerOptions(config) {
  const o = config.stickers || {}
  const probability = Number(o.probability ?? 0.12)
  return {
    enabled: o.enabled === true,
    mode: o.mode ?? "contextual",
    probability: Number.isFinite(probability) ? Math.min(1, Math.max(0, probability)) : 0,
    selectionTimeoutMs: Math.min(15000, Math.max(1000, Number(o.selectionTimeoutMs) || 8000)),
  }
}

export function contextualStickers(config) {
  const o = stickerOptions(config)
  return o.enabled && o.mode === "contextual"
}

export const stickerIntentExample = { allowed: false, profiles: [], intensity: "低", tone: "自然", topics: [], characters: [] }

export function stickerIntentRules() {
  return [
    "【可选表情意图】最终回复另给 stickerIntent；它描述派蒙本轮实际回复的表达，不是复制用户情绪。沉默、严肃求助、不适合图片或不确定时 allowed=false。neutral 也可有问候、感谢、晚安等合适用途。不要为了表情改变文字回复。",
    'allowed=true 时格式为 {"allowed":true,"profiles":["happy"],"intensity":"中","tone":"自然","topics":["开心"],"characters":[]}。profiles 为最多3个贴切的表达类型：' + [...stickerProfiles].join(" | ") + "；intensity 为低/中/高，表示能接受的最高表达强度；tone 描述本轮语气；topics 为最多5个简短中文主题。吃喝、摩拉、奖励、战斗、阅读、睡眠等有具体动作的图必须有对应语境，不因开心就泛用。",
    'characters 最多3个当前重点角色，元素为 {"name":"角色名或无歧义别名","source":"current","evidence":"原文短句","reference":""}。source 仅为 current（本批用户消息）、reply（本轮回复）或 recent（紧接的上一轮）。evidence 必须逐字引用含角色名的对应文本；recent 还必须用 reference 逐字引用本批明确承接该角色的指代短句。多人歧义或换题不沿用旧角色，不把群友昵称当角色；仅历史出现过不够。派蒙无需放入 characters。',
    "具体动作的 topics 使用对应短词：cold=寒冷，cook=料理，drink=饮品，eat/hungry=食物，fight=战斗，gift=礼物，money=摩拉，perform=表演，reading=阅读，reward=奖励，secret=悄悄话，sing=音乐，sleep=睡眠，work=工作。这些主题必须实际存在，不为召回图片补造。",
  ].join("\n")
}

const shortStrings = (value, limit, length) => Array.isArray(value) && value.length <= limit &&
  value.every(x => typeof x === "string" && x.trim() && x.length <= length)

export function normalizeStickerIntent(value) {
  if (!value || typeof value !== "object" || value.allowed !== true ||
      !shortStrings(value.profiles, 3, 24) || !value.profiles.length ||
      !value.profiles.every(x => stickerProfiles.has(x)) || !Object.hasOwn(intensityLevels, value.intensity) ||
      typeof value.tone !== "string" || !value.tone.trim() || value.tone.length > 30 ||
      !shortStrings(value.topics, 5, 30) || !Array.isArray(value.characters) || value.characters.length > 3) return null
  for (const c of value.characters) {
    if (!c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 40 ||
        !["current", "reply", "recent"].includes(c.source) || typeof c.evidence !== "string" ||
        !c.evidence.trim() || c.evidence.length > 160 ||
        c.source === "recent" && (typeof c.reference !== "string" || !c.reference.trim() || c.reference.length > 80)) return null
  }
  return { allowed: true, profiles: [...new Set(value.profiles)], intensity: value.intensity,
    tone: value.tone.trim(), topics: [...new Set(value.topics.map(x => x.trim()))],
    characters: value.characters.map(c => ({ name: c.name.trim(), source: c.source,
      evidence: c.evidence, reference: c.source === "recent" ? c.reference : "" })) }
}
