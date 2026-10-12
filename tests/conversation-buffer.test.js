import test from "node:test"
import assert from "node:assert/strict"
import { ConversationBuffer } from "../lib/conversation-buffer.js"

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const setTimer = (fn, ms) => ({ handle: setTimeout(fn, ms) })
const clearTimer = timer => clearTimeout(timer.handle)

function message(userId, text, event = {}) {
  return {
    userId,
    displayName: "用户" + userId,
    text,
    timestamp: Date.now(),
    event,
  }
}

test("未配置活跃窗口时，回复完成后默认等待 90 秒结束会话", async () => {
  const timers = []
  const buffer = new ConversationBuffer({
    now: () => 1000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: () => {},
    onReplyBatch: async () => ({ reply: "你好" }),
  })
  try {
    buffer.addMessage({ sessionKey: "group:88", scene: "group", message: message("1", "派蒙") })
    assert.equal(timers.at(-1).ms, 3000)
    await buffer.flush("group:88")
    assert.equal(timers.at(-1).ms, 90000)
    assert.equal(buffer.has("group:88"), true)
  } finally {
    buffer.dispose()
  }
})

test("3 秒语义防抖合并消息，活跃窗口结束后只评估一次", async () => {
  const replies = []
  const ended = []
  const buffer = new ConversationBuffer({
    setTimer,
    clearTimer,
    onReplyBatch: async input => {
      replies.push(input)
      return { reply: "统一回复", emotion: "neutral" }
    },
    onSessionEnd: async session => ended.push(session),
  })
  buffer.addMessage({
    sessionKey: "group:88",
    scene: "group",
    groupId: "88",
    message: message("1", "第一条"),
    debounceMs: 8,
    activeWindowMs: 12,
  })
  await wait(2)
  buffer.addMessage({
    sessionKey: "group:88",
    scene: "group",
    groupId: "88",
    message: message("2", "第二条"),
    debounceMs: 8,
    activeWindowMs: 12,
  })
  await wait(40)
  assert.equal(replies.length, 1)
  assert.deepEqual(
    replies[0].replyBatchMessages.map(item => item.text),
    ["第一条", "第二条"],
  )
  assert.equal(ended.length, 1)
  assert.equal(ended[0].sessionBatches.length, 1)
  assert.equal(buffer.has("group:88"), false)
})

test("回复期间的新消息进入下一批，同一 session 不并发调用模型", async () => {
  let active = 0
  let maxActive = 0
  let calls = 0
  let release
  let notifyStarted
  const started = new Promise(resolve => {
    notifyStarted = resolve
  })
  const gate = new Promise(resolve => {
    release = resolve
  })
  const buffer = new ConversationBuffer({
    setTimer,
    clearTimer,
    onReplyBatch: async () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      if (calls === 1) {
        notifyStarted()
        await gate
      }
      active--
      return { reply: "回复" + calls, emotion: "neutral" }
    },
  })
  buffer.addMessage({
    sessionKey: "private:user:1",
    scene: "private",
    message: message("1", "第一批"),
    debounceMs: 3,
    activeWindowMs: 100,
  })
  await started
  buffer.addMessage({
    sessionKey: "private:user:1",
    scene: "private",
    message: message("1", "回复中发来的第二批"),
    debounceMs: 3,
    activeWindowMs: 100,
  })
  release()
  await wait(20)
  assert.equal(calls, 2)
  assert.equal(maxActive, 1)
  assert.equal(buffer.get("private:user:1").sessionBatches.length, 2)
  buffer.dispose()
})
