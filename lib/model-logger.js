import fs from "node:fs/promises"
import path from "node:path"
import { pluginRoot } from "./paths.js"

function safeLogFile(root, configured) {
  const base = path.resolve(root)
  const file = path.resolve(base, configured || "data/logs/deepseek.jsonl")
  const relative = path.relative(base, file)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new TypeError("模型日志路径必须位于 paimon-plugin 目录内")
  return file
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    const result = {}
    for (const [key, item] of Object.entries(value)) {
      if (/^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key))
        result[key] = "[REDACTED]"
      else result[key] = redact(item)
    }
    return result
  }
  if (typeof value === "string") return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
  return value
}

function prepareEntry(event, data, options) {
  const entry = redact({
    timestamp: new Date().toISOString(),
    event,
    ...data,
  })
  if (event === "model_request" && options.includePrompt === false && entry.request?.messages)
    entry.request.messages = entry.request.messages.map(message => ({
      role: message.role,
      content: "[OMITTED]",
    }))
  if (event === "model_response" && options.includeResponse === false && entry.response) {
    delete entry.response.content
    delete entry.response.data
  }
  if (
    (event === "model_error" || event === "model_retry") &&
    options.includeResponse === false &&
    entry.error
  ) {
    delete entry.error.responseContent
    delete entry.error.responseData
  }
  if (options.includeUsage === false && entry.response) delete entry.response.usage
  if (options.includeUsage === false && entry.error) delete entry.error.usage
  if (event === "reply_sent" && options.includeResponse === false) {
    delete entry.reply
    delete entry.segments
  }
  return entry
}

export class ModelLogger {
  constructor({ root = pluginRoot, logger } = {}) {
    this.root = path.resolve(root)
    this.logger = logger
    this.queue = Promise.resolve()
  }

  async write(event, data, config) {
    const options = config?.logging || {}
    if (!options.enabled) return false
    const operation = this.queue
      .catch(() => {})
      .then(() => this.writeNow(event, data, options))
      .catch(error => {
        this.logger?.("error", "写入 DeepSeek 调试日志失败", error)
        return false
      })
    this.queue = operation
    return operation
  }

  async writeNow(event, data, options) {
    const file = safeLogFile(this.root, options.file)
    const line = JSON.stringify(prepareEntry(event, data, options)) + "\n"
    await fs.mkdir(path.dirname(file), { recursive: true })
    await this.rotateIfNeeded(file, Buffer.byteLength(line), options)
    await fs.appendFile(file, line, "utf8")
    return true
  }

  async rotateIfNeeded(file, incomingBytes, options) {
    const maxBytes = Math.max(1024, Number(options.maxBytes) || 5 * 1024 * 1024)
    const maxFiles = Math.max(1, Number(options.maxFiles) || 3)
    const stat = await fs.stat(file).catch(error => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!stat || stat.size + incomingBytes <= maxBytes) return

    if (maxFiles === 1) {
      await fs.rm(file, { force: true })
      return
    }
    await fs.rm(file + "." + (maxFiles - 1), { force: true })
    for (let index = maxFiles - 2; index >= 1; index--) {
      const source = file + "." + index
      const target = file + "." + (index + 1)
      await fs.rm(target, { force: true })
      await fs.rename(source, target).catch(error => {
        if (error?.code !== "ENOENT") throw error
      })
    }
    await fs.rm(file + ".1", { force: true })
    await fs.rename(file, file + ".1")
  }
}

export { prepareEntry, redact, safeLogFile }
