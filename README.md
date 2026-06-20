# paimon-plugin

基于 DeepSeek deepseek-v4-flash 的 QQ 对话插件。插件不修改 Miao-Yunzai 框架文件，支持群级连续会话、私聊会话、按 QQ 用户保存的长期记忆、自然分段回复和可选表情包。

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

DeepSeek 请求固定使用 OpenAI 兼容的 POST /chat/completions：默认模型为 deepseek-v4-flash，非流式，显式关闭思考模式，并开启 JSON Output。聊天和 session 记忆评估都会要求模型返回合法 JSON。

## 触发与会话

- 私聊：未被更高优先级插件处理的非指令文本会触发。
- 群聊初次触发：at 机器人，或文本任意位置包含 trigger.nicknames 中的昵称。
- 群聊触发后：同一群进入活跃 session，后续未被其他插件捕获的非指令文本都会进入该 session。
- #、＃、*、% 开头的消息始终忽略，不创建、保存或刷新 session。
- 只处理文本；图片、语音、视频和文件不会进入会话。
- 同一 session 先等待 conversation.debounceMs，把连续消息合并成一次回复；机器人回复完成后保持 conversation.activeWindowMs 的活跃窗口。
- 同一 session 同时只会执行一个聊天 API 请求，回复期间的新消息进入下一批。

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

完整 session 结束后，插件单独调用一次 deepseek-v4-flash 做记忆评估。模型只能更新当前参与用户；程序会校验用户 ID、返回结构和新记忆，并通过用户级 Promise 队列与临时文件 rename 避免并发覆盖或半写入。

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
