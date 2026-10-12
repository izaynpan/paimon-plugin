# paimon-plugin

基于 DeepSeek deepseek-flash 的 QQ 对话插件。插件不修改 Miao-Yunzai 框架文件，支持群级连续会话、私聊会话、按 QQ 用户保存的长期记忆、自然分段回复和可选表情包。

## 使用前准备

1. 在项目根目录安装现有依赖：

   ~~~sh
   pnpm i
   ~~~

2. 推荐通过环境变量提供 DeepSeek API key。PowerShell 示例：

   ~~~powershell
   $env:DEEPSEEK_API_KEY = "sk-..."
   node . dev
   ~~~

   也可以在 config/config.yaml 中覆盖 deepseek.apiKey，但不要把包含真实密钥的配置提交到版本库。

3. 修改配置后无需重启插件；config 目录会被监听并自动重载。

DeepSeek 请求固定使用 OpenAI 兼容的 POST /chat/completions：默认模型为 deepseek-flash，非流式，显式关闭思考模式，并开启 JSON Output。聊天和 session 记忆评估都会要求模型返回合法 JSON。

## 触发与会话

conversation.useUserNickname 默认 true，让派蒙特指用户时优先称呼群名片；在 config/config.yaml 的 conversation 分组中设为 false，则默认称呼“旅行者”。已有个人配置中显式设置的 false 仍会覆盖新默认值，需要改为 true 或删除该覆盖项才会开启。群聊和私聊均生效，支持热重载，从后续模型请求开始使用。称呼优先取协议提供的群名片，缺失或仅含空白时使用 QQ 昵称，再缺失则回退为“旅行者”；私聊没有群名片时直接使用 QQ 昵称，不会使用 QQ 号作为称呼。群内各用户分别对应自己的称呼，不影响会话或记忆标识。这通过模型提示引导，避免对回复文本做全局名字替换。

~~~yaml
conversation:
  useUserNickname: true
~~~

trigger.nicknames 中的称谓会自动加入聊天系统提示，告诉模型这些称谓指向派蒙；persona.md 定义如何结合上下文理解称谓变化并自然回应。建议保持 trigger.stripTriggerName: false，让模型看见用户原始称呼。陌生昵称可由模型结合上下文理解，但未配置的昵称本身不会触发群聊。

群白名单默认关闭。要限制为仅指定群可用，在 config/config.yaml 中加入（支持热重载）：

~~~yaml
groupWhitelist:
  enabled: true
  groups: ["123456789", "987654321"]
~~~

开启后，空列表禁止所有群；未列出的群不会触发、收集消息或调用模型，私聊仍按原配置处理。移出白名单后，待处理批次和后续发送会被拦截，结束时不再评估记忆；已发出的模型请求无法撤回。已发送的消息和已有记忆不会删除。

- 私聊：未被更高优先级插件处理的非指令文本会触发。
- 群聊初次触发：at 机器人，或文本任意位置包含 trigger.nicknames 中的昵称。
- 群聊触发后：同一群进入活跃 session，后续未被其他插件捕获的非指令文本都会进入该 session。
- #、＃、*、% 开头的消息始终忽略，不创建、保存或刷新 session。
- 只处理文本；图片、语音、视频和文件不会进入会话。
- 同一 session 先等待 conversation.debounceMs，把连续消息合并成一次回复；机器人回复完成后保持 conversation.activeWindowMs 的活跃窗口，默认 90000 毫秒（90 秒）。已有 config/config.yaml 中的同名设置会覆盖此默认值。
- 同一 session 同时只会执行一个聊天 API 请求，回复期间的新消息进入下一批。
- 首句直接发送；后续间隔同时考虑上一句阅读时间和下一句长度，默认 4～8 秒，每轮有 ±10% 节奏变化，整轮人为等待最多 30 秒；超预算时仍会压缩间隔。

### 群聊适时不回复（可选）

默认关闭以保持原行为。安装新代码并重启后，在已有 config/config.yaml 的 conversation 分组内设置：

~~~yaml
conversation:
  selectiveGroupReply: true
~~~

此开关仅影响群聊，后续请求支持热更新；私聊仍按原逻辑。白名单、指令过滤、初始昵称/@ 触发设置都不变，窗口外普通发言仍不会调用模型。

- 同一次聊天请求判断整个防抖批次是否需要回应，不额外调用分类 API；主动不回复仍有判断请求的 API 开销。
- 模型同时得到发言者、是否 @Bot、@其他人的列表和匹配称谓。@别人只是线索，不会一律跳过；混合批次应只回应对派蒙说话的部分。
- 开启时输出格式为 `{"shouldReply":true,"reason":"direct_address","reply":"你好","emotion":"happy"}`。不回复为 `{"shouldReply":false,"reason":"talking_to_others","reply":"","emotion":"neutral"}`。
- 回复原因允许 direct_address / answering_paimon / relevant_followup；不回复原因允许 talking_to_others / no_response_needed / asked_to_stop。明确合法的 false 才是主动沉默，空响应、缺字段、类型错误及矛盾字段仍走错误处理，不算正常跳过。
- 主动沉默不发文字、不发表情。日志新增 reply_skipped，包含 session、批次编号、原因代码及 decisionSource=model，不记录额外消息正文；可与 reply_sent 的失败状态及 API 错误日志区分。触发前被过滤的消息不会生成 reply_skipped。
- 沉默批次保留在本次会话短期上下文，标注未回复且不代表同意；长期记忆评估排除这些批次及仅参与沉默批次的用户，全程沉默不调用记忆评估。
- 开启时，实际文字回复发送完成才重新计时 90 秒；沉默和未成功发送不刷新 lastReplyAt 或原截止时间。初次触发后一直沉默，窗口从触发时间计算。
- 到截止时间不再接收无触发的普通续话，防抖也不能无限推迟截止；截止前已入队/在途的批次允许串行处理完成。若最终回复成功，再开启完整窗口；若仍沉默则收尾。处理期间再次明确触发可重新开启窗口，不并发调用。
- 开关按请求快照解释响应，热切换不撤销在途请求；窗口参数对已设定的截止时间不追溯调整。

这是模型判断，不保证每条消息都分类正确；离线测试验证协议、计时及发送行为，实际语义效果仍需群聊观察。异常时可能按原错误策略发送兜底提示，不等于主动沉默。

### 回复节奏

默认间隔公式（毫秒）：max(baseDelayMs + 下一句字数 × typingMsPerChar, 上一句字数 × readingMsPerChar)。按 Unicode 码点计数，随后应用整轮共用的随机系数并限制到 minDelayMs/maxDelayMs。若整轮超出 maxTotalDelayMs，则按比例缩短所有间隔；此时总预算优先，间隔允许低于 minDelayMs。预算仅包含人为等待，不含模型生成、网络发送或重试耗时。

升级旧版本时，在已有 config/config.yaml 的 reply 分组中调整以下字段（不要重复添加 reply 分组）；旧的 minDelayMs: 2000、maxTotalDelayMs: 18000 等用户设置会覆盖新默认值。也可删除这些用户覆盖项，使用 default.yaml 的新默认值。

~~~yaml
reply:
  split: true
  minDelayMs: 4000
  maxDelayMs: 8000
  baseDelayMs: 1200
  typingMsPerChar: 90
  readingMsPerChar: 120
  delayJitter: 0.1
  maxTotalDelayMs: 30000
  minSegmentLength: 15
  maxSegmentLength: 180
  keepCodeBlockTogether: true
  sendRetries: 1
~~~

回复不再限制条数，旧配置中的 maxSegments 会被忽略，可删除。人设建议每段表达完整意思、通常约 15～50 字，段数按内容决定。显式换行保留为分段边界；说明后的问句另起一条，连续问句在 maxSegmentLength 范围内合并。普通短句合并时保留内部标点，只在最终分段完成后去掉消息最末尾的中文句号。规则按标点和换行判断，不是额外调用模型做语义分析。

超长普通文本仍按 maxSegmentLength 拆分；开启结构保护时，代码块、JSON 和列表整体发送。30 秒整轮人为等待预算仍生效，因此条数很多时单次间隔可能压缩到 4 秒以下；可按需要调大 maxTotalDelayMs。聊天过程中不会模拟协议的“正在输入”。

框架限制：如果群配置启用了严格的 onlyReplyAt，非 at 消息可能在到达本插件前被框架过滤。需要把派蒙昵称同步加入群配置 botAlias，或保持 onlyReplyAt: 0。

## DeepSeek 调试日志

默认开启 JSONL 调试日志：

~~~text
data/logs/deepseek.jsonl
~~~

Arch Linux 上可以实时查看：

~~~sh
tail -f plugins/paimon-plugin/data/logs/deepseek.jsonl
~~~

每行是一个独立 JSON 事件，主要事件类型：

- model_request：模型类型、session 标识、完整 messages 和请求参数。
- model_response：模型原始 content、解析后 data、耗时、尝试次数、finish reason 和 token usage。
- model_retry / model_error：重试或最终失败的状态码、错误码与耗时。
- reply_sent：最终回复文本、情绪标签、实际成功发送的分段以及是否失败。
- memory_applied / memory_failed：session 记忆评估最终是否写入用户记忆。

API key 和 Authorization 会被自动脱敏，不写入日志。完整 prompt 和回复可能包含聊天与用户记忆，调试完成后可在 config/config.yaml 中关闭或隐藏正文：

~~~yaml
logging:
  enabled: false
  # 或保留事件但隐藏正文：
  includePrompt: false
  includeResponse: false
  includeUsage: true
~~~

日志默认达到 5 MiB 后轮转，最多保留 3 个文件，可通过 logging.maxBytes 和 logging.maxFiles 调整。

## 用户记忆

长期记忆按 QQ 用户保存：

~~~text
data/memory/users/<user_id>.json
~~~

完整 session 结束后，插件单独调用一次 deepseek-flash 做记忆评估。模型只能更新当前参与用户；程序会校验用户 ID、返回结构和新记忆，并通过用户级 Promise 队列与临时文件 rename 避免并发覆盖或半写入。

评估失败时旧记忆保持不变，session、旧记忆和错误摘要会写入：

~~~text
data/runtime/failed-memory-evaluations/<session_id>.json
~~~

失败材料数量由 runtime.maxFailedMemoryEvaluationFiles 限制。这些运行数据已在插件 .gitignore 中排除。

## 表情包

把图片放在 data/stickers 下，并在 config/stickers.yaml 中按情绪填写相对于插件根目录的路径：

~~~yaml
happy:
  - data/stickers/happy/001.jpg
comfort:
  - data/stickers/comfort/001.jpg
~~~

只有模型返回匹配情绪、配置启用且概率命中时才发送。路径被限制在插件目录内；表情包失败不会影响文字回复或记忆更新。

## 配置入口

- config/default.yaml：完整默认值。
- config/config.yaml：用户覆盖项。
- config/persona.md：派蒙人设。
- config/stickers.yaml：表情包列表。

知识库第一版不检索内容，但 lib/knowledge-provider.js 已提供稳定的空接口，后续接入 RAG 不需要重写聊天主链路。

## 验证

无需额外测试框架：

~~~sh
node plugins/paimon-plugin/tests/run-tests.js
~~~

测试覆盖触发过滤、Prompt、回复拆分、DeepSeek 请求与重试、模型日志与脱敏、用户记忆并发写入、session 防抖和串行化、失败材料、记忆评估及端到端私聊流程。
