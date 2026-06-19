import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateTrigger,
  extractText,
  isIgnoredCommand,
  sessionKeyFor,
} from "../lib/trigger.js"
import { buildChatMessages, normalizeChatResponse } from "../lib/prompt-builder.js"
import { splitReply } from "../lib/reply-splitter.js"

const config = {
  trigger: {
    nicknames: ["派蒙"],
    privateTrigger: true,
    groupMentionTrigger: true,
    groupNicknameTrigger: true,
    ignoreBotSelf: true,
    ignoreCommandPrefixes: ["#", "＃", "*", "%"],
  },
  conversation: {
    collectAllNonCommandInActiveGroupSession: true,
    collectPrivateFollowupWithoutTrigger: true,
    maxContextBatches: 3,
  },
  memory: { maxMemoryCharsForPrompt: 1000 },
}

test("只提取文本并保留对其他用户的 at", () => {
  const text = extractText({
    self_id: "100",
    message: [
      { type: "at", qq: "100" },
      { type: "text", text: " 你好 " },
      { type: "image", url: "x" },
      { type: "at", qq: "200", name: "旅行者" },
    ],
  })
  assert.equal(text, "你好 @旅行者")
})

test("命令前缀始终被忽略且不进入活跃 session", () => {
  for (const prefix of ["#", "＃", "*", "%"])
    assert.equal(isIgnoredCommand("  " + prefix + "帮助", config.trigger.ignoreCommandPrefixes), true)
  const result = evaluateTrigger({
    e: { isGroup: true, atBot: true, user_id: "1", self_id: "2" },
    text: "#派蒙帮助",
    config,
    hasActiveSession: true,
  })
  assert.equal(result.accepted, false)
  assert.equal(result.reason, "command")
})

test("群聊初次需昵称或 at，活跃后收集普通消息", () => {
  const e = { isGroup: true, group_id: "88", user_id: "1", self_id: "2" }
  assert.equal(evaluateTrigger({ e, text: "普通闲聊", config }).accepted, false)
  assert.equal(evaluateTrigger({ e, text: "派蒙在吗", config }).accepted, true)
  assert.equal(
    evaluateTrigger({ e, text: "继续说", config, hasActiveSession: true }).accepted,
    true,
  )
  assert.equal(sessionKeyFor(e), "group:88")
})

test("Prompt 包含群成员、记忆、上下文与 JSON 约束", () => {
  const messages = buildChatMessages({
    session: {
      scene: "group",
      sessionBatches: [
        {
          messages: [{ displayName: "甲", userId: "1", text: "之前的话" }],
          reply: "之前的回复",
        },
      ],
    },
    replyBatchMessages: [{ displayName: "乙", userId: "2", text: "现在的问题" }],
    participantMemories: {
      2: { userId: "2", displayName: "乙", memory: "喜欢简洁回答" },
    },
    knowledge: { text: "知识片段" },
    config,
    persona: "派蒙人设",
  })
  assert.equal(messages.length, 2)
  assert.match(messages[0].content, /合法 JSON/)
  assert.match(messages[0].content, /喜欢简洁回答/)
  assert.match(messages[0].content, /知识片段/)
  assert.match(messages[1].content, /\[乙 \| 2\] 现在的问题/)
  assert.match(messages[1].content, /之前的回复/)
  assert.deepEqual(normalizeChatResponse({ reply: " 好呀 ", emotion: "happy" }), {
    reply: "好呀",
    emotion: "happy",
  })
})

test("回复按中文标点拆分、去句号并限制条数", () => {
  const result = splitReply("第一句话。第二句话！第三句话？第四句话。", {
    minSegmentLength: 2,
    maxSegmentLength: 50,
    maxSegments: 3,
  })
  assert.deepEqual(result, ["第一句话", "第二句话！", "第三句话？第四句话"])
  const fence = String.fromCharCode(96).repeat(3)
  assert.equal(
    splitReply(fence + "js\nconsole.log(1)\n" + fence, {
      maxSegmentLength: 100,
      maxSegments: 4,
      keepCodeBlockTogether: true,
    }).length,
    1,
  )
})
