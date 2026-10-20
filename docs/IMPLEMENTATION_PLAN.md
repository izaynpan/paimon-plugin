# paimon-plugin 对话机器人实现方案

文档位于插件 `docs/` 目录；下文未另行说明的插件源码、配置和数据路径仍相对于插件根目录。实际使用与配置见 [插件 README](../README.md)。

状态：首版功能已实现并完成离线验证；Arch Linux 实机冒烟测试待运行环境方便维护时进行。
目标：在不修改框架任何文件的前提下，只在 `plugins/paimon-plugin` 内实现一个带用户记忆的 DeepSeek 对话机器人插件。

待实现方案（2026-10-21）：[表情包语境选择与图片标注](STICKER_SELECTION_PLAN.md)，包含派蒙优先、话题角色与最大序号五组的小概率选择，以及图片标注字段、复核流程和实施顺序。明确不增加表情专用冷却或最近图片避重复；仅文档，尚未实现新策略或完成全量标注。

待筛选方案（2026-10-18）：已只读核查服务器实际插件，整理 [指令功能筛选清单](SERVER_COMMAND_CATALOG_2026-10-18.md)、[源码规则索引](SERVER_COMMAND_RULES_2026-10-18.md) 与 [纠错提醒 / 自然语言调用方案](COMMAND_ROUTING_PLAN.md)。仅文档，尚未实现；先由主人选择可提醒与可调用的功能。

已实现（2026-10-18）：[近期会话衔接与搜索缓存](RECENT_CONTEXT_PLAN.md)。`conversation.recentContext` 默认关闭，启用后近期问答与搜索证据共用 24 小时保留期，默认本地文件持久化，可跨每日软件重启恢复未过期资料。独立于长期记忆，不延长原 90 秒活跃触发窗口；引用使用安全单条查询和成功回复 ID 映射。实际配置与限制见 README；未推送、部署或真实联调。

## 0. 实现进度（2026-06-20）

### 已实现

- [x] 本地补查与搜索衔接修正（2026-10-19）：排查发现知识库未启用时，模型误选 lookup_local 会被旧分支提前设置为最终回答，禁止剩余轮次搜索。新增 localLookupAvailable 与条件动作说明；不可用本地动作只拒绝该动作，保留合法搜索机会；真正 knowledge_error 继续保守处理。补充具体角色圣遗物养成的证据缺口规则，保留知识库/有效缓存优先，不按单个关键词强制付费检索。新增 6 项合成回归测试，完整离线测试 212/212 通过，不使用私聊/群聊原文做公开样本；服务器未修改或重启。

- [x] 近期会话衔接（2026-10-18）：新增 recent-context/cache-file/quoted-message，保存成功问答、按范围与原始时间恢复、语境候选及引用去重；只读语境与 session/记忆分离。同源搜索证据另存公开缓存，统一 TTL、命中不续期；来源版本和 Key 分区仍检查。引用/触发前历史共用 1500ms，可取消且不调用框架 sendApi。新增 26 项测试，完整离线测试 206/206 通过；验证边界、持久化和工具调用次数，真实模型续话理解、NapCat 返回兼容和分段消息 ID 需部署后观察。

- [x] 攻略回复加速（2026-10-18）：原聊天请求同时返回 replyKind=guide/chat，攻略及相关追问/澄清默认按 reply.guideDelayScale=0.5 缩短首条反应与分段/同批表情等待目标，普通聊天保持原节奏；与联网无关，缺失/非法分类按 chat。共用成功发送时钟，搜索/API/排队耗时仍抵扣目标，未实现重复追问去重。完整离线测试 180/180 通过，覆盖倍率/上下限、慢请求抵扣、聊天切换、知识/联网路径及表情/错误兜底。首次更新需重启，倍率可热更新；未部署或真实模型验证。

- [x] 搜索决策边界（2026-10-18）：区分用户指代歧义与模型知识缺口；具体名字+攻略问题先按原名核实，续话承接对象，个人条件可澄清；联网开启时区分中间动作与最终 JSON 协议。最终动作/澄清分类补充元数据日志；完整离线测试 174/174 通过，模型实际漏搜率与专用 Key 可用性留待下次实测。

- [x] 搜索独立 Key（2026-10-17）：`webSearch.apiKey` 默认留空沿用聊天 Key，填写后仅用于 Search/Fetch；支持热更新取消在途研究，工具缓存按实际搜索 Key 隔离，额度仍为插件级。完整离线测试 171/171 通过，覆盖凭证分流、空值回退、失败不回退、缓存/额度和热换 Key 取消；未调用真实收费接口。

- [x] 知识库优先的自动联网首版（2026-10-17）：默认关闭的 webSearch 开关，Search/Fetch 与三轮模型上限、持久化每日额度、公开缓存和会话证据复用、取消/降级。知识库仍为空实现，新覆盖度/时效元数据契约已接入；未部署或进行付费 API 验证，详见第 17 节及 README。

- [x] 插件入口与最低优先级 catch-all：index.js、apps/chat.js，priority 为 99999。
- [x] 插件内配置：默认配置、用户配置自动创建、深合并、环境变量 API key 优先、配置热重载。
- [x] 派蒙人设：config/persona.md 可独立调整。
- [x] 人设自然表达调整（2026-10-12）：默认直接回应、闲聊说完即止，减少语气词开场及轮换口癖，不强行转向食物，不重复无人接的梗；本次仅修改人设，实际模型效果待对话验证。
- [x] DeepSeek 客户端：deepseek-flash、非流式、JSON Output、thinking disabled、超时、错误分类与有限重试。
- [x] 文本与触发过滤：只处理文本；群聊支持 at/昵称初始触发；私聊兜底触发；忽略 #、＃、*、% 命令前缀。
- [x] 群聊/私聊 session：群级或用户级 key、3 秒回复批次防抖、默认 90 秒活跃窗口（2026-10-12 调整）。
- [x] 同一 session 串行回复：回复期间的新消息进入下一批，不并发调用聊天 API。
- [x] 先发内容后呼唤（2026-10-13）：已用按需查询协议历史替换前置内存缓存，仅启用已核对的 TRSS OneBotv11 + NapCat 安全路径；同群同用户此前 30 秒内最多 3 条文本，与点名/@ 合为一批，保留纯 @ 修复。详见 9.8，尚未部署。
- [x] Prompt 组装：人设、参与者用户记忆、短期 session 上下文、知识库插槽和 JSON 响应约束。
- [x] 提示词整理（2026-10-16）：合并稳定人设、分离程序协议/决策/称呼，按功能生成一个完整 JSON 结构示例；场景、字段、校验、上下文传递和运行时保持不变。135 项离线测试通过，需求对照与实测清单见 PROMPT_REFACTOR.md，尚未部署或验证真实模型效果。
- [x] 可选群聊主动沉默（2026-10-12）：同次模型请求判断 shouldReply，保留 @ 元数据，严格校验决策；沉默不发送文字/表情、不提取长期记忆，记录 reply_skipped。合法沉默完成后也刷新活跃窗口，默认关闭，详见 9.7。
- [x] 询问无人接话时可选主动补话（2026-10-15）：同次聊天判断真实询问/旧问题状态，默认 30 秒到期独立判断是否补一句；每问题一次、成功后同会话 3 分钟冷却，同 session 串行，处理无关消息/并发新消息/撤权，补话排除长期记忆。默认关闭，详见 9.9，尚未部署。
- [x] 自然分段回复：首条及跨 API 批次共用会话发送时钟、阅读与后条长度间隔、不再用整轮预算压缩、不限条数、保留内部标点、说明与追问分段、连续问句合并、结构保护及失败重试（2026-10-14 更新，本次跨轮节奏尚未部署）。
- [x] 用户长期记忆：每个 QQ 用户独立 JSON、用户级 Promise 队列、临时文件加 rename 原子写入。
- [x] session 结束记忆评估：校验参与用户与返回结构，只更新合法用户；失败时保留旧记忆并保存 session、旧记忆和错误材料。
- [x] 表情包：按模型情绪、配置概率和本地映射发送；限制资源路径在插件目录内。
- [x] 知识库扩展接口：knowledge-provider 已接入主链路，第一版按设计返回空上下文。
- [x] 错误与敏感信息处理：401/402 静默面向普通用户、429/500/503 有限重试、不记录完整 API key。
- [x] DeepSeek JSONL 调试日志：记录请求、响应、usage、错误、实际分段回复和记忆评估结果；支持脱敏、正文开关与轮转。
- [x] README、默认配置、运行数据忽略规则和单进程测试入口。

### 验证状态

- [x] 2026-10-17 联网首版完整离线测试 168/168 通过，新增 33 项覆盖知识库优先、有限搜索/抓取、模型轮次、取消、缓存、预算持久化、引用与原聊天集成；涉及 JS 语法检查通过。未进行真实收费 API、QQ 或部署验证。

- [x] 125 项离线测试通过（2026-10-15），新增主动补话的开关、元数据校验、分段成功计时、无关/拒绝/安静、在途消息撤销、串行队列、冷却、热更新、真实定时回调、清理及记忆排除测试；保留每批首条反应时间、6 字短句阈值、安全历史及原回复/记忆流程测试。不代表完成实际 QQ/API 冒烟测试或模型分类准确率验证。
- [x] 对用户的默认称呼开关：conversation.useUserNickname，默认 true（2026-10-12 调整），优先群名片、其次 QQ 昵称、再缺失用“旅行者”；设为 false 默认称呼“旅行者”。群聊逐用户映射、私聊无需记忆，后续请求热更新；个人配置中已有的 false 会覆盖新默认值。
- [x] 群白名单：groupWhitelist.enabled/groups，支持热重载，覆盖群触发、活跃消息、排队请求、发送及 session 记忆评估入口；默认关闭以兼容原配置。
- [x] 全部 JavaScript 文件通过 node --check。
- [x] 插件 index.js 可导入，派蒙聊天插件类可实例化。
- [x] 未修改框架及其他插件，也未在 Windows 安装 Yunzai、QQ 协议或 node_modules。
- [x] 2026-10-13 通过服务器 NapCat 4.18.1 管理端调用 get_group_msg_history 验证成功：无锚点及带 message_seq 均返回 20 条，含 time/user_id/message_id/message 文本；定位结果包含锚点本身、不包含其后的消息，后续三次查询约 7～25ms。这验证了协议动作，不等于已验证 Yunzai 内完整调用链、跨页行为或接口故障时的安全性。
- [ ] Arch Linux 上的真实 DeepSeek API、私聊、群聊和 QQ 协议冒烟测试；待运行实例方便维护时执行。

### 第一版明确未实现

- [ ] 向量数据库与实际 RAG 检索；当前只有 knowledge-provider 空实现。
- [ ] 复杂情绪识别；当前使用模型返回的有限情绪标签。
- [ ] 活跃 session 跨进程恢复；当前默认只保存在内存中。

### 后续待办（2026-10-13 更新）

- [x] 允许派蒙适时不回复首版：conversation.selectiveGroupReply 默认 false，仅群聊，保留既有触发边界；协议、上下文、日志与测试已接入。
- [x] 按需历史查询替换本地 pre-trigger-buffer 原型；保留纯 @ 修复，接入范围过滤、有限分页、串行初始化、安全超时、脱敏日志及离线测试。
- [ ] 经授权部署后验证历史补查的真实“先提问后点名/@”流程及分页；当前服务器接口实测与离线模拟测试不能替代端到端验收。
- [ ] 在授权部署后用真实群聊观察模型对 @别人、自然续话、多人混合批次、话题收尾及停止要求的判断，依据误判调整提示；暂不增加 @别人硬过滤。

## 1. 目标与边界

### 目标

- 群聊触发：消息文本中包含配置的机器人昵称，或消息 at 机器人。
- 私聊触发：在未被其他插件捕获的情况下，所有文本消息触发。
- 只处理文本；暂时忽略图片、视频、语音、文件等非文本内容。
- 每个 QQ 用户独立记忆，只维护用户记忆，不需要群记忆。
- 群聊采用群级 session：只要某个群内有人触发机器人，该群进入活跃 session；后续该群内未被其他插件捕获的非指令类文本消息都进入当前 session。
- 私聊采用用户级 session：私聊中未被其他插件捕获的非指令类文本消息进入该用户的私聊 session。
- session 内使用 3 秒防抖：短时间内连续进入 session 的多条消息合并为一个回复批次，一次性发给 DeepSeek 生成回复。
- 机器人每次完成回复后，当前 session 默认进入 90 秒活跃窗口；90 秒内有新消息进入则继续该 session；90 秒内没有新消息进入则认为该 session 结束。
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

依据同目录的 [DeepSeek API 中文参考](deepseek_api_docs_zh_cn.md)：

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
  docs/
    IMPLEMENTATION_PLAN.md      当前方案文档
    PROJECT_OVERVIEW.md         框架结构参考（源码路径相对 Miao-Yunzai 根目录）
    deepseek_api_docs_zh_cn.md   DeepSeek API 中文参考
  index.js                      插件加载入口，后续实现
  apps/
    chat.js                     聊天插件主类，后续实现
  lib/
    config.js                   插件内配置读取与热更新
    deepseek.js                 DeepSeek HTTP 客户端
    memory-store.js             用户记忆读写
    memory-compressor.js        session 结束后的用户记忆评估与可选更新逻辑
    trigger.js                  初始触发判断、文本清洗、命令忽略
    conversation-buffer.js      群级/私聊 session 管理、3秒防抖、默认90秒活跃窗口
    reply-splitter.js           回复拆句与顺序发送
    reply-pacer.js              按会话统一首条/跨轮发送时钟与等待取消
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
  selectiveGroupReply: false
  unansweredFollowUp:
    enabled: false
    waitMs: 30000
    cooldownMs: 180000
  debounceMs: 3000
  activeWindowMs: 90000
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
  minDelayMs: 4000
  maxDelayMs: 24000
  baseDelayMs: 1200
  typingMsPerChar: 340
  readingMsPerChar: 360
  delayJitter: 0.1
  minSegmentLength: 6
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
- `conversation.activeWindowMs`：默认 90000 毫秒，机器人回复后 90 秒内，如果 session 有新消息进入，则继续该 session；如果 90 秒内没有新消息进入，则 session 结束。用户配置中的同名设置优先。
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

人设默认放在 `plugins/paimon-plugin/config/persona.md`，配置加载后传给 `prompt-builder.js`。2026-10-16 已整理，完整需求对照见 [提示词整理对照](PROMPT_REFACTOR.md)。

- 人设描述稳定身份、性格、知识与沉浸边界、自然表达及互动习惯：以派蒙身份交流而非自称机器人；正常讨论攻略术语；闲聊简短、复杂攻略完整；不靠口癖或食物表演角色；称谓变化按具体用户与语境理解。
- 程序提示负责 JSON 输出协议、群聊是否回应、询问状态和当前称呼配置。程序协议/决策/称呼优先于人设的表达习惯，不取消身份和知识边界；群聊场景说明及称呼开关不在人设中重复维护。
- 普通聊天根据群/私聊与开关生成一个完整 JSON 结构示例。主动沉默、询问状态、前置历史说明仍按原条件加载；回复字段和响应校验器不变。
- system 包含上述规则、人设、称谓映射、参与者称呼/ID、待回答问题（按需）、用户记忆摘要和知识库插槽。user 包含最近短期上下文及本批消息。动态信息仍保留原位置与截断策略。
- 自动补话使用独立决策提示、同一人设/称呼规则与共用数据边界；用户消息、昵称、历史、记忆和知识片段均不得改写规则，不泄露隐私。
- 表情仍由 emotion 取值与既有表情包模块控制；计时、沉默续期、记忆提取、补话生命周期均未改动。
- 离线需求覆盖与功能测试不能证明真实模型效果；不为压缩字数删除需求，也不因一个特例继续堆专用规则。需要增加行为时先查对照文档，合并到对应职责。

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
- 被忽略的命令消息不刷新活跃窗口（默认 90 秒）。
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
- `session`：一次完整连续对话。群聊中从某个群被初始触发开始，到该群活跃窗口结束为止；私聊中从用户触发开始，到该私聊活跃窗口结束为止。窗口默认 90 秒。

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

下述为默认关闭主动沉默时的流程；开启后的截止时间约束见 9.7。

机器人完成一次 reply batch 回复后：

1. 将该 reply batch 的用户消息和机器人回复追加到 `session.sessionBatches`。
2. 清空 `pendingMessages`。
3. 记录 `lastReplyAt = Date.now()`。
4. 设置 `sessionEndTimer = activeWindowMs`。

如果活跃窗口内（默认 90 秒）有新消息进入该 session：

- 清除 `sessionEndTimer`。
- 新消息进入 `pendingMessages`。
- 继续 3 秒防抖，形成下一个 reply batch。

如果活跃窗口内（默认 90 秒）没有新消息进入该 session：

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

### 9.7 群聊主动沉默（已实现，可选）

- `conversation.selectiveGroupReply: false` 默认兼容原行为；true 仅对群聊启用。同次聊天请求增加 `shouldReply` 布尔值和有限 `reason` 代码，不增加分类请求。
- true 的 reason：direct_address / answering_paimon / relevant_followup，reply 必须非空；false 的 reason：talking_to_others / no_response_needed / asked_to_stop，reply 必须严格为空字符串且 emotion 为 neutral。缺字段、非法类型、矛盾字段或 API 空响应按错误处理，不自动转成沉默。私聊/关闭时使用原响应格式。
- 当前消息以结构化数据传递发言者、mentionsBot、mentionedUserIds、matchedBotNames 和正文。根据整个批次判断是否回应；不把 @别人设成硬过滤。已有触发、白名单及其他插件优先级保持不变。
- 2026-10-16 补充通用接梗提示：结合近期对话识别昵称嵌入、谐音、双关和故意断句，明显在逗派蒙时可简短回应，无需明确提问；偶然命中昵称、旁人交流或不确定时仍可沉默，要求停止时仍尊重。接语言玩笑不意味着放开世界外知识问答，不编造梗义或动机。不增加分类 API、专用关键词或强制回复规则，实际识梗效果需实群观察。
- 主动沉默提前结束发送流程，包含前置和后置表情均不发送；返回 skipped=true、failed=false。reply_skipped 记录会话、批次编号、参与者、数量和原因代码；没有触发/API异常/白名单拦截不冒充模型沉默。
- conversation-buffer 保存 skipped 标记和用户发言，后续短期提示说明未回复、不代表同意；长期记忆评估在代码中排除沉默批次和仅参与这些批次的用户。全部批次沉默时不调用记忆 API。
- 开启时保存绝对 expiresAt：初始为触发时间 + activeWindowMs；实际发送文字或合法沉默后，均从批次处理完成时重设完整窗口（2026-10-12 调整）。只有实际发言更新 lastReplyAt，沉默不伪装成发言；无成功发送的错误不续长原期限。成功发送的异常兜底提示算实际发言，但日志仍标为失败。
- 普通消息入队本身不续期，防抖不晚于当前截止时间启动，避免持续输入一直推迟模型判断；截止后不再接受无触发的普通续话，已接纳的待处理/在途批次可串行完成。若最终发送成功或合法沉默则续窗口，否则到期收尾；期间重新明确触发可以重开窗口，沿用现有串行队列。
- 连续合法沉默可保持同一 session，让无称谓的恢复发言继续进入判断并携带最近上下文；持续群聊可能延长会话及增加 API 开销。未改变长期记忆开关、沉默批次的记忆排除规则或窗口外初始触发边界。
- 开关热更新用于后续请求；在途响应按发起请求时的协议解析，白名单发送前复查仍生效。修改窗口长度不追溯更改已有截止时间。
- 离线测试仅验证流程与提示内容，真实模型的“不插话/不漏答”效果需要上线验证，不承诺完美分类。

### 9.8 先发内容后呼唤（按需历史查询，已在本地实现）

2026-10-13 已替换本地缓存原型：插件不再持续暂存未触发的群消息，只在被呼唤时查询协议历史。本节对应当前本地实现，不代表已经部署。已有活跃 session 的正常内存上下文不在移除范围内。

#### 9.8.1 查询入口与范围

1. 先执行原触发、白名单、插件开关、自身消息、命令过滤和 API key 检查。只有无活跃或仍在收尾的群 session 且本次通过昵称或 @ 明确触发时才补查；私聊、活跃会话普通续话不查询。纯 @Bot 的空文本修复保留，仍遵守 groupMentionTrigger。
2. 使用本次事件所属 Bot 的群历史能力，查询同一群；沿用 getChatHistory 的 OneBot 动作语义 get_group_msg_history，但不调用其不安全超时封装。当前只启用 adapter.name=OneBotv11、version.app_name=NapCat.Onebot、连接可用且有兼容 echo Map 的组合，其他适配器跳过。不扫描运行日志、不依赖 NapCat WebUI 凭据。Bot 账号只决定查询连接，不成为新的会话隔离或账号白名单。
3. 以呼唤消息的时间和消息 ID 定位此前记录，不能用请求完成时间作为 30 秒终点。message_seq 的具体映射由适配层确认；本次 NapCat 实测可以传入消息 ID，不能将此视为所有适配器的保证。锚点或时间不足以确定边界时，保守跳过补查。
4. 默认每页 20 条，最多 3 页、总共最多扫描 60 条，整次查询共用 1500ms 预算，不逐页重置。筛满同用户最近 3 条、到达时间下界、返回不足一页、游标不前进或预算耗尽时停止。只支持 NapCat 的含锚点、时间升序页面语义，不支持的适配器不查询；不保证繁忙群里一定覆盖完整 30 秒。

#### 9.8.2 筛选与合并

- 只选同群、同一呼唤者、呼唤之前 30 秒内的文本；排除当前呼唤、Bot 自己、其他用户、命令、无文本消息。不读取图片/语音/文件内容，也不将整个历史返回包直接交给大模型。
- 默认最多 3 条、每条最多 4000 字符；保留时间、用户、群名片/昵称、@ 元数据与原始称谓。按时间及协议原始顺序排列，同秒消息不能单靠时间戳判断先后，也不能假设 message_id 数值大小代表时间顺序。
- NapCat 返回结果包含锚点本身，按 message_id 去重；同时排除本 session 已接纳的消息和翻页重复项。跨页游标不推进时立即停止。缺失必要身份字段的记录跳过；缺少时间/锚点、乱序等无法可信定位边界的返回则放弃整次补查，不猜测。CQ 字符串历史不作不可靠的结构解析。
- 历史作为 preTrigger=true 的补充消息排在呼唤之前，进入同一次模型请求；提示词说明这是呼唤者近期前文，以最新明确意图为准，不机械回答所有旧话题。发送仍使用本次事件 e.reply。
- 同群查询等待期间的新消息进入最多 50 条的初始化队列；满额取消历史查询并先处理已接纳消息，随后正常继续。最多 8 群并行初始化，其他群直接正常触发。按群串行初始化、去重，不因 await 查询产生多个 session、并发模型请求或打乱顺序。超时后正常处理本次呼唤及已接纳新消息，晚到历史不再插入已发起的请求。
- 历史可能包含此前被其他插件处理过的普通文本，这与原缓存方案不同；只能重新应用可确定的过滤规则，无法从历史重建其他插件当时的消费状态。补入只作为语境，不重放事件、不执行其他插件指令，不能宣称完全保留此前“仅回看实际到达派蒙插件”的范围。

#### 9.8.3 超时、降级与连接安全

- 无接口、接口报错、没有有效历史、预算耗尽时，放弃补充，继续原有触发回复；查询失败不发报错到群里，不阻止 @/点名唤醒。默认不重试、不退回常驻文本缓存。
- 关键风险：当前 plugins/adapter/OneBotv11.js 的 sendApi 在 60 秒超时回调里会调用 ws.terminate()。只用 Promise.race 做 1500ms 上层超时并不能取消底层计时器，不能作为最终实现。
- lib/history-provider.js 已实现专用只读传输：在原 adapter.echo Map 注册独立 paimon-history-UUID 等待项，直接向本次 bot.ws 发送 get_group_msg_history。成功/失败/超时/abort/断线均释放自身等待项、计时器及关闭/错误监听，不创建框架 sendApi 的 60 秒计时器、不改全局超时、不关闭连接。其他 echo 等待项不受影响。不符合已核对接口形状的适配器视为不支持；迟到响应不再进入本插件，框架自身可能按其未知响应日志规则处理。
- 补查返回后、并入批次前再次确认插件开关、白名单及 session/初始化状态；热重载撤销资格、dispose、连接断开或已有批次开始后，迟到结果丢弃。沿用模型调用前及发送前的现有检查。

#### 9.8.4 配置、日志与迁移

保留 conversation.preTrigger.enabled/windowMs/maxMessages，默认 true/30000/3；新增字段已接入：

```yaml
conversation:
  preTrigger:
    enabled: true
    windowMs: 30000
    maxMessages: 3
    historyPageSize: 20
    historyMaxPages: 3
    historyTimeoutMs: 1500
```

- 新字段需要更新代码并重启后才有作用。上限为时间窗 5 分钟、最多 20 条、每页 100 条、5 页、超时 5 秒；文本每条最多 4000 字符。enabled=false 或任一条数/时限为 0 禁用补查，不改变正常触发。
- 删除 pre-trigger-buffer 及触发前 add/configure/take 路径，未触发消息直接返回；只保留本次查询、短暂初始化队列和正常会话上下文，无新增常驻前置文本缓存或历史落盘。
- 已新增 history_lookup 日志，记录 session/群标识、来源、状态、原因、页数、扫描/选取数量和耗时，不记录认证信息或原始历史正文。选中并入模型请求的文本遵守已有 includePrompt 配置；普通被动消息不产生插件日志。协议框架自身的日志配置独立。
- 不启用长期记忆，不新增大模型分类调用。历史查询是 QQ 协议调用；补入后的批次沿用正常日志、主动沉默和长期记忆开关。短超时只限制额外等待，不影响原模型请求超时配置。

#### 9.8.5 实现及验收顺序

1. [x] 安全传输层和分页游标离线验证：超时不关闭共享连接、其他 API 等待项不受干扰、迟到响应不补入；其他协议不支持时正常唤醒。
2. [x] 历史规范化、时间边界、同群同用户筛选、锚点/跨页/session 去重、条数和长度限制。
3. [x] 触发及初始化串行队列，移除前置缓存；保留纯 @ 修复、触发开关和提示标记。
4. [x] 已替换缓存测试；当时（2026-10-13）全套 83 项离线测试通过，README、默认配置、共享背景已同步。
5. [ ] 经授权更新服务器后做真实“先提问后点名/@”及分页验证。接口实测和离线测试不能代替端到端验证。

### 9.9 询问无人接话时主动补话（2026-10-15 已本地实现）

配置 conversation.unansweredFollowUp，默认 enabled=false、waitMs=30000、cooldownMs=180000；独立于长期记忆和 selectiveGroupReply，支持群聊/私聊。waitMs 限 5000～300000ms，cooldownMs 限 30000～3600000ms。改变主开关/白名单等取消待处理问题，等待时长热改以原发送时间重算；已开始请求不重排。

**正常聊天响应扩展**（仅开启时请求；坏元数据不破坏正常回复）：

~~~json
{
  "reply": "旅行者，你想先去哪个地方？",
  "emotion": "neutral",
  "followUp": {
    "eligible": true,
    "question": "旅行者，你想先去哪个地方？",
    "targetUserIds": ["当前参与者ID"]
  },
  "pendingQuestion": null
}
~~~

开启主动沉默时仍保留原 shouldReply/reason。followUp 可为 {eligible:false}；问题需为本次回复实际包含的原文（≤200码点），目标 ID 数组最多8项且来自已知参与者，空数组表示群体提问。反问、自问自答、礼貌收尾等由提示引导拒绝资格，不靠问号硬判。没有合法候选不建定时器。

存在待回答问题时额外返回 pendingQuestion={id,status}，id 为代码生成的 UUID，status 允许 answered/declined/topic_changed/unrelated/uncertain，与 shouldReply 独立。仅合法沉默且明确 unrelated 保留原倒计时；缺失/错误 ID/无效状态按 uncertain 取消，asked_to_stop 优先取消，正常新发言撤销旧问题并可建立新的合法候选。拒绝时不得因新候选再次计时。未开主动沉默不改变原聊天必答语义，实际新发言仍会撤销旧问题。

**生命周期与并发：**

1. ConversationBuffer 在文本发送、上下文入账后调用 onBatchComplete；全部文字成功才建立问题，从最后一条文字协议成功时间起等30秒，而非模型返回时间。原批次发送期间的新输入留在 pendingMessages，下一批可判断已建立的问题。每 sessionKey 最多一个问题。
2. UnansweredFollowUp 仅在内存保存问题、目标、原批次索引/发送时间、事件与定时器。上下文复用 sessionBatches，不维护额外群聊全文缓存；自动补话使用原事件 reply 发送，不按 Bot 账号另建会话。
3. 到期若普通批次正在运行/排队则延后检查，最多宽限30秒，之后放弃；session 过期不复活。runIdle 与正常批次共用 isReplying 锁，确保同会话模型调用串行，不伪造一条用户输入。
4. 到期 API 单次判断并生成，type=unanswered_follow_up，最多256输出token、最长15秒、不重试；提示提供问题、对象、最近上下文和明确的 afterQuestion，避免把之前的话误认为回答。不带长期记忆或额外知识检索，不虚构来源。
5. 响应允许 shouldReply=false，reason 为 not_appropriate/already_answered，reply 必须为空；发送时应为 true/unanswered_question，reply 非空、单行、≤80码点且不含 CQ 码。语气自然简短，不模板催人、不指责冷落或制造内疚。无效输出/异常安静结束，无兜底。
6. 发送前再次核对 pending 对象身份、session ID/有效期、开关、key、白名单、待处理消息。请求/节奏等待期间任何新接纳文本都取消这次补话，结果丢弃且不重新请求；已发 API/协议消息不可撤回。未收到或被其他插件消费的消息、图片/语音不保证能判断。
7. 只尝试发送一条、不重试、不发表情；沿用 ReplyPacer 连续消息间隔，isBatchFirst=false。成功后按当前调用快照设置同聊天3分钟冷却，普通回复不受影响；补话不递归建立问题，成功续活跃窗口。补话 batch 使用 origin=unanswered_follow_up、messages=[]，加入短期上下文但在记忆材料和评估入口均排除。
8. 模型选择不发、调用/发送失败或完成后均清理待回答问题；结束会话清理等待，dispose 清理等待及冷却定时器；冷却跨短 session 保留并到期释放，不持久化，不跨重启恢复。

日志：follow_up_armed/not_armed/cancelled/due/decision/sent/error 记录问题 ID/原因等元数据，不含正文；补话实际文本及 pacing 沿用 reply_sent(type=unanswered_follow_up)，模型调用沿用 model_request/response/error 正文开关。默认关闭无额外 API；启用后正常请求有少量字段开销，每个到期候选最多额外一次模型调用。需要更新代码并重启，尚未部署，离线测试不代表语义判断准确率已验证。

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
14. 如果当前没有新的 `pendingMessages`，开启 `sessionEndTimer`，时长取 `activeWindowMs`（默认 90 秒）。
15. 如果发送回复期间已经有新消息进入 `pendingMessages`，不启动 session 结束流程，而是继续 3 秒防抖形成下一个 reply batch。

### 11.3 session 结束与记忆评估阶段

1. 某个 session 在机器人最后一次回复后的活跃窗口内（默认 90 秒）没有新消息进入。
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

2026-10-18 补充：以下基础公式为普通节奏；攻略批次先按公式/抖动/上下限计算，再乘 `reply.guideDelayScale`（默认 0.5，0.1～1，1 关闭加速）。整个批次使用固定倍率，目标范围默认 2～12 秒，日常仍为 4～24 秒。reply_sent 记录 replyKind，pacing 记录 delayScale；错误兜底与主动补话不加速。该倍率不修改防抖、请求超时或会话串行队列，不保证端到端耗时减半，详见 README。

拆分策略：

- 先按换行保留段落边界，段内按 `。！？!?` 拆句；省略号保留为句内停顿。
- 全部合并及长度拆分完成后，仅去掉每条末尾的 `。`，内部句号和其他符号保留。
- 过短片段合并，避免一两个字一条；minSegmentLength 默认 6（2026-10-14 从 15 下调，含标点按码点计数）。感叹号仍保留并参与拆句，但不强制断开，前后同类片段任一过短时仍可能合并；个人配置旧值仍优先。
- 过长片段按 `maxSegmentLength` 再切。
- 如果包含代码块、JSON、大段列表，尽量不拆或少拆，避免破坏格式。
- 不限制发送条数，旧 maxSegments 配置忽略。换行保留分段边界，说明后的问句单独发送，连续问句可合并但不超过 maxSegmentLength；普通短句只在同类句子内合并。拆分、合并期间保留标点，最终只去掉每条末尾的中文句号。结构化内容开启保护时整体发送。

发送策略：

- 首条也参与节奏控制。reply-pacer 按 sessionKey（群号/私聊用户，不按 Bot 账号）串行发送并保存上一条成功发送完成时间和码点长度，跨 API 批次、拆分/合并和短期 session 切换均不重置。同批共用一个随机系数。
- 目标间隔 = max(baseDelayMs + 下一条字数 × typingMsPerChar, 上一条字数 × readingMsPerChar)，默认分别为 1200ms、340ms/字、360ms/字。应用 ±10% 抖动后限制在 4～24 秒（2026-10-14 调整）。前后条均为 20／40／60 字时，不计抖动约为 8／14.8／21.6 秒。
- 每批首条同时满足：最后一条用户消息本地接收时间 + 首条反应目标（baseDelayMs + 首条字数 × typingMsPerChar，经相同抖动/上下限处理），以及上一条成功发送完成时间 + 连续消息目标间隔。取较晚期限，不相加；用户发消息之前的停顿不能抵扣首条反应时间。没有上一条记录时仅使用首条反应期限，后续分段只按连续消息间隔。缓冲区最后接收时间为内部字段，不进入模型、上下文或长期记忆，不使用协议历史时间。API、防抖和排队耗时计入，只补等剩余时间。API 或协议过慢时实际间隔可以更长，不能承诺端到端固定时间或最长 24 秒。
- 旧 maxTotalDelayMs 忽略并从默认配置移除；绝不因整轮预算压缩目标间隔，也不丢弃内容。长回复可能等待超过 90 秒、增加后续排队时间。本次跨轮节奏仅完成本地修改与离线验证，未部署。
- 表情包（按 0 字）和错误兜底走同一时钟。沉默及失败发送不更新成功记录；重试仍有限，等待后重新检查开关/群白名单，dispose 取消等待和排队发送。每个会话只保留时间/长度/队列状态，无正文；无待发工作时空闲 max(5 分钟, maxDelayMs×2, minDelayMs×2) 后清理（计时器上限约 24.8 天），停止运行时全部清理。其他插件消息不计入。
- reply_sent.pacing 记录各次发送的消息类型、长度、目标间隔、补等时间、成功时间戳和实际间隔，新增 isBatchFirst/reactionStartedAt/reactionTargetMs 区分每批首条及其接收基准/反应目标；firstLatencyMs 改为每批首条相对本批最后接收时间的耗时，后续消息为 null，失败成功时间为 null。不含正文，关闭日志正文时仍可用于调试。成功时间以协议返回为准，非 QQ 客户端显示回执。
- 日常闲聊通过人设引导回应一个重点、说完即止，不设每段固定字数或段数，攻略按信息完整性展开；原 3 秒消息防抖不变。升级旧用户配置需移除或修改旧延迟覆盖项。
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

2026-10-17 已实现 [知识库优先与按需联网方案 v1](KNOWLEDGE_WEB_SEARCH_PLAN.md) 的联网首版：`webSearch.enabled` 默认 false；同次聊天决定直接回答/澄清/本地补查/联网，完整且适用的知识结果阻止普通搜索。接入 Search/Fetch、每题模型和工具上限、持久化每日工具尝试额度、公开缓存与会话证据复用、取消及降级。已完成离线测试，未部署或真实收费 API 验证。真实知识库检索与结构化版本同步仍未实现；下面为空接口与早期预留设计，新增 provider 元数据契约见链接。

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

   普通聊天继续忽略这些前缀。2026-10-19 已增加默认关闭的独立指令路由：按主人结果列选择的功能进行纠错提醒（不代执行错误指令），明确自然语言请求可以定向调用。覆盖范围、版本/身份约束、验证与限制见 [COMMAND_ROUTING_PLAN.md 第 10 节](COMMAND_ROUTING_PLAN.md#10-2026-10-19-首版实现与验收) 和 README，不通过知识库生成任意指令。

4. 记忆评估失败时，是否允许短暂保存未评估 session 片段用于下次重试？

   允许。

5. 默认模型用更便宜快速的 `deepseek-flash`，还是默认使用 `deepseek-v4-pro`？

   一切需求都用 `deepseek-flash`。
