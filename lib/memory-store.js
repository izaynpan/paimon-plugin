import fs from "node:fs/promises"
import path from "node:path"
import { pluginRoot } from "./config.js"

function safeUserId(userId) {
  const value = String(userId || "")
  if (!/^\d{1,32}$/.test(value)) throw new TypeError("非法 QQ 用户 ID")
  return value
}

function nowIso() {
  return new Date().toISOString()
}

function emptyStats() {
  return {
    sessionCount: 0,
    replyBatchCount: 0,
    memoryEvaluationCount: 0,
    memoryUpdateCount: 0,
    lastGroupId: "",
    lastSeenAt: "",
    lastMemoryEvaluatedAt: "",
    lastMemoryUpdatedAt: "",
  }
}

export function createMemoryRecord(userId) {
  const timestamp = nowIso()
  return {
    version: 1,
    userId: safeUserId(userId),
    createdAt: timestamp,
    updatedAt: timestamp,
    memory: "",
    stats: emptyStats(),
  }
}

function normalizeRecord(value, userId) {
  const base = createMemoryRecord(userId)
  if (!value || typeof value !== "object") return base
  return {
    ...base,
    ...value,
    version: 1,
    userId: base.userId,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : base.createdAt,
    memory: typeof value.memory === "string" ? value.memory : "",
    stats: { ...base.stats, ...(value.stats || {}) },
  }
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "unknown error"),
    code: error?.code || "",
    status: Number(error?.status) || 0,
  }
}

export class MemoryStore {
  constructor({ root = path.join(pluginRoot, "data"), logger } = {}) {
    this.root = path.resolve(root)
    this.usersDir = path.join(this.root, "memory", "users")
    this.failedDir = path.join(this.root, "runtime", "failed-memory-evaluations")
    this.queues = new Map()
    this.logger = logger
  }

  userFile(userId) {
    return path.join(this.usersDir, safeUserId(userId) + ".json")
  }

  async read(userId) {
    const id = safeUserId(userId)
    try {
      const value = JSON.parse(await fs.readFile(this.userFile(id), "utf8"))
      return normalizeRecord(value, id)
    } catch (error) {
      if (error?.code === "ENOENT") return createMemoryRecord(id)
      if (error instanceof SyntaxError) {
        this.logger?.("error", "用户记忆 JSON 损坏，已暂时使用空记忆", { userId: id })
        return createMemoryRecord(id)
      }
      throw error
    }
  }

  async readMany(participants, limit = Infinity) {
    const selected = Object.values(participants || {}).slice(0, Math.max(0, limit))
    const records = await Promise.all(
      selected.map(async participant => {
        const record = await this.read(participant.userId)
        return [record.userId, { ...record, displayName: participant.displayName }]
      }),
    )
    return Object.fromEntries(records)
  }

  async withUserLock(userId, operation) {
    const id = safeUserId(userId)
    const previous = this.queues.get(id) || Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    this.queues.set(id, run)
    try {
      return await run
    } finally {
      if (this.queues.get(id) === run) this.queues.delete(id)
    }
  }

  async atomicWrite(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp =
      file + "." + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".tmp"
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8")
    try {
      await fs.rename(temp, file)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  async update(userId, updater) {
    const id = safeUserId(userId)
    return this.withUserLock(id, async () => {
      const current = await this.read(id)
      const updated = normalizeRecord((await updater(structuredClone(current))) || current, id)
      updated.updatedAt = nowIso()
      await this.atomicWrite(this.userFile(id), updated)
      return updated
    })
  }

  async applySessionEvaluation({
    session,
    updates = [],
    evaluationAttempted = true,
    maxMemoryChars = 8000,
  }) {
    const updateMap = new Map(
      updates
        .filter(item => item && typeof item === "object")
        .map(item => [String(item.userId), item]),
    )
    const timestamp = nowIso()
    const participants = Object.values(session.participants || {})
    return Promise.all(
      participants.map(participant =>
        this.update(participant.userId, record => {
          const stats = record.stats
          stats.sessionCount = Number(stats.sessionCount || 0) + 1
          stats.replyBatchCount =
            Number(stats.replyBatchCount || 0) + (session.sessionBatches?.length || 0)
          stats.lastGroupId = session.groupId ? String(session.groupId) : ""
          stats.lastSeenAt = timestamp
          if (evaluationAttempted) {
            stats.memoryEvaluationCount = Number(stats.memoryEvaluationCount || 0) + 1
            stats.lastMemoryEvaluatedAt = timestamp
          }

          const update = updateMap.get(String(participant.userId))
          if (
            update?.shouldUpdateMemory === true &&
            typeof update.newMemory === "string" &&
            update.newMemory.trim()
          ) {
            record.memory = update.newMemory.trim().slice(0, Math.max(1, maxMemoryChars))
            stats.memoryUpdateCount = Number(stats.memoryUpdateCount || 0) + 1
            stats.lastMemoryUpdatedAt = timestamp
          }
          return record
        }),
      ),
    )
  }

  async saveFailedEvaluation(session, error, extra = {}, maxFiles = 20) {
    await fs.mkdir(this.failedDir, { recursive: true })
    const safeId = String(session.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_")
    const file = path.join(this.failedDir, safeId + ".json")
    await this.atomicWrite(file, {
      version: 1,
      failedAt: nowIso(),
      error: serializeError(error),
      session,
      ...extra,
    })
    await this.pruneFailedEvaluations(maxFiles)
    return file
  }

  async pruneFailedEvaluations(maxFiles) {
    const limit = Math.max(0, Number(maxFiles) || 0)
    const entries = await fs.readdir(this.failedDir, { withFileTypes: true }).catch(() => [])
    const files = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .map(async entry => {
          const file = path.join(this.failedDir, entry.name)
          const stat = await fs.stat(file)
          return { file, mtimeMs: stat.mtimeMs }
        }),
    )
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    await Promise.all(files.slice(limit).map(item => fs.rm(item.file, { force: true })))
  }
}

export { safeUserId, normalizeRecord }
