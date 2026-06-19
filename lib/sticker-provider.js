import fs from "node:fs/promises"
import path from "node:path"
import { pluginRoot } from "./config.js"

function insideRoot(root, file) {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

export async function maybeSendSticker({
  e,
  emotion,
  config,
  stickers,
  root = pluginRoot,
  random = Math.random,
  imageFactory = file => globalThis.segment?.image?.(file) || { type: "image", file },
  logger,
}) {
  const options = config.stickers || {}
  if (!options.enabled || emotion === "neutral") return false
  const candidates = Array.isArray(stickers?.[emotion]) ? stickers[emotion].filter(Boolean) : []
  if (!candidates.length || random() >= Math.max(0, Math.min(1, Number(options.probability) || 0)))
    return false

  const selected = candidates[Math.floor(random() * candidates.length)]
  const file = path.resolve(root, selected)
  if (!insideRoot(path.resolve(root), file)) {
    logger?.("warn", "忽略插件目录外的表情包路径", { selected })
    return false
  }
  try {
    await fs.access(file)
    const result = await e.reply(imageFactory(file))
    return result !== false && !result?.error
  } catch (error) {
    logger?.("error", "表情包发送失败", error)
    return false
  }
}
