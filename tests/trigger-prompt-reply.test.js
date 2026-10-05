import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateTrigger,
  extractText,
  isIgnoredCommand,
  messageFromEvent,
  sessionKeyFor,
} from "../lib/trigger.js"
import { buildChatMessages, normalizeChatResponse } from "../lib/prompt-builder.js"
import { splitReply } from "../lib/reply-splitter.js"

const config = {
  trigger: {
    nicknames: ["派蒙", "派大王"],
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

test("用户称呼优先 QQ 昵称、其次群名片，缺失时不使用 QQ 号", () => {
  const e = { user_id: "123", sender: { nickname: "小林", card: "群名片" } }
  assert.equal(messageFromEvent(e, "你好").nickname, "小林")
  assert.equal(messageFromEvent({ ...e, sender: { nickname: " ", card: "群名片" } }, "你好").nickname, "群名片")
  assert.equal(messageFromEvent({ user_id: "123" }, "你好").nickname, "")
})

test("群聊昵称逐用户映射，当前昵称覆盖旧昵称并为缺失昵称回退", () => {
  const messages = buildChatMessages({
    session: {
      scene: "group",
      participants: { 1: { userId: "1", nickname: "旧昵称" }, 2: { userId: "2", nickname: "小张" } },
    },
    replyBatchMessages: [
      { userId: "1", nickname: "小林", displayName: "群名片", text: "你好" },
      { userId: "3", nickname: "", displayName: "3", text: "在吗" },
    ],
    config: { ...config, conversation: { useUserNickname: true } },
  })
  const addressing = messages[0].content.split("【对用户的称呼规则】")[1].split("【参与用户长期记忆】")[0]
  assert.match(addressing, /"userId":"1","nickname":"小林"/)
  assert.match(addressing, /"userId":"2","nickname":"小张"/)
  assert.match(addressing, /"userId":"3","nickname":"旅行者"/)
  assert.doesNotMatch(addressing, /旧昵称|群名片/)
})

test("私聊无需记忆也能获得昵称，切换开关后恢复旅行者称呼", () => {
  const cfg = { ...config, conversation: { useUserNickname: true } }
  const input = {
    session: { scene: "private" },
    replyBatchMessages: [messageFromEvent({ user_id: "1", sender: { nickname: "小林" } }, "派蒙你好")],
    config: cfg,
  }
  assert.match(buildChatMessages(input)[0].content, /"nickname":"小林"/)
  cfg.conversation.useUserNickname = false
  const disabled = buildChatMessages(input)[0].content
  assert.match(disabled, /默认称呼对方为‘旅行者’/)
  assert.doesNotMatch(disabled, /"nickname":"小林"/)
  delete cfg.conversation.useUserNickname
  assert.match(buildChatMessages(input)[0].content, /默认称呼对方为‘旅行者’/)
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

test("群白名单优先于 at、昵称和活跃会话，且不限制私聊", () => {
  const restricted = { ...config, groupWhitelist: { enabled: true, groups: [88] } }
  const e = { isGroup: true, group_id: "99", user_id: "1", self_id: "2", atBot: true }
  for (const hasActiveSession of [false, true]) {
    const result = evaluateTrigger({ e, text: "派蒙你好", config: restricted, hasActiveSession })
    assert.equal(result.accepted, false)
    assert.equal(result.reason, "group-not-whitelisted")
  }
  assert.equal(evaluateTrigger({ e: { ...e, group_id: "88" }, text: "你好", config: restricted }).accepted, true)
  assert.equal(evaluateTrigger({ e: { isPrivate: true, user_id: "1", self_id: "2" }, text: "你好", config: restricted }).accepted, true)
  restricted.groupWhitelist.groups = []
  assert.equal(evaluateTrigger({ e, text: "派蒙", config: restricted }).accepted, false)
  restricted.groupWhitelist.enabled = false
  assert.equal(evaluateTrigger({ e, text: "派蒙", config: restricted }).accepted, true)
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
  assert.match(messages[0].content, /【称谓映射】/)
  assert.match(messages[0].content, /\["派蒙","派大王"\]/)
  assert.match(messages[1].content, /\[乙 \| 2\] 现在的问题/)
  assert.match(messages[1].content, /之前的回复/)
  assert.deepEqual(normalizeChatResponse({ reply: " 好呀 ", emotion: "happy" }), {
    reply: "好呀",
    emotion: "happy",
  })
})

test("回复按中文标点拆分、只去最终句号且不限制条数", () => {
  const result = splitReply("第一句话。第二句话！第三句话？第四句话。", {
    minSegmentLength: 2,
    maxSegmentLength: 50,
    maxSegments: 3,
  })
  assert.deepEqual(result, ["第一句话", "第二句话！", "第三句话？", "第四句话"])
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
