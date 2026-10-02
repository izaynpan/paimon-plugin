import test from "node:test"
import assert from "node:assert/strict"
import { DeepSeekClient, DeepSeekError, parseJsonContent } from "../lib/deepseek.js"

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

function config(overrides = {}) {
  return {
    deepseek: {
      apiKey: "secret-key",
      baseUrl: "https://api.deepseek.com/",
      model: "deepseek-flash",
      timeoutMs: 100,
      maxTokens: 1200,
      temperature: 0.8,
      maxRetries: 1,
      retryDelayMs: 0,
      thinking: { type: "disabled" },
      ...overrides,
    },
  }
}

test("发送非流式 flash JSON 请求并解析响应", async () => {
  let captured
  const client = new DeepSeekClient({
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) }
      return response(200, {
        choices: [{ message: { content: '{"reply":"你好","emotion":"happy"}' } }],
        usage: { total_tokens: 10 },
      })
    },
  })
  const result = await client.complete({
    messages: [{ role: "user", content: "你好" }],
    json: true,
    config: config(),
  })
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions")
  assert.equal(captured.options.headers.Authorization, "Bearer secret-key")
  assert.equal(captured.body.model, "deepseek-flash")
  assert.equal(captured.body.stream, false)
  assert.deepEqual(captured.body.thinking, { type: "disabled" })
  assert.deepEqual(captured.body.response_format, { type: "json_object" })
  assert.equal(captured.body.temperature, 0.8)
  assert.equal(result.data.reply, "你好")
})

test("429 只按配置有限重试", async () => {
  let calls = 0
  const client = new DeepSeekClient({
    fetchImpl: async () => {
      calls++
      if (calls === 1) return response(429, { error: { message: "slow down" } })
      return response(200, { choices: [{ message: { content: '{"ok":true}' } }] })
    },
    sleep: async () => {},
  })
  const result = await client.complete({
    messages: [{ role: "user", content: "x" }],
    json: true,
    config: config(),
  })
  assert.equal(calls, 2)
  assert.equal(result.data.ok, true)
})

test("401 不重试并标记为静默错误", async () => {
  let calls = 0
  const client = new DeepSeekClient({
    fetchImpl: async () => {
      calls++
      return response(401, { error: { message: "bad key" } })
    },
  })
  await assert.rejects(
    client.complete({
      messages: [{ role: "user", content: "x" }],
      config: config(),
    }),
    error => error instanceof DeepSeekError && error.status === 401 && error.silent,
  )
  assert.equal(calls, 1)
})

test("JSON 代码围栏可兼容，非法 JSON 明确报错", () => {
  const fence = String.fromCharCode(96).repeat(3)
  assert.deepEqual(parseJsonContent(fence + 'json\n{"x":1}\n' + fence), { x: 1 })
  assert.throws(
    () => parseJsonContent("not json"),
    error => error instanceof DeepSeekError && error.code === "invalid_json",
  )
})
