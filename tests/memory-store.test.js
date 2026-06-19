import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MemoryStore } from "../lib/memory-store.js"

async function makeStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-memory-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return { store: new MemoryStore({ root }), root }
}

test("同一用户并发更新通过 Promise 队列串行化", async t => {
  const { store, root } = await makeStore(t)
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.update("123456", async record => {
        await new Promise(resolve => setTimeout(resolve, index % 3))
        record.stats.sessionCount++
        return record
      }),
    ),
  )
  const record = await store.read("123456")
  assert.equal(record.stats.sessionCount, 12)
  const files = await fs.readdir(path.join(root, "memory", "users"))
  assert.deepEqual(files, ["123456.json"])
})

test("session 评估只更新参与用户并合并统计", async t => {
  const { store } = await makeStore(t)
  const session = {
    groupId: "88",
    participants: {
      123456: { userId: "123456", displayName: "甲" },
      654321: { userId: "654321", displayName: "乙" },
    },
    sessionBatches: [{}, {}],
  }
  await store.applySessionEvaluation({
    session,
    updates: [
      { userId: "123456", shouldUpdateMemory: true, newMemory: "喜欢简短回答" },
      { userId: "999999", shouldUpdateMemory: true, newMemory: "不应写入" },
    ],
  })
  const first = await store.read("123456")
  const second = await store.read("654321")
  assert.equal(first.memory, "喜欢简短回答")
  assert.equal(first.stats.memoryUpdateCount, 1)
  assert.equal(first.stats.sessionCount, 1)
  assert.equal(first.stats.replyBatchCount, 2)
  assert.equal(first.stats.lastGroupId, "88")
  assert.equal(second.memory, "")
  assert.equal(second.stats.sessionCount, 1)
  await assert.rejects(store.read("../escape"), /非法 QQ 用户 ID/)
})

test("失败评估材料单独保存且按上限清理", async t => {
  const { store } = await makeStore(t)
  for (let index = 0; index < 3; index++) {
    await store.saveFailedEvaluation(
      { id: "session-" + index, participants: {}, sessionBatches: [] },
      new Error("boom"),
      {},
      2,
    )
    await new Promise(resolve => setTimeout(resolve, 4))
  }
  const files = await fs.readdir(store.failedDir)
  assert.equal(files.length, 2)
  assert.ok(files.every(file => file.endsWith(".json")))
})
