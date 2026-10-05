# paimon-plugin 对话机器人实现方案

状态：首版功能已实现并完成离线验证；Arch Linux 实机冒烟测试待运行环境方便维护时进行。
目标：在不修改框架任何文件的前提下，只在 `plugins/paimon-plugin` 内实现一个带用户记忆的 DeepSeek 对话机器人插件。

## 0. 实现进度（2026-06-20）

### 已实现

- [x] 插件入口与最低优先级 catch-all：index.js、apps/chat.js，priority 为 99999。
- [x] 插件内配置：默认配置、用户配置自动创建、深合并、环境变量 API key 优先、配置热重载。
- [x] 派蒙人设：config/persona.md 可独立调整。
- [x] DeepSeek 客户端：deepseek-flash、非流式、JSON Output、thinking disabled、超时、错误分类与有限重试。
- [x] 文本与触发过滤：只处理文本；群聊支持 at/昵称初始触发；私聊兜底触发；忽略 #、＃、*、% 命令前缀。
- [x] 群聊/私聊 session：群级或用户级 key、3 秒回复批次防抖、30 秒活跃窗口。
- [x] 同一 session 串行回复：回复期间的新消息进入下一批，不并发调用聊天 API。
- [x] Prompt 组装：人设、参与者用户记忆、短期 session 上下文、知识库插槽和 JSON 响应约束。
- [x] 自然分段回复：阅读与后句长度间隔、整轮等待预算、不限条数、保留内部标点、说明与追问分段、连续问句合并、结构保护及失败重试（2026-10-05 更新）。
- [x] 用户长期记忆：每个 QQ 用户独立 JSON、用户级 Promise 队列、临时文件加 rename 原子写入。
- [x] session 结束记忆评估：校验参与用户与返回结构，只更新合法用户；失败时保留旧记忆并保存 session、旧记忆和错误材料。
- [x] 表情包：按模型情绪、配置概率和本地映射发送；限制资源路径在插件目录内。
- [x] 知识库扩展接口：knowledge-provider 已接入主链路，第一版按设计返回空上下文。
- [x] 错误与敏感信息处理：401/402 静默面向普通用户、429/500/503 有限重试、不记录完整 API key。
- [x] DeepSeek JSONL 调试日志：记录请求、响应、usage、错误、实际分段回复和记忆评估结果；支持脱敏、正文开关与轮转。
- [x] README、默认配置、运行数据忽略规则和单进程测试入口。

### 验证状态

- [x] 42 项离线测试通过（2026-10-05）。
- [x] 群白名单：groupWhitelist.enabled/groups，支持热重载，覆盖群触发、活跃消息、排队请求、发送及 session 记忆评估入口；默认关闭以兼容原配置。
- [x] 全部 JavaScript 文件通过 node --check。
- [x] 插件 index.js 可导入，派蒙聊天插件类可实例化。
- [x] 未修改框架及其他插件，也未在 Windows 安装 Yunzai、QQ 协议或 node_modules。
- [ ] Arch Linux 上的真实 DeepSeek API、私聊、群聊和 QQ 协议冒烟测试；待运行实例方便维护时执行。

### 第一版明确未实现

- [ ] 向量数据库与实际 RAG 检索；当前只有 knowledge-provider 空实现。
- [ ] 复杂情绪识别；当前使用模型返回的有限情绪标签。
- [ ] 活跃 session 跨进程恢复；当前默认只保存在内存中。

## 1. 目标与边界

### 目标

- 群聊触发：消息文本中包含配置的机器人昵称，或消息 at 机器人。
- 私聊触发：在未被其他插件捕获的情况下，所有文本消息触发。
- 只处理文本；暂时忽略图片、视频、语音、文件等非文本内容。
- 每个 QQ 用户独立记忆，只维护用户记忆，不需要群记忆。
- 群聊采用群级 session：只要某个群内有人触发机器人，该群进入活跃 session；后续该群内未被其他插件捕获的非指令类文本消息都进入当前 session。
- 私聊采用用户级 session：私聊中未被其他插件捕获的非指令类文本消息进入该用户的私聊 session。
- session 内使用 3 秒防抖：短时间内连续进入 session 的多条消息合并为一个回复批次，一次性发给 DeepSeek 生成回复。
- 机器人每次完成回复后，当前 session 进入 30 秒活跃窗口；30 秒内有新消息进入则继续该 session；30 秒内没有新消息进入则认为该 session 结束。
- 记忆评估与可选更新发生在完整 session 结束后。
- session 结束后，将整个 session 发给 `deepseek-flash` 做记忆评估；如果其中包含某些用户的长期记忆价值信息，则只更新对应用户的本地记忆 JSON。
- 回复调用 DeepSeek API。
- 回复可以拆成多句，按间隔依次发送，让回复节奏更自然；不模拟“正在输入”。
- 支持可配置人设性格。
- 预留表情包能力：本地存放一些表情包，在聊天情绪合适时偶尔发送。
- 为后续知识库需求预留扩展位置。

### 非目标

- 不修改 `lib/`、`config/`、`plugins/system`、`plugins/adapter` 等框架或已有插件。
- 不接管群聊中 session 开始前的普通闲聊；只有群聊被 at 或昵称触发后，才开始收集该群后续非指令类文本消息。
- 不保存未触发、未进入 session 的普通群聊消息。
- 暂不做图片理解、语音识别、视频理解。
- 暂不做向量数据库或 RAG 实现，只预留结构。
- 第一版不做复杂情绪识别，表情包只按简单规则或模型输出意图触发。

## 2. 关键框架约束

框架的插件处理逻辑是按 `priority` 从小到大执行，某个 `rule` 命中后通常会 `return`，后续插件不会再处理该消息。

因此私聊“未被其他插件捕获的情况下所有消息触发”的可行实现是：

- paimon 插件使用很低优先级，例如 `priority: 99999`。
- 配置一个 catch-all 规则，例如 `reg: ""`。
- 如果其他插件先捕获了该私聊消息，paimon 插件不会被执行。
- 如果没有其他插件捕获，paimon 插件最后收到消息并自行判断是否进入对话 session。

群聊触发也会受这个规则影响：如果某条群消息先被更高优先级插件捕获，paimon 插件不会处理。这符合“不改框架”的前提，也能避免抢已有命令。

群聊活跃 session 内“所有未被其他插件捕获的非指令文本消息都进入 session”的前提也是：该消息能被 paimon 插件收到。如果更高优先级插件已经处理并终止流程，paimon 插件不会感知该消息。

另一个限制：框架在进入插件规则前会计算 `e.only_reply_at`。如果某个群配置了 `onlyReplyAt: 1` 且消息没有 at 机器人、没有匹配框架层的 `botAlias`，消息可能在插件前被过滤。默认配置 `onlyReplyAt: 0` 时不受影响。后续实现时可以在文档里提醒：如果希望“昵称任意位置触发”在严格 onlyReplyAt 群里也生效，需要把该昵称同时加入群配置 `botAlias`，或者保持 `onlyReplyAt: 0`。

## 3. DeepSeek API 依据

依据根目录 `deepseek_api_docs_zh_cn.md`：

- OpenAI 格式 base URL：`https://api.deepseek.com`
- 对话接口：`POST /chat/completions`
- 鉴权：`Authorization: Bearer <API Key>`
- 请求体必须包含：
  - `model`
  - `messages`
- 当前可选模型：`deepseek-flash`、`deepseek-v4-pro`
- 推荐 Flash 模型名为 `deepseek-flash`，对应 DeepSeek-V4.1-Flash；旧名称不作为默认配置。
- API 是无状态的，多轮上下文需要客户端自行拼接。
- JSON 输出可用 `response_format: { "type": "json_object" }`，但仍需要在 prompt 中明确要求输出 JSON。
- 思考模式默认 enabled；思考模式下 `temperature` 不生效，`top_p` 仅在思考模式下生效（0.95–1.0）。普通聊天与 session 记忆评估默认设置 `thinking: { "type": "disabled" }`，便于控制风格与成本。

默认模型：所有普通聊天、session 记忆评估、后续知识库辅助需求，第一版统一使用 `deepseek-flash`。

## 4. 推荐目录结构

所有文件都放在 `plugins/paimon-plugin` 内。

```text
plugins/paimon-plugin/
  IMPLEMENTATION_PLAN.md        当前方案文档
  index.js                      插件加载入口，后续实现
  apps/
    chat.js                     聊天插件主类，后续实现
  lib/
    config.js                   插件内配置读取与热更新
    deepseek.js                 DeepSeek HTTP 客户端
    memory-store.js             用户记忆读写
    memory-compressor.js        session 结束后的用户记忆评估与可选更新逻辑
    trigger.js                  初始触发判断、文本清洗、命令忽略
    conversation-buffer.js      群级/私聊 session 管理、3秒防抖、30秒活跃窗口
    reply-splitter.js           回复拆句与发送节奏
    prompt-builder.js           组装 system/user messages
    sticker-provider.js         表情包选择与发送策略，第一版简单实现
    knowledge-provider.js       知识库扩展接口，先空实现
  config/
    default.yaml                默认配置模板
    config.yaml                 用户实际配置，可被自动创建
    persona.md                  人设性格配置
    stickers.yaml               表情包元信息配置，可选
  data/
    memory/
      users/
        <user_id>.json          每个 QQ 用户一份长期记忆
    runtime/
      sessions/
        <session_id>.json       未结束 session 临时快照，可选
      failed-memory-evaluations/
        <session_id>.json       记忆评估失败的 session 材料，可选
    stickers/
      happy/                    开心类表情包，可选
      angry/                    生气/吐槽类表情包，可选
      confused/                 疑惑类表情包，可选
      comfort/                  安慰类表情包，可选
    logs/
      error.jsonl               插件级错误或 API 调用异常，可选
```

说明：

- 不使用框架的 `config/default_config`，避免改框架配置。
- 不使用 `lib/plugins/config.js` 的默认路径，因为它会写到根目录 `config/<name>.yaml`。本插件应把配置留在 `plugins/paimon-plugin/config`。
- `data/memory/users` 只保存用户长期记忆和必要统计，避免混入当前 session 原文或失败重试材料。
- `data/runtime/sessions` 和 `data/runtime/failed-memory-evaluations` 仅用于临时运行态数据或失败重试材料，session 正常结束并完成评估后应清理对应临时文件。

## 5. 插件入口设计

后续 `index.js` 可导出 `apps`，保持和 `genshin/index.js` 类似的批量入口形式：

```js
export { apps } from "./apps/chat.js"
```

或者第一版更简单：`index.js` 直接导出插件类。由于框架发现插件目录有 `index.js` 时只加载 `index.js`，建议固定使用 `index.js` 作为唯一入口，避免目录下其他工具文件被误认为插件加载。

聊天插件主类建议：

- `name: "派蒙聊天"`
- `event: "message"`
- `priority: 99999`
- `rule: [{ reg: "", fnc: "chat", log: false }]`

方法 `chat(e)` 内部自行判断：

- 是否文本消息。
- 是否需要忽略机器人自身、空消息、纯图片等。
- 是否为需要忽略的命令前缀消息。
- 是否已有 API key。
- 私聊：是否允许私聊触发，或是否已有私聊 session。
- 群聊：是否满足初始触发，或该群是否已有活跃 session。
- 是否进入当前 session 的 3 秒防抖缓冲区。

未触发、且当前没有活跃 session 时返回 `false`，让框架继续尝试更低优先级插件。进入 paimon 对话 session 后返回 `true`，避免同一消息被其他 catch-all 插件重复处理。

注意：进入 session 不代表立即回复。真正调用 DeepSeek 的时机由 `conversation-buffer.js` 的 3 秒防抖定时器决定。

## 6. 配置设计

`plugins/paimon-plugin/config/default.yaml` 建议结构：

```yaml
enabled: true

trigger:
  nicknames:
    - 派蒙
    - 派大王
  stripTriggerName: false
  privateTrigger: true
  groupMentionTrigger: true
  groupNicknameTrigger: true
  ignoreBotSelf: true
  ignoreCommandPrefixes:
    - "#"
    - "＃"
    - "*"
    - "%"

conversation:
  debounceMs: 3000
  activeWindowMs: 30000
  groupSessionKey: group
  privateSessionKey: user
  collectAllNonCommandInActiveGroupSession: true
  collectPrivateFollowupWithoutTrigger: true

deepseek:
  apiKey: ""
  apiKeyEnv: DEEPSEEK_API_KEY
  baseUrl: https://api.deepseek.com
  model: deepseek-flash
  timeoutMs: 60000
  maxTokens: 1200
  temperature: 0.8
  thinking:
    type: disabled
  stream: false

memory:
  enabled: true
  updateMode: session_end_evaluate
  evaluationModel: deepseek-flash
  evaluationMaxTokens: 1600
  evaluationTemperature: 0.2
  userMemoryEnabled: true
  maxParticipantMemoriesForPrompt: 8
  maxMemoryCharsForPrompt: 2500
  maxSessionMessagesForEvaluation: 100
  maxSessionCharsForEvaluation: 12000

runtime:
  persistActiveSessions: false
  saveFailedMemoryEvaluations: true
  maxFailedMemoryEvaluationFiles: 20

reply:
  split: true
  minDelayMs: 2000
  maxDelayMs: 8000
  baseDelayMs: 1200
  typingMsPerChar: 90
  readingMsPerChar: 120
  delayJitter: 0.1
  maxTotalDelayMs: 18000
  minSegmentLength: 15
  maxSegmentLength: 180
  keepCodeBlockTogether: true

persona:
  file: persona.md

stickers:
  enabled: true
  configFile: stickers.yaml
  probability: 0.12
  sendAfterText: true

knowledge:
  enabled: false
  provider: none
```

API key 读取优先级建议：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `config/config.yaml` 中的 `deepseek.apiKey`

这样既支持部署环境注入密钥，也支持本地直接配置。

配置说明：

- `conversation.debounceMs`：session 内 3 秒没有新消息后，将这段时间内收集到的消息合并为一个回复批次。
- `conversation.activeWindowMs`：机器人回复后 30 秒内，如果 session 有新消息进入，则继续该 session；如果 30 秒内没有新消息进入，则 session 结束。
- `conversation.groupSessionKey: group`：群聊 session 按 `group_id` 区分；同一个群的多人发言融入同一个 session。
- `conversation.privateSessionKey: user`：私聊 session 按 `user_id` 区分。
- `conversation.collectAllNonCommandInActiveGroupSession: true`：群聊 session 一旦开始，该群内所有能被 paimon 插件收到的非指令类文本消息都进入当前 session。
- `memory.updateMode: session_end_evaluate`：完整 session 结束后才调用记忆评估接口。
- `memory.maxParticipantMemoriesForPrompt`：群聊回复时最多加载多少个参与用户的长期记忆摘要，避免 prompt 过长。
- `memory.maxSessionMessagesForEvaluation`、`memory.maxSessionCharsForEvaluation`：控制 session 结束后送入记忆评估的材料上限。
- `runtime.persistActiveSessions`：是否把未结束 session 临时快照保存到 `data/runtime/sessions`，第一版默认关闭，仅使用内存。
- `runtime.saveFailedMemoryEvaluations`：记忆评估失败时，是否把完整 session 材料保存到 `data/runtime/failed-memory-evaluations`，避免污染用户记忆 JSON。
- `runtime.maxFailedMemoryEvaluationFiles`：失败评估材料最多保留的文件数，避免运行态目录无限增长。
- `stickers.probability`：表情包触发概率，只在情绪和场景合适时参与判断，不是每次固定发送。

## 7. 人设设计

人设放在 `plugins/paimon-plugin/config/persona.md`，由 `prompt-builder.js` 读取。

默认人设确定为“派蒙”。建议人设内容只描述稳定行为，不写易冲突的“必须每句都怎样”：

- 身份：派蒙风格的 QQ 聊天机器人。
- 语气：自然、口语化、熟悉但不过度热情。
- 边界：不知道就说不知道，不编造。
- QQ 场景：回复短一些，避免长篇演讲。
- 群聊场景：如果多人参与同一 session，要综合多人的发言统一回复，不要逐个机械回答。
- 记忆使用规则：只在有帮助时自然引用用户偏好，不要显式说“根据我的记忆”。
- 隐私规则：不要主动泄露或复述敏感记忆。
- 表情包规则：可以偶尔配合情绪发送表情包。

最终 system prompt 由以下部分组合：

1. 固定安全与行为规则。
2. `persona.md`。
3. 当前参与用户的必要用户记忆摘要。
4. 当前 session 的少量上下文。
5. 后续知识库上下文。
6. 可选表情包意图约束。

## 8. 触发判断

只从文本消息段提取文本：

- 遍历 `e.message`。
- 只拼接 `type === "text"` 的段。
- 无文本则不触发，也不保存。

### 8.1 命令忽略

在判断触发和进入 session 之前，先处理命令忽略。

文本去除首尾空格后，如果以以下前缀开头，则不进入 paimon 对话 session：

- `#`
- `＃`
- `*`
- `%`

规则：

- 被忽略的命令消息不保存。
- 被忽略的命令消息不进入聊天 prompt。
- 被忽略的命令消息不参与 session 记忆评估。
- 被忽略的命令消息不刷新 30 秒活跃窗口。
- 后续如果要做“用户输错指令时给知识库指引”，再新增 command-helper 或 knowledge-command-guide 模块，不混入普通聊天逻辑。

### 8.2 初始触发

私聊：

- `e.isPrivate === true`
- 如果 `privateTrigger` 开启，则所有未被其他插件捕获的非指令文本消息触发。
- 但未知命令前缀消息仍然忽略。

群聊：

- `e.isGroup === true`
- 当前群没有活跃 session 时，满足任一条件即为初始触发：
  - `e.atBot === true`
  - 文本任意位置包含任一 `trigger.nicknames`

触发文本清洗：

- 去掉 at 机器人产生的空白。at转成昵称。
- 如果 `stripTriggerName` 开启，从初始触发消息中移除触发昵称。默认不移除。

### 8.3 session 内消息收集

群聊：

- 只要某个群已经有活跃 session，后续该群内所有能被 paimon 插件收到的非指令类文本消息都进入当前 session。
- 不要求后续消息继续 at 机器人或包含机器人昵称。
- 如果其他插件先捕获并终止了某条消息，paimon 插件不会收到，该消息也不会进入 session。

私聊：

- 私聊通常所有未被其他插件捕获的非指令文本消息都会触发或继续当前私聊 session。

## 9. session 缓冲与活跃窗口

- `reply batch`：一次机器人回复对应的消息批次。session 内 3 秒没有新消息后，将这段时间收集到的消息合并为一个 reply batch，调用 DeepSeek 回复一次。
- `session`：一次完整连续对话。群聊中从某个群被初始触发开始，到该群 30 秒活跃窗口结束为止；私聊中从用户触发开始，到该私聊 30 秒活跃窗口结束为止。

记忆评估以 session 为单位，而不是以 reply batch 为单位。

### 9.1 session key

session key 规则：

```js
const sessionKey = e.isGroup
  ? `group:${e.group_id}`
  : `private:user:${e.user_id}`
```

含义：

```text
群聊 session key  = group_id
私聊 session key  = user_id
用户记忆 file key = user_id
```

群聊中，多个用户会进入同一个 `group:<group_id>` session，但长期记忆仍然只按 `user_id` 保存。

### 9.2 session 结构

```js
{
  sessionKey: "",
  scene: "group | private",
  groupId: "",
  startedByUserId: "",
  participants: {
    "123456": {
      userId: "123456",
      displayName: "群名片或昵称",
      firstSeenAt: 0,
      lastSeenAt: 0
    }
  },

  pendingMessages: [],
  replyBatchTimer: null,

  sessionBatches: [],
  sessionEndTimer: null,

  startedAt: 0,
  updatedAt: 0,
  lastReplyAt: 0,
  isReplying: false
}
```

`pendingMessages` 保存当前即将形成 reply batch 的消息：

`sessionBatches` 保存当前完整 session 内已经发生的用户消息批次与机器人回复：

### 9.3 收集规则

- 群聊中，初始触发消息创建 `group:<group_id>` session。
- 群聊 session 存在期间，该群内所有能被 paimon 插件收到的非指令文本消息都进入当前 session。
- 私聊中，非指令文本消息创建或继续 `private:user:<user_id>` session。
- 每收到一条进入 session 的新消息，加入 `pendingMessages`。
- 每收到一条新消息，清除旧的 `replyBatchTimer`，重新设置 3 秒 timer。
- 3 秒内没有新消息时，将 `pendingMessages` 合并为一个 reply batch 并调用大模型。

### 9.4 reply batch 合并格式

群聊 reply batch 格式：

```text
当前是 QQ 群聊，多位用户可能正在围绕同一个话题讨论。请综合所有人的发言统一回复，不要逐个机械回答。必要时可以点名回应。

本次需要回复的群聊消息：
[张三 | 123456] 派蒙，这个插件记忆怎么做？
[李四 | 456789] 我觉得要按用户存
[王五 | 789012] 群聊上下文也要考虑
```

私聊 reply batch 格式：

```text
用户在短时间内连续发送了以下消息，请作为同一次表达理解并统一回复：

1. 消息一
2. 消息二
3. 消息三
```

### 9.5 活跃窗口与 session 结束

机器人完成一次 reply batch 回复后：

1. 将该 reply batch 的用户消息和机器人回复追加到 `session.sessionBatches`。
2. 清空 `pendingMessages`。
3. 记录 `lastReplyAt = Date.now()`。
4. 设置 `sessionEndTimer = activeWindowMs`。

如果 30 秒内有新消息进入该 session：

- 清除 `sessionEndTimer`。
- 新消息进入 `pendingMessages`。
- 继续 3 秒防抖，形成下一个 reply batch。

如果 30 秒内没有新消息进入该 session：

- 认为完整 session 结束。
- 调用 session 级记忆评估。
- 按评估结果更新参与用户的用户记忆。

### 9.6 回复中收到新消息

如果 `isReplying === true` 时又有新消息进入 session：

- 新消息仍然进入该 session。
- 可以先放入 `pendingMessages`。
- 不打断正在发送的回复。
- 当前回复结束后，如果 `pendingMessages` 非空，再启动/刷新 3 秒防抖，形成下一次 reply batch。
- 这样可以避免多个 DeepSeek 回复 API 在同一个 session 内并发执行，减少上下文错乱。

## 10. 记忆模型

用户记忆文件只存长期记忆和必要统计，不存当前 session 原文、短期上下文或失败重试材料。

每个 QQ 用户一份 JSON，路径：

```text
plugins/paimon-plugin/data/memory/users/<user_id>.json
```

建议数据结构：

```json
{
  "version": 1,
  "userId": "123456",
  "createdAt": "2026-06-09T00:00:00.000Z",
  "updatedAt": "2026-06-09T00:00:00.000Z",
  "memory": "",
  "stats": {
    "sessionCount": 0,
    "replyBatchCount": 0,
    "memoryEvaluationCount": 0,
    "memoryUpdateCount": 0,
    "lastGroupId": "",
    "lastSeenAt": "",
    "lastMemoryEvaluatedAt": "",
    "lastMemoryUpdatedAt": ""
  }
}
```

字段含义：

- `memory`：用户长期记忆文本。保存对未来对话有帮助的信息，例如用户偏好、长期项目、稳定约定、称呼偏好等。
- `stats`：运行统计与调试字段，不直接作为长期记忆内容。

如果 session 记忆评估失败，将完整 session 材料保存到：

```text
plugins/paimon-plugin/data/runtime/failed-memory-evaluations/<session_id>.json
```

### 10.1 记忆更新策略

记忆评估使用单独 API 调用，建议启用 JSON 模式：

```json
{
  "response_format": { "type": "json_object" }
}
```

插件采用 `session_end_evaluate` 策略。

完整 session 结束后，插件将以下内容发送给 `deepseek-flash`：

- 当前 session 的完整 `sessionBatches`。
- 当前 session 参与用户列表。
- 每个参与用户当前旧用户记忆，其中主要使用 `memory` 字段。

模型同时承担两个职责：

1. 判断该 session 中哪些用户出现了值得写入长期记忆的信息。
2. 对每个需要更新的用户返回新的完整长期记忆文本；对不需要更新的用户返回不更新。

### 10.2 哪些内容值得更新用户长期记忆

用户长期记忆只应该保存和某个用户明确相关、且对未来对话有帮助的信息，例如：

- 某用户明确要求记住的信息。
- 某用户稳定偏好，例如回答风格、称呼偏好、讨厌的表达方式。
- 某用户后续对话会持续用到的约定。
- 某用户主动分享的内容。

### 10.3 记忆评估返回结构

记忆评估建议启用 JSON 输出，固定返回：

```json
{
  "version": 1,
  "sessionSummary": "本次 session 主要讨论了 paimon-plugin 的群聊 session、用户记忆和记忆返回结构设计。",
  "userMemoryUpdates": [
    {
      "userId": "123456",
      "shouldUpdateMemory": true,
      "updateReason": "为什么更新或不更新",
      "newMemory": "新的完整长期记忆文本"
    }
  ]
}
```

如果不需要更新某个用户记忆：

```json
{
  "userId": "123456",
  "shouldUpdateMemory": false,
  "updateReason": "为什么更新或不更新",
  "newMemory": null
}
```

程序处理规则：

- 只处理当前 session 参与用户的 `userMemoryUpdates`。
- `shouldUpdateMemory === true` 且 `newMemory` 是合法字符串：写回对应 `<user_id>.json` 的 `memory` 字段，并更新 `stats.memoryUpdateCount`、`stats.lastMemoryUpdatedAt`。
- `shouldUpdateMemory === false`：不更新该用户长期记忆，只更新必要统计字段，例如 `stats.sessionCount`、`stats.replyBatchCount`、`stats.lastSeenAt`、`stats.lastMemoryEvaluatedAt`。
- 如果模型返回了未参与当前 session 的用户更新，直接忽略。
- JSON 解析失败、结构不合法或 API 失败：保留旧记忆，将完整 session 材料保存到 `data/runtime/failed-memory-evaluations/<session_id>.json`，供后续重试或人工排查。

## 11. 消息处理流程

### 11.1 收消息阶段

1. 插件收到事件 `e`。
2. 提取文本，过滤非文本、机器人自身消息、空消息。
3. 如果文本命中命令忽略前缀，返回 `false` 或静默忽略，不进入 session。
4. 计算 `sessionKey`：
   - 群聊：`group:<group_id>`
   - 私聊：`private:user:<user_id>`
5. 群聊：
   - 如果当前群已有活跃 session，则该非指令文本消息直接进入 session。
   - 如果当前群没有活跃 session，则判断是否 at 机器人或包含机器人昵称。
   - 不满足初始触发则返回 `false`。
6. 私聊：
   - 如果 `privateTrigger` 开启，非指令文本消息进入私聊 session。
   - 如果 `privateTrigger` 关闭，但已经有私聊 session，也可以继续该 session。
7. 将消息加入对应 session 的 `pendingMessages`。
8. 清除该 session 旧的 reply batch 防抖 timer。
9. 重新设置 3 秒 timer。
10. 立即返回 `true`。

### 11.2 reply batch 回复阶段

1. 某个 session 的 `pendingMessages` 在 3 秒内没有新消息。
2. 取出当前 `pendingMessages`，但不结束 session。
3. 根据 session 场景合并消息：
   - 群聊：保留每条消息的用户昵称/QQ 号，按时间顺序拼接。
   - 私聊：按顺序合并为一次用户表达。
4. 读取插件配置与人设。
5. 读取当前参与用户的必要用户记忆摘要。
6. 读取当前 session 内最近几个 `sessionBatches`，作为短期上下文。
7. 读取后续知识库上下文，第一版为空实现。
8. 组装 DeepSeek 对话 prompt：
   - system：固定规则 + 人设 + 参与用户记忆摘要 + 知识库上下文。
   - user：当前 reply batch 合并消息。
9. 调用 DeepSeek `/chat/completions` 获取回复。
10. 按配置拆分回复，并按间隔发送。
11. 按配置和情绪判断是否发送表情包。
12. 将该 reply batch 的用户消息和机器人回复追加到 `sessionBatches`。
13. 记录 `lastReplyAt`。
14. 如果当前没有新的 `pendingMessages`，开启 30 秒 `sessionEndTimer`。
15. 如果发送回复期间已经有新消息进入 `pendingMessages`，不启动 session 结束流程，而是继续 3 秒防抖形成下一个 reply batch。

### 11.3 session 结束与记忆评估阶段

1. 某个 session 在机器人最后一次回复后 30 秒内没有新消息进入。
2. 认为该完整 session 结束。
3. 整理完整 session 材料：
   - `sessionBatches`
   - 参与用户列表
   - 每个参与用户的旧记忆
   - 群聊/私聊场景信息
4. 调用 `deepseek-flash` JSON 模式做 session 级记忆评估。
5. 模型返回 `userMemoryUpdates`。
6. 对每个参与用户：
   - 如果 `shouldUpdateMemory: true`，校验并写回该用户新的长期记忆文本。
   - 如果 `shouldUpdateMemory: false`，不更新长期记忆，只更新必要统计字段。
7. 如果评估失败：
   - 保留旧用户记忆。
   - 将完整 session 材料保存到 `data/runtime/failed-memory-evaluations/<session_id>.json`，供后续重试。

如果回复 API 失败：

- 自动重试几次，若依然失败，发送一条简短失败回复，例如“派蒙有点困了，下次再聊吧。”

## 12. Prompt 设计

### 聊天回复 prompt

群聊建议 messages：

```json
[
  {
    "role": "system",
    "content": "固定规则 + 人设 + 参与用户记忆摘要 + 知识库上下文"
  },
  {
    "role": "user",
    "content": "当前群聊 reply batch 消息"
  }
]
```

群聊当前 reply batch 消息格式：

```text
当前是 QQ 群聊，多位用户可能正在围绕同一个话题讨论。请综合所有人的发言统一回复，不要逐个机械回答。必要时可以点名回应。

当前 session 最近上下文：
[张三 | 123456] ...
[机器人] ...
[李四 | 456789] ...
[机器人] ...

本次需要回复的群聊消息：
[张三 | 123456] 派蒙，这个插件记忆怎么做？
[李四 | 456789] 我觉得要按用户存
[王五 | 789012] 群聊上下文也要考虑
```

私聊建议 messages：

```json
[
  {
    "role": "system",
    "content": "固定规则 + 人设 + 用户记忆 + 知识库上下文"
  },
  {
    "role": "user",
    "content": "当前私聊 reply batch 消息"
  }
]
```

私聊当前 reply batch 消息格式：

```text
用户在短时间内连续发送了以下消息，请作为同一次表达理解并统一回复：

1. xxx
2. xxx
3. xxx
```

控制点：

- 聊天模型输出 JSON 格式。

  ```json
  {
    "reply": "自然语言回复文本",
    "emotion": "neutral | happy | confused | angry | comfort | surprised"
  }
  ```

  不使用流式，第一版简化实现。

- `thinking.type` 默认 `disabled`。

- `max_tokens` 控制单次回复长度。

- system 明确要求“适合 QQ 聊天，不要长篇大论”。

- system 明确要求“群聊中要综合多位用户发言统一回复，不要逐个机械回答”。

- system 明确要求“用户连续多条消息是同一次表达，不要逐条机械回答”。

## 13. 回复拆分与发送节奏

拆分策略：

- 先按换行保留段落边界，段内按 `。！？!?` 拆句；省略号保留为句内停顿。
- 全部合并及长度拆分完成后，仅去掉每条末尾的 `。`，内部句号和其他符号保留。
- 过短片段合并，避免一两个字一条。
- 过长片段按 `maxSegmentLength` 再切。
- 如果包含代码块、JSON、大段列表，尽量不拆或少拆，避免破坏格式。
- 不限制发送条数，旧 maxSegments 配置忽略。换行保留分段边界，说明后的问句单独发送，连续问句可合并但不超过 maxSegmentLength；普通短句只在同类句子内合并。拆分、合并期间保留标点，最终只去掉每条末尾的中文句号。结构化内容开启保护时整体发送。

发送策略：

- 第一条立即发送，不额外等待。
- 后续间隔 = max(baseDelayMs + 下一句字数 × typingMsPerChar, 上一句字数 × readingMsPerChar)，默认分别为 1200ms、90ms/字、120ms/字。整轮共用 ±10% 随机系数，间隔默认限制在 2～8 秒。
- 整轮人为等待最多 18 秒（maxTotalDelayMs）；超出时按比例缩短全部间隔，总预算优先于单次最小间隔，不丢弃回复内容。模型请求和消息发送耗时不计入此预算。
- 日常闲聊通过人设引导每段表达完整意思、通常约 15～50 字，段数不限，攻略按信息完整性展开；原 3 秒消息防抖不变。升级旧用户配置需移除或修改旧延迟覆盖项。
- 不调用任何“正在输入”协议能力。
- 发送失败时重试数次，依然失败则停止后续发送并记录错误。

注意：回复拆分发生在 DeepSeek 回复完成之后；用户输入的多句或多人消息合并发生在 DeepSeek 调用之前。两者是两个不同阶段：

```text
session 内消息 → conversation-buffer 合并成 reply batch → 调用 DeepSeek → reply-splitter 拆分机器人回复 → 分段发送
```

## 14. 表情包发送设计

让模型同时返回文字回复和情绪标签，例如：

```json
{
  "reply": "自然语言回复文本",
  "emotion": "neutral | happy | confused | angry | comfort | surprised"
}
```

### 14.1 表情包配置

`plugins/paimon-plugin/config/stickers.yaml` 示例：

```yaml
happy:
  - data/stickers/happy/001.jpg
  - data/stickers/happy/002.jpg
confused:
  - data/stickers/confused/001.jpg
angry:
  - data/stickers/angry/001.jpg
comfort:
  - data/stickers/comfort/001.jpg
```

### 14.2 发送策略

- 只在 `stickers.enabled: true` 时启用。
- 根据用户消息和机器人回复简单判断情绪：开心、疑惑、吐槽、安慰等。
- 命中情绪后，再按 `stickers.probability` 随机决定是否发送。
- 默认 `sendAfterText: true`，即先发文字，再发表情。

## 15. 并发与一致性

需要处理同一 session 内连续消息、多用户参与、以及同一用户记忆文件并发写入问题。

### 15.1 session 消息合并层

- 群聊使用 `conversation-buffer` 按 `group_id` 聚合活跃 session 内的消息。
- 私聊使用 `conversation-buffer` 按 `user_id` 聚合私聊 session 内的消息。
- session 在 3 秒防抖期内的新消息只会重置 timer，不会立即产生新的 API 调用。
- 防抖结束后，同一 session 的 `pendingMessages` 只产生一次 DeepSeek 回复 API 调用。
- 同一 session 内建议同一时间只允许一个回复 API 进行中；回复期间新消息进入下一批 `pendingMessages`。

### 15.2 用户记忆队列层

`conversation-buffer` 解决“多人/多条消息合并为一次回复”。

`queueByUserId` 解决“同一用户记忆文件并发写入导致覆盖”。

建议实现用户级队列：

- `queueByUserId` 保存每个用户的 Promise 链。
- 同一 `user_id` 的记忆读写按顺序处理。
- 不同用户可以并发处理。
- 群聊 session 结束后可能需要更新多个用户记忆；每个用户写入各自队列。
- 同一用户在不同群里同时参与 session 时，对话 session 互相独立，但写同一份用户记忆时仍然排队。

### 15.3 记忆写入

记忆写入：

- 读取 `<user_id>.json`。
- 合并本地统计字段，必要时写入模型返回的新 `memory` 字符串。
- 写入临时文件 `<user_id>.json.tmp`。
- rename 替换为正式文件。

这样可以降低写一半导致 JSON 损坏的概率。

## 16. 错误处理

DeepSeek API 错误按文档可能包括：

- `400`：请求体格式错误。
- `401`：API key 错误。
- `402`：余额不足。
- `422`：参数错误。
- `429`：请求速率达到上限。
- `500`：服务端故障。
- `503`：服务繁忙。

策略：

- `401`、`402`：给主人或日志输出明确错误；对普通用户不做回复。
- `429`、`500`、`503`：可做最多 1 次短重试，避免刷屏。
- 超时：中断当前 API 调用，可选择不回复失败消息。
- JSON 记忆评估解析失败：记录原始返回，保留旧记忆，并将完整 session 材料保存到 `data/runtime/failed-memory-evaluations/<session_id>.json`。
- 表情包发送失败：只记录错误，不影响文字回复与记忆更新。

日志：

- 使用 `Bot.makeLog("error", ...)` 写框架日志。
- 插件内部可选写 `plugins/paimon-plugin/data/logs/error.jsonl`，方便排查 API 返回。
- 不在日志里输出完整 API key。

## 17. 后续知识库预留

第一版不实现知识库，但 prompt 组装应预留 `knowledge-provider`。

建议接口：

```js
async function getKnowledgeContext({ e, session, replyBatchMessages, participantMemories, config }) {
  return {
    text: "",
    citations: []
  }
}
```

第一版返回空字符串。

聊天 prompt 中固定有一个“知识库上下文”插槽。这样后续接入 RAG 时不需要重写整个对话流程。

后续知识库给大模型的推荐方式：

```text
当前 reply batch / 用户问题
  ↓
knowledge-provider 检索相关片段
  ↓
只取最相关的 3-5 段
  ↓
放入 system 或 developer 上下文中的“知识库上下文”区域
  ↓
要求模型优先基于知识库回答，不足时说明不确定
```

## 18. 已确认问题

1. 默认人设是否确定为“派蒙”，还是要自定义一个非原神向人格？

   确定为派蒙。

2. 群聊昵称触发是否要求“任意位置包含”，还是只允许句首/称呼式触发？

   任意位置包含。

3. 私聊中未知 `#命令` 未被其他插件捕获时，是否也交给 paimon 回复？

   否，不回复。`#命令`、`＃命令`、`*命令`、`%命令` 这些都不回复。后续考虑给一个支持指令的知识库，在用户输错指令的时候给出指引。

4. 记忆评估失败时，是否允许短暂保存未评估 session 片段用于下次重试？

   允许。

5. 默认模型用更便宜快速的 `deepseek-flash`，还是默认使用 `deepseek-v4-pro`？

   一切需求都用 `deepseek-flash`。
