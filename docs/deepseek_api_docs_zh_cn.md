# DeepSeek API 中文参考整理

本文件与其他开发参考文档统一存放于 `plugins/paimon-plugin/docs/`；派蒙当前使用说明见 [插件 README](../README.md)。

核对日期：2026-10-17（北京时间）。依据 [DeepSeek 官方中文文档](https://api-docs.deepseek.com/zh-cn/) 更新；本文件为开发参考摘编，不是完整站点镜像。本次重点核对更新日志、模型价格、Search/Fetch、聊天参数、思考模式、JSON、工具调用及 Responses 兼容性；部分页面直接抓取超时，使用当日官方搜索索引交叉核对。其他既有章节未逐项重新验证，模型、价格和限制以在线文档为准。

本次主要修订：Flash 后端升级为 V4.1-Flash-1017；新增 Search/Fetch 的接口、计费、限速及派蒙接入费用估算；修正 Pro 的 top_p 说明和流式 usage 行为，补充 Responses 内置搜索的模型限制。仅更新参考文档，未修改 paimon-plugin 配置或代码。

2026-10-17 更新日志明确：`deepseek-flash` 的调用方式和价格不变。现有派蒙使用 Chat Completions、非流式、关闭思考及 JSON Output，未发现本次更新要求迁移这些参数；后台模型已更新，实际措辞和决策效果仍可能变化，未进行真实付费 API/QQ 冒烟验证。[更新日志](https://api-docs.deepseek.com/zh-cn/updates/)

## 官方来源

- [首次调用](https://api-docs.deepseek.com/zh-cn/)
- [模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [2026-10-17 发布公告](https://api-docs.deepseek.com/zh-cn/news/news261017/)
- [网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)
- [Search API](https://api-docs.deepseek.com/zh-cn/api/search/)
- [Fetch API](https://api-docs.deepseek.com/zh-cn/api/fetch/)
- [更新日志](https://api-docs.deepseek.com/zh-cn/updates/)
- [对话补全参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)
- [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)
- [工具调用](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)
- [FIM](https://api-docs.deepseek.com/zh-cn/guides/fim_completion/)
- [JSON Output](https://api-docs.deepseek.com/zh-cn/guides/json_mode/)
- [图像理解](https://api-docs.deepseek.com/zh-cn/guides/vision/)
- [Files API](https://api-docs.deepseek.com/zh-cn/guides/files_api/)
- [Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
- [Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)
- [限速与隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)

---

## 目录

- 快速开始
  - 首次调用 API
  - 模型 & 价格
  - 错误码
- API 指南
  - 思考模式
  - 多轮对话
  - 对话前缀续写（Beta）
  - FIM 补全（Beta）
  - JSON Output
  - Tool Calls
  - 网页搜索与抓取（Search / Fetch）
  - 图像理解与 Files API
  - Responses API
  - Anthropic API
  - 限速与隔离
  - 上下文硬盘缓存
- API 文档
  - 基本信息
  - 对话补全
  - FIM 补全（Beta）
  - 列出模型
  - 查询余额
- 常见问题
- 附录：派蒙自动搜索的接入与费用估算（设计与算例）

---

# 快速开始

## 首次调用 API

DeepSeek API 使用与 OpenAI/Anthropic 兼容的 API 格式，通过修改配置，您可以使用 OpenAI/Anthropic SDK 来访问 DeepSeek API，或使用与 OpenAI/Anthropic API 兼容的软件。

| 参数 | 值 |
|---|---|
| base_url（OpenAI） | `https://api.deepseek.com` |
| base_url（Anthropic） | `https://api.deepseek.com/anthropic` |
| api_key | 在 DeepSeek Platform 申请 API key |
| model | `deepseek-flash`、`deepseek-v4-pro` |

说明：推荐使用 `deepseek-flash`，当前对应 DeepSeek-V4.1-Flash-1017。`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 为兼容入口，请求也由新版 Flash 服务。不要把后端版本名称直接当作新的 model 参数。旧教程中的 `deepseek-chat` / `deepseek-reasoner` 不再作为推荐入口；V4 Pro 仍提供 API 服务。[首次调用](https://api-docs.deepseek.com/zh-cn/)

### 接入 Agent 工具

DeepSeek API 已接入多种主流 AI Agent 与编程助手工具。如果你使用 Claude Code、GitHub Copilot、OpenCode 等工具，可以直接将 DeepSeek 作为后端模型，无需编写代码即可开始使用。

### 调用对话 API

在创建 API key 之后，可以使用以下样例脚本，通过 OpenAI API 格式来访问 DeepSeek 模型。样例为非流式输出，可将 `stream` 设置为 `true` 使用流式输出。Anthropic API 格式的访问样例请参考「Anthropic API」。

#### curl

```bash
curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
        "model": "deepseek-flash",
        "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
        ],
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "stream": false
      }'
```

#### Python

```python
# Please install OpenAI SDK first: `pip3 install openai`
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY'),
    base_url="https://api.deepseek.com"
)

response = client.chat.completions.create(
    model="deepseek-flash",
    messages=[
        {"role": "system", "content": "You are a helpful assistant"},
        {"role": "user", "content": "Hello"},
    ],
    stream=False,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}}
)

print(response.choices[0].message.content)
```

#### Node.js

```javascript
// Please install OpenAI SDK first: `npm install openai`
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [{ role: "system", content: "You are a helpful assistant." }],
    model: "deepseek-flash",
    thinking: {"type": "enabled"},
    reasoning_effort: "high",
    stream: false,
  });

  console.log(completion.choices[0].message.content);
}

main();
```

---

## 模型 & 价格

下表所列模型价格以“百万 tokens”为单位。Token 是模型用来表示自然语言文本的最小单位，可以是一个词、一个数字或一个标点符号等。DeepSeek 将根据模型输入和输出的总 token 数进行计量计费。

### 模型细节

| 项目 | deepseek-flash | deepseek-v4-pro |
|---|---:|---:|
| BASE URL（OpenAI 格式） | `https://api.deepseek.com` | `https://api.deepseek.com` |
| BASE URL（Anthropic 格式） | `https://api.deepseek.com/anthropic` | `https://api.deepseek.com/anthropic` |
| 模型版本 | DeepSeek-V4.1-Flash-1017 | DeepSeek-V4-Pro-0813 |
| 思考模式 | 支持非思考与思考模式（默认） | 支持非思考与思考模式（默认） |
| 上下文长度 | 1M | 1M |
| 输出长度 | 最大 384K | 最大 384K |
| Json Output | 支持 | 支持 |
| Tool Calls | 支持 | 支持 |
| 对话前缀续写（Beta） | 支持 | 支持 |
| FIM 补全（Beta） | 仅非思考模式支持 | 仅非思考模式支持 |
| Responses / Anthropic API | 支持 | 支持 |
| 图像理解 | 支持 | 不支持 |
| 百万 tokens 输入（缓存命中，空闲 / 高峰） | 0.02 / 0.04 元 | 0.15 / 0.30 元 |
| 百万 tokens 输入（缓存未命中，空闲 / 高峰） | 1 / 2 元 | 4.5 / 9 元 |
| 百万 tokens 输出（空闲 / 高峰） | 4 / 8 元 | 13.5 / 27 元 |
| 并发限制 | 2500 | 500 |

备注：2026-10-17 Flash 模型升级，但上表 token 单价未变；模型名及兼容入口说明见“首次调用 API”。

价格快照来源：[官方中文价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)（核对日期见页首）。高峰为北京时间周一至周五、排除中国法定节假日的 9:00–12:00、14:00–18:00；其余时段，包括周末和中国法定节假日全天，按空闲价。不要把 token 峰谷折扣自动套用到 Search/Fetch。

### Search / Fetch 价格

Search 与 Fetch 分别为每 1,000 次成功请求 5 元，即每次 0.005 元；完整计费条件见下文“网页搜索与抓取”。模型读取搜索材料、生成回答的 token 另计。

2026-10-17 价格页与发布公告明确：DeepSeek Harness / Claude Code / Codex 中经服务端工具调用的 Search/Fetch 暂未计费，2026-11-01 00:00（北京时间）开始收费。搜索指南的索引仍写“具体开始计费时间另行通知”，本整理采用已有明确日期的价格页与公告。此优惠描述限定了调用场景，不能据此推断派蒙直接调用两个独立 API 也免费；预算按标准价计算。[发布公告](https://api-docs.deepseek.com/zh-cn/news/news261017/)

### 扣费规则

费用 = 模型各类 token 数 × 对应单价 + Search/Fetch 计费请求数 × 对应请求单价。费用从余额扣减，赠送余额优先于充值余额。

产品价格可能发生变动，DeepSeek 保留修改价格的权利。请依据实际用量按需充值，并定期查看价格页面以获知最新价格信息。

---

## 错误码

调用 DeepSeek API 时可能遇到以下错误：

| 错误码 | 描述 | 原因 | 解决方法 |
|---|---|---|---|
| 400 | 格式错误 | 请求体格式错误 | 根据错误信息提示修改请求体 |
| 401 | 认证失败 | API key 错误，认证失败 | 检查 API key 是否正确；如没有 API key，先创建 API key |
| 402 | 余额不足 | 账号余额不足 | 确认账户余额并充值 |
| 422 | 参数错误 | 请求体参数错误 | 根据错误信息提示修改相关参数 |
| 429 | 请求速率达到上限 | 请求速率（TPM 或 RPM）达到上限 | 合理规划请求速率 |
| 500 | 服务器故障 | 服务器内部故障 | 等待后重试；若问题持续存在，请联系 DeepSeek |
| 503 | 服务器繁忙 | 服务器负载过高 | 稍后重试请求 |

---

# API 指南

## 思考模式

DeepSeek 模型支持思考模式：在输出最终回答之前，模型会先输出一段思维链内容，以提升最终答案的准确性。

### 思考模式开关与思考强度控制

| 功能 | OpenAI 格式 | Anthropic 格式 |
|---|---|---|
| 思考模式开关 | `{"thinking": {"type": "enabled/disabled"}}` | - |
| 思考强度控制 | `{"reasoning_effort": "low/high/max"}` | `{"output_config": {"effort": "low/high/max"}}` |

说明：

- 默认思考开关为 `enabled`。
- 默认推理强度为 `high`，可显式指定 `low`、`high` 或 `max`。
- 兼容映射：`minimal` → `low`；`medium` / `xhigh` → `high`；`ultra` → `max`。`low` 已不再映射为 `high`。
- Responses 格式通过 `reasoning.effort` 控制，`none` 关闭思考。

OpenAI SDK 中设置 `thinking` 参数时，需要传入 `extra_body`：

```python
response = client.chat.completions.create(
  model="deepseek-flash",
  # ...
  reasoning_effort="high",
  extra_body={"thinking": {"type": "enabled"}}
)
```

### 输入输出参数

思考模式下 `temperature`、`presence_penalty`、`frequency_penalty` 不生效。`top_p` 须区分模型：Flash 仅在思考模式生效，范围 0.95–1.0，低值按 0.95；非思考模式固定 1.0。Pro 在非思考模式生效；思考模式忽略传入值，携带 tools 时固定 0.95，否则 1.0。官方 Chat/Responses 参数页仍有统一描述，与思考模式及 Responses 指南存在差异；本整理采用指南中明确区分模型的规则，Pro 使用前宜实测。[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)

在思考模式下，思维链内容通过 `reasoning_content` 参数返回，与 `content` 同级。后续轮次拼接中，可以选择性地返回 `reasoning_content` 给 API：

- 请求不携带 `tools`：无需回传历史 `reasoning_content`，回传也不会进入上下文。
- 请求携带 `tools`：应回传所有历史轮次的 `reasoning_content`，这些内容会进入上下文。判断依据是是否传入 `tools`，不只是本轮是否产生工具调用。

### 多轮对话拼接样例

```python
from openai import OpenAI
client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

messages = [{"role": "user", "content": "9.11 and 9.8, which is greater?"}]
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)

reasoning_content = response.choices[0].message.reasoning_content
content = response.choices[0].message.content

# The reasoning_content will be ignored by the API
messages.append(response.choices[0].message)
messages.append({'role': 'user', 'content': "How many Rs are there in the word 'strawberry'?"})
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages,
    reasoning_effort="high",
    extra_body={"thinking": {"type": "enabled"}},
)
```

流式样例中，需要从 `chunk.choices[0].delta.reasoning_content` 累积思维链内容，从 `chunk.choices[0].delta.content` 累积最终回答。

### 工具调用

DeepSeek 模型的思考模式支持工具调用功能。模型在输出最终答案之前，可以进行多轮思考与工具调用，以提升答案质量。

思考请求携带 `tools` 时，保留并回传历史 assistant 消息的 `reasoning_content`；使用完整响应 message 拼接历史可避免丢失。缺失必要上下文可能导致 400。

简化样例：

```python
import os
import json
from openai import OpenAI
from datetime import datetime

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_date",
            "description": "Get the current date",
            "parameters": { "type": "object", "properties": {} },
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather of a location, the user should supply the location and date.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": { "type": "string", "description": "The city name" },
                    "date": { "type": "string", "description": "The date in format YYYY-mm-dd" },
                },
                "required": ["location", "date"]
            },
        }
    },
]

def get_date_mock():
    return datetime.now().strftime("%Y-%m-%d")

def get_weather_mock(location, date):
    return "Cloudy 7~13°C"

TOOL_CALL_MAP = {
    "get_date": get_date_mock,
    "get_weather": get_weather_mock
}

def run_turn(turn, messages):
    sub_turn = 1
    while True:
        response = client.chat.completions.create(
            model='deepseek-flash',
            messages=messages,
            tools=tools,
            reasoning_effort="high",
            extra_body={ "thinking": { "type": "enabled" } },
        )
        messages.append(response.choices[0].message)
        reasoning_content = response.choices[0].message.reasoning_content
        content = response.choices[0].message.content
        tool_calls = response.choices[0].message.tool_calls
        if tool_calls is None:
            break
        for tool in tool_calls:
            tool_function = TOOL_CALL_MAP[tool.function.name]
            tool_result = tool_function(**json.loads(tool.function.arguments))
            messages.append({
                "role": "tool",
                "tool_call_id": tool.id,
                "content": tool_result,
            })
        sub_turn += 1

client = OpenAI(
    api_key=os.environ.get('DEEPSEEK_API_KEY'),
    base_url=os.environ.get('DEEPSEEK_BASE_URL'),
)

messages = [{"role": "user", "content": "How's the weather in Hangzhou Tomorrow"}]
run_turn(1, messages)
messages.append({"role": "user", "content": "How's the weather in Guangzhou Tomorrow"})
run_turn(2, messages)
```

---

## 多轮对话

DeepSeek `/chat/completions` API 是“无状态” API，服务端不记录用户请求上下文。用户每次请求时，需要将之前所有对话历史拼接好后，传递给对话 API。

Python 示例：

```python
from openai import OpenAI
client = OpenAI(api_key="<DeepSeek API Key>", base_url="https://api.deepseek.com")

# Round 1
messages = [{"role": "user", "content": "What's the highest mountain in the world?"}]
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages
)

messages.append(response.choices[0].message)
print(f"Messages Round 1: {messages}")

# Round 2
messages.append({"role": "user", "content": "What is the second?"})
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages
)

messages.append(response.choices[0].message)
print(f"Messages Round 2: {messages}")
```

第一轮请求传给 API 的 `messages`：

```json
[
  {"role": "user", "content": "What's the highest mountain in the world?"}
]
```

第二轮请求时：

1. 将第一轮中模型输出添加到 `messages` 末尾。
2. 将新的提问添加到 `messages` 末尾。

最终传递给 API：

```json
[
  {"role": "user", "content": "What's the highest mountain in the world?"},
  {"role": "assistant", "content": "The highest mountain in the world is Mount Everest."},
  {"role": "user", "content": "What is the second?"}
]
```

---

## 对话前缀续写（Beta）

对话前缀续写沿用 Chat Completion API，用户提供 assistant 开头的消息，让模型补全其余消息。

### 注意事项

1. 使用对话前缀续写时，用户需确保 `messages` 列表里最后一条消息的 `role` 为 `assistant`，并设置最后一条消息的 `prefix` 参数为 `True`。
2. 需要设置 `base_url="https://api.deepseek.com/beta"` 来开启 Beta 功能。

### 样例代码

该例中设置 `assistant` 开头消息为 `"```python\n"`，强制模型输出 Python 代码，并设置 `stop` 为 `['```']` 避免额外解释。

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com/beta",
)
messages = [
    {"role": "user", "content": "Please write quick sort code"},
    {"role": "assistant", "content": "```python\n", "prefix": True}
]
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages,
    stop=["```"],
)
print(response.choices[0].message.content)
```

---

## FIM 补全（Beta）

FIM（Fill In the Middle）补全中，用户可以提供前缀和后缀（可选），模型补全中间内容。FIM 常用于内容续写、代码补全等场景。

### 注意事项

1. 模型的最大补全长度为 4K。
2. 需要设置 `base_url="https://api.deepseek.com/beta"` 开启 Beta 功能。

### 样例代码

```python
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com/beta",
)

response = client.completions.create(
    model="deepseek-flash",
    prompt="def fib(a):",
    suffix="    return fib(a-1) + fib(a-2)",
    max_tokens=128
)
print(response.choices[0].text)
```

### 配置 Continue 代码补全插件

Continue 是支持代码补全的 VSCode 插件，可参考相关文档配置 Continue 以使用代码补全功能。

---

## JSON Output

很多场景下，需要让模型严格按照 JSON 格式输出，以实现输出结构化，便于后续逻辑解析。DeepSeek 提供 JSON Output 功能，确保模型输出合法 JSON 字符串。

### 注意事项

1. 设置 `response_format` 参数为 `{'type': 'json_object'}`。
2. system 或 user prompt 中必须含有 `json` 字样，并给出希望模型输出的 JSON 格式样例，以指导模型输出合法 JSON。
3. 需要合理设置 `max_tokens`，防止 JSON 字符串被中途截断。
4. 使用 JSON Output 功能时，API 有概率返回空的 content。DeepSeek 正在优化，可尝试修改 prompt 缓解。

### 样例代码

```python
import json
from openai import OpenAI

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com",
)

system_prompt = """
The user will provide some exam text. Please parse the "question" and "answer" and output them in JSON format.

EXAMPLE INPUT:
Which is the highest mountain in the world? Mount Everest.
EXAMPLE JSON OUTPUT:
{
    "question": "Which is the highest mountain in the world?",
    "answer": "Mount Everest"
}
"""

user_prompt = "Which is the longest river in the world? The Nile River."

messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": user_prompt}
]
response = client.chat.completions.create(
    model="deepseek-flash",
    messages=messages,
    response_format={
        'type': 'json_object'
    }
)

print(json.loads(response.choices[0].message.content))
```

模型将输出：

```json
{
  "question": "Which is the longest river in the world?",
  "answer": "The Nile River"
}
```

---

## Tool Calls

Tool Calls 让模型能够调用外部工具，增强自身能力。

### 非思考模式

以获取用户当前位置天气为例（当前默认启用思考，示例必须显式关闭）：

```python
from openai import OpenAI

def send_messages(messages):
    response = client.chat.completions.create(
        model="deepseek-flash",
        messages=messages,
        tools=tools,
        extra_body={"thinking": {"type": "disabled"}},
    )
    return response.choices[0].message

client = OpenAI(
    api_key="<your api key>",
    base_url="https://api.deepseek.com",
)

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get weather of a location, the user should supply a location first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city and state, e.g. San Francisco, CA",
                    }
                },
                "required": ["location"]
            },
        }
    },
]

messages = [{"role": "user", "content": "How's the weather in Hangzhou, Zhejiang?"}]
message = send_messages(messages)
print(f"User>\t {messages[0]['content']}")

tool = message.tool_calls[0]
messages.append(message)
messages.append({"role": "tool", "tool_call_id": tool.id, "content": "24℃"})
message = send_messages(messages)
print(f"Model>\t {message.content}")
```

流程：

1. 用户询问天气。
2. 模型返回 function `get_weather({location: 'Hangzhou'})`。
3. 用户调用 function `get_weather({location: 'Hangzhou'})`，并将结果传给模型。
4. 模型返回自然语言答案。

注：`get_weather` 函数功能需由用户提供，模型本身不执行具体函数。

### 思考模式

从 DeepSeek-V3.2 开始，API 支持思考模式下的工具调用能力，详见「思考模式」。

### 工具调用限制

Chat Completions 的 `tool_choice` 可为 none、auto、required 或指定 function；思考模式不支持 required 或指定工具，使用前需关闭思考。客户端执行工具并以 tool_call_id 关联结果。

Chat Completions 不支持向历史中间插入非模型生成的工具调用；这种用途请使用 Responses 或 Anthropic 格式。[工具指南](https://api-docs.deepseek.com/zh-cn/guides/tool_calls/)

### strict 模式（Beta）

在 `strict` 模式下，模型在输出 Function 调用时会严格遵循 Function 的 JSON Schema 格式要求，以确保模型输出的 Function 符合用户定义。在思考与非思考模式下的工具调用，均可使用 `strict` 模式。

使用要求：

1. 设置 `base_url="https://api.deepseek.com/beta"` 开启 Beta 功能。
2. `tools` 列表中所有 `function` 均需设置 `strict` 为 `true`。
3. 服务端会校验传入的 Function JSON Schema；若不符合规范或包含服务端不支持的 JSON Schema 类型，将返回错误信息。

工具定义样例：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "strict": true,
    "description": "Get weather of a location, the user should supply a location first.",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "The city and state, e.g. San Francisco, CA"
        }
      },
      "required": ["location"],
      "additionalProperties": false
    }
  }
}
```

#### strict 模式支持的 JSON Schema 类型

- object
- string
- number
- integer
- boolean
- array
- enum
- anyOf

#### object 类型

`object` 定义包含键值对的深层结构，其中 `properties` 定义对象中每个键的 schema。每个 `object` 的所有属性均需设置为 `required`，且 `additionalProperties` 必须为 `false`。

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "integer" }
  },
  "required": ["name", "age"],
  "additionalProperties": false
}
```

#### string 类型

支持参数：

- `pattern`：使用正则表达式约束字符串格式。
- `format`：使用预定义常见格式校验，目前支持 `email`、`hostname`、`ipv4`、`ipv6`、`uuid`。

不支持参数：

- `minLength`
- `maxLength`

```json
{
  "type": "object",
  "properties": {
    "user_email": {
      "type": "string",
      "description": "The user's email address",
      "format": "email"
    },
    "zip_code": {
      "type": "string",
      "description": "Six digit postal code",
      "pattern": "^\\d{6}$"
    }
  }
}
```

#### number/integer 类型

支持参数：`const`、`default`、`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`。

```json
{
  "type": "object",
  "properties": {
    "score": {
      "type": "integer",
      "description": "A number from 1-5, which represents your rating, the higher, the better",
      "minimum": 1,
      "maximum": 5
    }
  },
  "required": ["score"],
  "additionalProperties": false
}
```

#### array 类型

不支持参数：`minItems`、`maxItems`。

```json
{
  "type": "object",
  "properties": {
    "keywords": {
      "type": "array",
      "description": "Five keywords of the article, sorted by importance",
      "items": {
        "type": "string",
        "description": "A concise and accurate keyword or phrase."
      }
    }
  },
  "required": ["keywords"],
  "additionalProperties": false
}
```

#### enum

`enum` 可以确保输出是预期选项之一。

```json
{
  "type": "object",
  "properties": {
    "order_status": {
      "type": "string",
      "description": "Ordering status",
      "enum": ["pending", "processing", "shipped", "cancelled"]
    }
  }
}
```

#### anyOf

匹配多个 schema 中的任意一个。例如账户可以是邮箱或手机号：

```json
{
  "type": "object",
  "properties": {
    "account": {
      "anyOf": [
        { "type": "string", "format": "email", "description": "可以是电子邮件地址" },
        { "type": "string", "pattern": "^\\d{11}$", "description": "或11位手机号码" }
      ]
    }
  }
}
```

#### $ref 和 $def

可以使用 `$def` 定义模块，再用 `$ref` 引用，以减少模式重复和模块化；也可以单独使用 `$ref` 定义递归结构。

```json
{
  "type": "object",
  "properties": {
    "report_date": {
      "type": "string",
      "description": "The date when the report was published"
    },
    "authors": {
      "type": "array",
      "description": "The authors of the report",
      "items": {
        "$ref": "#/$def/author"
      }
    }
  },
  "required": ["report_date", "authors"],
  "additionalProperties": false,
  "$def": {
    "author": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "author's name"
        },
        "institution": {
          "type": "string",
          "description": "author's institution"
        },
        "email": {
          "type": "string",
          "format": "email",
          "description": "author's email"
        }
      },
      "additionalProperties": false,
      "required": ["name", "institution", "email"]
    }
  }
}
```

---

## 网页搜索与抓取（Search / Fetch）

这是独立 HTTP 接口，复用 DeepSeek API key，发送 `Authorization: Bearer <key>` 与 `Content-Type: application/json`。不会因为聊天模型支持工具就自动执行；应用需决定何时调用，再把结果提供给模型。

### Search

`POST https://api.deepseek.com/v1/tools/search`，下面是自编请求体示例，角色名及日期应由实际问题确定：

```json
{"query":"原神 角色名 配队 正式服 after:2026-10-01","count":5,"need_content":true}
```

| 字段 | 约束 / 用法 |
|---|---|
| query | 必填，1～128 个 Unicode 字符，不能全空白 |
| count | 1～50，默认 10；控制结果数 |
| ori_question | 可选，1～128 字符；null 等同未提供 |
| localization | 可选的本地化 IP，默认空字符串 |
| need_content | 默认 false；true 可请求正文，但正文仍可能缺失 |

结果位于 `results[]`：标题、URL、snippet、summary、content；另有 date（UTC RFC 3339 或 null）、rerank_score、authority 和站点信息。未知发布日期不能当作最新日期，排序和权威分数也不是事实正确性的保证。[Search 参数与响应](https://api-docs.deepseek.com/zh-cn/api/search/)

可在 query 中组合 `site:` / `-site:`、`lang:`、`after:` / `before:`、引号精确匹配、减号排除词。日期过滤表达的是网页发布时间限制，不直接证明攻略适用当前版本。请求中的未知字段会被忽略，不应自行发明 freshness 等参数。[搜索语法](https://api-docs.deepseek.com/zh-cn/guides/search/)

### Fetch

`POST https://api.deepseek.com/v1/tools/fetch`，请求体为 `{"url":"https://example.com/article"}`。单次读取一个 URL，地址须为带 host 的 HTTP(S)，不含账号密码，长度不超过 8192。响应为 `title` 与 Markdown `content`；标题缺失可为空。[Fetch 参数与响应](https://api-docs.deepseek.com/zh-cn/api/fetch/)

Search 已返回足够正文时不必再次 Fetch。需要页面详情而 content 缺失时才补抓；登录、站点拦截或无法提取正文均可能导致失败，不能保证任何攻略网页都能读取。

### 计费、限速与失败处理

- Search、Fetch 均为 0.005 元/计费请求，不按返回条数或网页长度收费；`count=5` 不是五次搜索。官方仅对 HTTP 200 且有有效结果的请求计费：Search 非空 results，Fetch 有正文。失败、空搜索和超时不计请求费；相关模型调用的 token 费用独立。
- Search 与 Fetch 各有账号级 5 QPS 限制，多个 key 共用；Fetch 另有目标域名限速，指南未给出统一数值。
- 408、429、5xx 可有限退避重试；402 需处理余额。403 是抓取安全拒绝，404 可表示页面不可用/无可提取内容，其他 4xx 不应原样循环重试。客户端丢失响应后重试可能形成多次成功请求，预算不要只按最终展示次数计。

以上接口规则来源：[搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)。临时免费范围与开始收费日期见前文“Search / Fetch 价格”。

## 上下文硬盘缓存

DeepSeek API 上下文硬盘缓存技术对所有用户默认开启，用户无需修改代码即可享用。

用户的每一个请求都会触发硬盘缓存的构建。若后续请求与之前请求在前缀上存在重复，则重复部分只需要从缓存中拉取，计入“缓存命中”。

### 缓存落盘与命中规则

缓存命中的前提是相应前缀已被“落盘”（写入硬盘缓存）。受 Sliding Window Attention 机制影响，缓存前缀的存取与判别与之前有所不同。每条缓存前缀是独立完整单元。后续请求只有完整匹配缓存前缀单元时，才能命中缓存。

#### 缓存前缀落盘时机

1. 请求结束位置落盘：每次请求的用户输入结束位置与模型输出结束位置，会产生两个缓存前缀单元。后续请求若完整匹配它们，则可命中。
2. 公共前缀检测落盘：当系统检测到多次请求之间存在公共前缀时，会将该公共前缀作为独立缓存前缀单元落盘。后续请求若完整复用该缓存前缀单元，则可命中。
3. 按固定 token 间隔落盘：在长输入或长输出中，系统会以一定 token 数量为间隔截取缓存前缀单元，避免长前缀迟迟未达到结束位置而完全无法被缓存。

举例：

- 第一轮请求内容为 `A + B`，第二轮请求内容为 `A + B + C`，第二轮能完整匹配 `A + B` 缓存前缀单元，因此可命中缓存。
- 第一轮请求为 `A + B`，第二轮为 `A + C`，第二轮无法命中缓存，因为 `A + C` 不能完整匹配第一轮的 `A + B`。但系统会识别两轮公共前缀 `A` 并落盘。第三轮请求 `A + D` 时可命中 `A` 的缓存。

### 例一：多轮对话

第一次请求：

```text
messages: [
  {"role": "system", "content": "你是一位乐于助人的助手"},
  {"role": "user", "content": "中国的首都是哪里？"}
]
```

第二次请求：

```text
messages: [
  {"role": "system", "content": "你是一位乐于助人的助手"},
  {"role": "user", "content": "中国的首都是哪里？"},
  {"role": "assistant", "content": "中国的首都是北京。"},
  {"role": "user", "content": "美国的首都是哪里？"}
]
```

第二次请求可以完整复用第一次请求的缓存前缀单元，这部分会计入“缓存命中”。

### 例二：长文本问答

第一次请求：

```text
messages: [
  {"role": "system", "content": "你是一位资深的财报分析师..."}
  {"role": "user", "content": "<财报内容>\n\n请总结一下这份财报的关键信息。"}
]
```

第二次请求：

```text
messages: [
  {"role": "system", "content": "你是一位资深的财报分析师..."}
  {"role": "user", "content": "<财报内容>\n\n请分析一下这份财报的盈利情况。"}
]
```

第三次请求：

```text
messages: [
  {"role": "system", "content": "你是一位资深的财报分析师..."}
  {"role": "user", "content": "<财报内容>\n\n请分析一下公司收入与支出占比。"}
]
```

前两次请求不会命中缓存。前两次请求完成后，系统识别出 `system` 消息 + `user` 消息中的 `<财报内容>` 为缓存前缀单元并落盘。第三次请求完整匹配前面落盘的缓存前缀单元，因此可命中缓存。

### 查看缓存命中情况

返回的 `usage` 字段中增加两个字段：

- `prompt_cache_hit_tokens`：本次请求输入中，缓存命中的 tokens 数。
- `prompt_cache_miss_tokens`：本次请求输入中，缓存未命中的 tokens 数。

### 硬盘缓存与输出随机性

硬盘缓存只匹配用户输入前缀部分，输出仍然通过计算推理得到，仍会受到 temperature 等参数影响。其输出效果与不使用硬盘缓存相同。

### 其它说明

1. 缓存系统是“尽力而为”，不保证 100% 缓存命中。
2. 缓存构建耗时为秒级。缓存不再使用后会自动清空，时间一般为几个小时到几天。

---

## 对话补全

```http
POST /chat/completions
```

根据输入上下文，让模型补全对话内容。

### Request

Content-Type: `application/json`

#### Body

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| messages | object[] | 是 | 对话消息列表，至少 1 条 |
| model | string | 是 | 模型 ID，可选 `deepseek-flash`、`deepseek-v4-pro` |
| thinking | object/null | 否 | 控制思考模式与非思考模式转换 |
| reasoning_effort | string | 否 | 推理强度，可选 `low`、`high`、`max` |
| max_tokens | integer/null | 否 | 限制一次请求中模型生成 completion 的最大 token 数 |
| response_format | object/null | 否 | 指定模型输出格式，`json_object` 可启用 JSON 模式 |
| stop | string 或 string[] | 否 | 遇到这些词时停止生成，最多 16 个 string |
| stream | boolean/null | 否 | 是否以 SSE 流式发送消息增量 |
| stream_options | object/null | 否 | 流式输出相关选项，仅 `stream=true` 时可设置 |
| temperature | number/null | 否 | 采样温度，0 到 2 |
| top_p | number/null | 否 | 行为区分 Flash / Pro，见下文及思考模式章节 |
| tools | object[]/null | 否 | 模型可调用的工具列表，当前仅支持 function，最多 128 个 |

#### messages 结构

`messages` 中每条消息可以是：

- System message
- User message
- Assistant message
- Tool message

System message：

- `content`：string，必填，system 消息内容。
- `role`：string，必填，值为 `system`。
- `name`：string，可选，参与者名称。

User message：

- `content`：string 或内容块数组，必填。数组可使用 text、image_url 或 file 块；见图像理解。
- `role`：string，必填，值为 `user`。
- `name`：string，可选。

Assistant message：

- `content`：string/null，必填，assistant 消息内容。
- `role`：string，必填，值为 `assistant`。
- `name`：string，可选。
- `prefix`：bool，Beta 参数，设置为 true 后强制模型以该 assistant 消息提供的前缀内容开始回答。必须设置 `base_url="https://api.deepseek.com/beta"`。
- `reasoning_content`：string/null，用于回传思考内容；携带 tools 的请求需保留历史轮次该字段。若用于 Beta 对话前缀续写的思维链输入，则需配合 `prefix: true`。

Tool message：

- `role`：string，必填，值为 `tool`。
- `content`：Text content，必填，tool 消息内容。
- `tool_call_id`：string，必填，此消息所响应的 tool call ID。

#### thinking

- `type`：string，可选值 `enabled`、`disabled`，默认 `enabled`。
- 如果为 `enabled`，使用思考模式；如果为 `disabled`，使用非思考模式。

#### reasoning_effort

可选值：`low`、`high`、`max`，默认 `high`。兼容映射见思考模式章节。

#### max_tokens

范围 1–393216。未指定时，非思考模式默认 8K；思考模式默认 64K，max 强度默认 128K。输入与生成内容合计仍受上下文窗口限制。

#### response_format

设置为：

```json
{ "type": "json_object" }
```

可启用 JSON 模式。使用 JSON 模式时，仍需通过 system 或 user 消息指示模型生成 JSON；否则模型可能生成不断的空白字符，直到达到令牌限制。如果 `finish_reason="length"`，说明生成超过了 `max_tokens` 或对话超过最大上下文长度，内容可能被截断。

#### stream_options.include_usage

无论是否设置，`data: [DONE]` 前最后一个块均携带整次请求的 usage。设为 true 时，中间块也有 usage，但为 null；否则中间块不含该字段。没有单独的纯 usage 块：最后一个块的 choices 含一个元素，无新增内容，finish_reason 非 null。stream_options 必须配合 stream=true，否则返回 400。本项目使用非流式，当前解析不受此差异影响。[Chat Completions 参数](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)

#### temperature

采样温度范围 0–2；思考模式忽略此参数。非思考模式可用它调节随机性。

#### top_p

Flash：思考模式有效范围 0.95–1.0，非思考模式固定 1.0。Pro：非思考模式生效，思考模式按是否携带 tools 固定取值。官方页面差异及来源见“思考模式 → 输入输出参数”。

---

## FIM 补全（Beta）API

```http
POST /completions
```

FIM（Fill-In-the-Middle）补全 API。需要设置 `base_url="https://api.deepseek.com/beta"` 使用。

### Request Body

| 字段 | 类型 | 说明 |
|---|---|---|
| model | string required | 使用 `deepseek-flash` 或 `deepseek-v4-pro`；FIM 仅支持非思考模式 |
| prompt | string required | 用于生成完成内容的提示，默认 `Once upon a time, ` |
| echo | boolean/null | 是否在输出中把 prompt 内容也输出出来 |
| logprobs | integer/null | 输出最可能 token 的对数概率，最大 20 |
| max_tokens | integer/null | 最大生成 token 数量 |
| stop | string 或 string[] | 遇到这些词时停止生成，最多 16 个 string |
| stream | boolean/null | 是否以 SSE 形式流式发送增量 |
| stream_options | object/null | 流式输出相关选项，仅 `stream=true` 时可设置 |
| suffix | string/null | 指定被补全内容的后缀 |
| temperature | number/null | 采样温度，0 到 2，默认 1 |
| top_p | number/null | nucleus sampling，0 到 1，默认 1 |
| frequency_penalty | deprecated | 已不再支持，传入不会产生效果 |
| presence_penalty | deprecated | 已不再支持，传入不会产生效果 |

### Responses

200 OK。

主要字段：

- `id`：补全响应 ID。
- `choices`：模型生成的补全内容选择列表。
  - `finish_reason`：模型停止生成 token 的原因，可为 `stop`、`length`、`content_filter`、`insufficient_system_resource`。
  - `index`：序号。
  - `logprobs`：对数概率信息。
  - `text`：生成文本。
- `created`：补全请求开始时间 Unix 时间戳。
- `model`：补全请求所用模型。
- `system_fingerprint`：模型运行时后端配置指纹。
- `object`：固定为 `text_completion`。
- `usage`：用量信息。
  - `completion_tokens`
  - `prompt_tokens`
  - `prompt_cache_hit_tokens`
  - `prompt_cache_miss_tokens`
  - `total_tokens`
  - `completion_tokens_details.reasoning_tokens`

示例响应：

```json
{
  "id": "string",
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "logprobs": {
        "text_offset": [0],
        "token_logprobs": [0],
        "tokens": ["string"],
        "top_logprobs": [{}]
      },
      "text": "string"
    }
  ],
  "created": 0,
  "model": "string",
  "system_fingerprint": "string",
  "object": "text_completion",
  "usage": {
    "completion_tokens": 0,
    "prompt_tokens": 0,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 0,
    "total_tokens": 0,
    "completion_tokens_details": {
      "reasoning_tokens": 0
    }
  }
}
```

---

## 列出模型

```http
GET /models
```

列出可用模型列表，并提供相关模型基本信息。当前支持模型请查看「模型 & 价格」。

### Responses

200 OK，返回模型列表。

Schema：

- `object`：string required，可能值 `list`。
- `data`：Model[] required。
  - `id`：模型标识符。
  - `object`：对象类型，值为 `model`。
  - `owned_by`：拥有该模型的组织。

示例：

```json
{
  "object": "list",
  "data": [
    {
      "id": "deepseek-flash",
      "object": "model",
      "owned_by": "deepseek"
    },
    {
      "id": "deepseek-v4-pro",
      "object": "model",
      "owned_by": "deepseek"
    }
  ]
}
```

---

## 查询余额

```http
GET /user/balance
```

查询账号余额。

### Responses

200 OK，返回用户余额详情。

Schema：

- `is_available`：boolean，当前账户是否有余额可供 API 调用。
- `balance_infos`：object[]。
  - `currency`：货币，可为 `CNY` 或 `USD`。
  - `total_balance`：总可用余额，包括赠金和充值余额。
  - `granted_balance`：未过期的赠金余额。
  - `topped_up_balance`：充值余额。

示例：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

---

## API 调用问题

### 为什么调用 API 时持续返回空行？

为了保持 TCP 连接不会因超时中断，DeepSeek 会在请求等待调度过程中持续返回空行（非流式请求）或 SSE keep-alive 注释（`: keep-alive`，流式请求）。自行解析 HTTP 响应时请注意处理这些空行或注释。

### 是否支持 LangChain？

支持。LangChain 支持 OpenAI API 接口，而 DeepSeek API 与 OpenAI 兼容。可下载 `deepseek_langchain.py` 并替换其中 API Key，在 LangChain 中调用 DeepSeek API。

---

## 图像理解与 Files API

Flash 支持图片输入；Pro 不支持。Chat Completions 的 user.content 可使用内容块数组：

```json
[
  {"type": "text", "text": "描述这张图片"},
  {"type": "image_url", "image_url": {"url": "https://example.com/image.jpg", "detail": "auto"}}
]
```

image_url.url 可用 HTTP(S) 地址或 base64 data URL。支持 JPEG、PNG、GIF、WebP；detail 可为 low、high、original、auto。也可改为 {"type":"file","file_id":"file-api-..."} 引用上传图片。file_data 与 file_id 互斥；文件接口目前用于图片，不应据此假设可读取任意 PDF。[图像指南](https://api-docs.deepseek.com/zh-cn/guides/vision/)

Files 操作：POST /files 上传（multipart/form-data，purpose=user_data）、GET /files 列表、GET /files/{file_id} 查询、DELETE /files/{file_id} 删除。单文件最大 64 MiB；可设 1 小时至 30 天过期时间，不设则永久有效。Anthropic 文件调用需额外请求头 anthropic-beta: files-api-2025-04-14。[Files 指南](https://api-docs.deepseek.com/zh-cn/guides/files_api/)

## Responses API

POST /responses，base URL 与 Chat Completions 相同。以下为自编最小示例：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["DEEPSEEK_API_KEY"],
    base_url="https://api.deepseek.com",
)
response = client.responses.create(
    model="deepseek-flash",
    instructions="请简洁回答。",
    input="你好",
    reasoning={"effort": "none"},
)
print(response.output_text)
```

仍为无状态接口：客户端需携带历史，不能依靠 previous_response_id、conversation 或 store 保存对话。流式以 response.completed / response.incomplete / response.failed 结束，没有 Chat Completions 的 [DONE]。不支持字段可能被忽略，应按兼容表接入。[Responses 指南](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)

Responses 的结构化输出使用 text.format，可为 text、json_object 或带 name/schema 的 json_schema。不要把这组参数直接搬到 Chat Completions 的 response_format。[Responses 参数](https://api-docs.deepseek.com/zh-cn/api/create-response/)

当前 Responses 指南明确：内置 `tools: [{"type":"web_search"}]` 仅 Pro 支持，Flash 下忽略；Pro 可由服务端搜索并继续生成。Flash 仍可由客户端调用独立 Search/Fetch，再把资料传入模型。这是两条不同的接入路径，不能把“Flash 支持 function 工具调用”理解为“Flash 支持 Responses 内置搜索”。[Responses 工具兼容表](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)

## Anthropic API

SDK base URL 为 https://api.deepseek.com/anthropic，使用 Anthropic 消息格式及 x-api-key 认证。system 位于请求顶层，max_tokens 为必填。支持图片与工具，具体兼容性见官方表；budget_tokens 被忽略，output_config 仅支持 effort。

claude-opus 前缀映射到 Pro，claude-haiku / claude-sonnet 前缀映射到 Flash；不支持的模型名会回退到 Flash。因此应显式使用 DeepSeek 模型名，避免误判实际服务模型。[Anthropic 指南](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)

## 限速与隔离

账号并发限制为 Flash 2500、Pro 500；同账号的多个 API key 共用限额。请求发出至响应完成计为一个并发，超限返回 429。

Chat Completions 可通过请求体 user_id 区分业务用户（Python SDK 放在 extra_body）；字符串须匹配 [a-zA-Z0-9_-]+，最长 512，不包含隐私信息。它影响内容安全、缓存与调度隔离，并不让普通账号的总并发配额变大。

等待推理期间，非流式可收到空行，流式可收到 keep-alive 注释；10 分钟仍未开始推理时服务器关闭连接。[限速与隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit/)

---

## 附录：派蒙自动搜索的接入与费用估算（2026-10-17，设计与算例）

同日后续进度：已按此方向完成本地联网首版，默认关闭，未部署或真实收费 API 验证。实际配置/限制见 [插件 README](../README.md) 与 [联网方案](KNOWLEDGE_WEB_SEARCH_PLAN.md)。下文保留实现前的分析与预算假设，不代表当前功能仍未实现，也不代表实际账单测量。

### 现状与兼容性

已核对本地 `plugins/paimon-plugin/lib/deepseek.js`、`paimon-runtime.js`、`knowledge-provider.js`、默认配置及实现方案：

- 每个被接纳的防抖批次，通常调用一次 Flash 聊天请求；发送多段 QQ 消息不会逐段调用模型。同一 session 串行。重试、会话结束记忆评估和开启后的主动补话另算。
- 默认 Chat Completions、thinking disabled、非流式、JSON Output，当前客户端不处理 tool_calls 循环。知识接口已接入，但仅返回空文本和空引用；没有联网搜索能力。
- 本次官方升级不要求修改现有请求协议，搜索也不会自行开启收费。但同一模型名背后的版本已变化，不能保证派蒙语气、沉默/补话判断与旧版完全一致。
- 本附录是接入设计与算例，没有改代码、调用付费 API、读取私人聊天日志、部署或重启；不是实际账单或线上效果验证。

### 建议采用的自动搜索流程

继续使用 Flash + 独立 Search/Fetch，保留最后一步原有 JSON 回复协议。无需仅为搜索改用 Pro/Responses。以下是建议流程，并非现有能力：

1. 保留原触发、白名单和防抖边界。模型结合最近必要上下文，先判断是否需要回应、是否涉及时效信息、角色/版本是否清楚，以及已有资料是否足够。沉默或“别说了”应在搜索前拦住，避免活跃群里旁人的每句讨论都触发联网。
2. 对“新角色怎么配队”“这个版本的深渊”“现在的卡池”等，自动生成查询；不要求用户说“搜一下”。角色名或所指版本不清楚时先澄清。不能只靠“最新”等关键词，也不能只相信模型自报知识新旧；应传当前日期并按时效类别、资料时间和缓存状态综合判断。
3. 先做 1 次 Search，取 5 条候选，可用 need_content=true；从中筛选 2～3 个相关来源。已有正文/摘要足够时不抓取，否则通常补 1～2 次 Fetch。资料冲突或缺失才允许第 2 次搜索，设置每题硬上限。
4. 按当前正式服版本核对角色技能、命座、武器与队友条件。官方资料适合核实机制/上线信息；配队结论还需可核查的实测与攻略依据，区分正式服、测试服猜测和旧版本。发布时间与正文适用版本都应检查。
5. 把筛选后的资料交给最后一次 Flash 请求，以派蒙口吻作答；保留来源、查询日期、适用版本以便核对，不把网络结论编成亲身经历。是否在 QQ 正文附简短来源可单独设计。失败时保留不确定性，不能把未经核实的旧知识包装成“刚查到”。

这类判断可以实现为短 JSON 规划请求，也可扩展原聊天协议，让模型先返回“需要搜索”动作，有资料后再完成最终回答。后者可以让普通闲聊仍保持一次模型调用，但需修改响应解析和执行流程，不能只加一条提示词或 YAML 开关。若让模型在 Search 后再挑 URL，则通常还会多一次模型调用；若代码按来源和相关性筛选，可维持“规划 + 最终回答”两次。

接入时应继续复用 session 串行、白名单/开关复查及回复节奏。knowledgeProvider 当前处在聊天 try 块之前，不能让搜索异常直接上抛破坏正常聊天；应在检索层捕获超时/失败并降级。搜索材料只作不可信资料，不能改写人设、输出协议或执行指令；查询仅发送必要主题，排除 QQ 号、密钥和私人记忆。记忆评估与主动补话默认不联网，也不把网页整篇塞入用户长期记忆。

### 单题如何算钱

费用包含两部分：工具请求费 + 模型所有调用的输入/输出 token 费。输入应包括人设、历史、工具定义、搜索材料等；同一材料在多轮模型请求中重复发送，也要按各轮实际 usage 累计。开启思考后还需计入推理输出，以下均按关闭思考。

设 S/F 为计费 Search/Fetch 次数，H/M 为所有模型请求累计的缓存命中/未命中输入 token，O 为输出 token。使用前文官方人民币单价：

```text
Flash 空闲费用（元） = 0.005 × (S + F) + (0.02 × H + 1 × M + 4 × O) / 1,000,000
Flash 高峰费用（元） = 0.005 × (S + F) + (0.04 × H + 2 × M + 8 × O) / 1,000,000
```

跨时段的请求应分别按实际适用价格相加。下列 token 数是预算假设，全部输入按未命中计算，没有把中文字数当作 token；不是对实际派蒙请求大小的测量，也不是费用上限。

| 场景 | Search / Fetch 次数 | 模型调用次数（假设） | 合计输入 / 输出 token | 工具费 | 空闲总价 | 高峰总价 |
|---|---:|---:|---:|---:|---:|---:|
| 轻量：搜索摘要/已有正文足够 | 1 / 0 | 2 | 4,000 / 400 | 0.005 元 | 0.0106 元 | 0.0162 元 |
| 标准：新角色配队，读两页核对 | 1 / 2 | 2 | 7,000 / 600 | 0.015 元 | 0.0244 元 | 0.0338 元 |
| 深入：补搜并交叉核对三页 | 2 / 3 | 3 | 15,000 / 900 | 0.025 元 | 0.0436 元 | 0.0622 元 |

标准场景拆解：规划 1,000 输入 + 100 输出；最终回答 6,000 输入 + 500 输出，其中假设 2,000 为原有上下文、4,000 为挑选后的联网资料。模型费为空闲 0.0094 元、高峰 0.0188 元，加 0.015 元工具费，共约 2.44～3.38 分/题。若材料已由 Search 返回且无需两次 Fetch，同样 token 假设下可少 0.01 元/题。

用于比较的普通回答基线假设为一次 2,000 输入 + 400 输出：空闲 0.0036 元、高峰 0.0072 元。因此标准联网题相对该基线新增约 0.0208～0.0266 元/题；这与“联网回答总价”不同。复杂长历史、多轮工具选择、重试、超长网页均可超过表格价格。

### 月用量场景

按 30 天、每道联网题采用上表标准场景、没有检索结果复用计算；区间两端分别假设模型调用全部处于空闲/高峰。混合时段费用按实际用量求和。

| 每天联网题数 | 月联网题数 | 月 Search / Fetch 次数 | 月模型调用次数 | 月总费用（这些联网题） | 相对上述普通回答基线新增 |
|---|---:|---:|---:|---:|---:|
| 10 | 300 | 300 / 600 | 600 | 7.32～10.14 元 | 6.24～7.98 元 |
| 50 | 1,500 | 1,500 / 3,000 | 3,000 | 36.60～50.70 元 | 31.20～39.90 元 |
| 100 | 3,000 | 3,000 / 6,000 | 6,000 | 73.20～101.40 元 | 62.40～79.80 元 |

例：全机器人每天 500 个被接纳的聊天批次，其中 10% 需要搜索，即 50 道联网题/天，而不是 500 次搜索。上述 36.60～50.70 元只覆盖联网题；其余闲聊、记忆评估、主动补话仍需另计。按比较基线替换原回答，搜索功能带来的月增量约 31.20～39.90 元。

如果实现为“所有聊天额外先做一次规划”，不搜索的批次也会增加模型费。按每次规划 1,000 输入 + 100 输出、500 批次/天、其中 450 不搜索计算，这 450 批次每月额外约 18.90～37.80 元；联网题的规划已包含在上表，不要重复加。推荐在原有一次请求内兼顾普通回答与搜索决策，或仅对合理候选启用额外规划，避免这一固定开销。

### 控制用量与上线后验证

- 建议常规每题 1 Search、0～2 Fetch，硬上限可设 2 Search、3 Fetch；工具请求费上限因此为 0.025 元/题，但总费用还需限制模型轮数和 token。每题总超时、每日预算、全账号限速与重试次数共同控制。
- 用“角色 + 正式服版本 + 问题类型”缓存公开资料，发布初期可先试 1～6 小时，新版本到来失效；追问“我没有某队友呢”优先复用已有机制/配队材料，再按个人条件生成回答。缓存共享公开资料，不共享用户私聊或私人记忆。缓存时间是工程建议，不是官方保证。
- 应用缓存能减少 Search/Fetch 次数；DeepSeek 输入缓存只能降低模型输入费用，不能免除工具费，也不能当作最新资料保证。每 1,000 次标准联网题，若 50% 可复用公开资料且完全跳过 1 Search + 2 Fetch，仅工具部分节省 7.50 元；最后回答仍产生 token 费，不能把整个账单简单减半。
- 对抓取内容限长、去重、只保留相关机制与条件；不要把整页导航评论和多篇重复攻略全传入。若额外增加模型摘要阶段，要把那次调用也计费。
- 以后接入时记录每题 S/F 的成功/空结果/错误、缓存命中、所有模型 usage、模型轮数及端到端延迟；按天统计“每百道联网题成本”和联网触发率。现有 token 日志可以复用，但尚未有 Search/Fetch 用量统计。浏览更多网页不保证回答更准，仍要检查来源时效与支持程度。

建议先以少量群测试“何时搜索、是否找到正式服资料、回答是否引用错误版本”，再根据真实用量调整预算。官方没有为这里的网络链路承诺固定延时；新增搜索、抓取与模型轮次会拉长等待，同 session 排队也可能增加。费用预算可先按标准场景的 2～4 分/题观察，复杂查询另设上限。
