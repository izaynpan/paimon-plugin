import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DeepSeekClient } from "../lib/deepseek.js"
import { ModelLogger } from "../lib/model-logger.js"

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paimon-model-log-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test("JSONL 日志记录请求、响应并脱敏凭据", async t => {
  const root = await makeRoot(t)
  const logger = new ModelLogger({ root })
  const config = {
    logging: {
      enabled: true,
      file: "data/logs/deepseek.jsonl",
      includePrompt: true,
      includeResponse: true,
      includeUsage: true,
      maxBytes: 1024 * 1024,
      maxFiles: 3,
    },
  }
  await logger.write(
    "model_request",
    {
      requestId: "r1",
      request: {
        apiKey: "secret",
        authorization: "Bearer secret",
        messages: [{ role: "user", content: "你好" }],
      },
    },
    config,
  )
  await logger.write(
    "model_response",
    {
      requestId: "r1",
      response: {
        content: "回复",
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    },
    config,
  )
  const file = path.join(root, "data", "logs", "deepseek.jsonl")
  const entries = (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].request.apiKey, "[REDACTED]")
  assert.equal(entries[0].request.authorization, "[REDACTED]")
  assert.equal(entries[0].request.messages[0].content, "你好")
  assert.equal(entries[1].response.content, "回复")
  assert.equal(entries[1].response.usage.prompt_tokens, 10)
  assert.doesNotMatch(JSON.stringify(entries), /Bearer secret/)
})

test("可关闭 prompt 与回复正文记录", async t => {
  const root = await makeRoot(t)
  const logger = new ModelLogger({ root })
  const config = {
    logging: {
      enabled: true,
      file: "data/logs/private.jsonl",
      includePrompt: false,
      includeResponse: false,
      includeUsage: false,
    },
  }
  await logger.write(
    "model_request",
    { request: { messages: [{ role: "user", content: "敏感内容" }] } },
    config,
  )
  await logger.write(
    "reply_sent",
    { reply: "敏感回复", segments: ["敏感回复"], emotion: "neutral" },
    config,
  )
  const lines = (await fs.readFile(path.join(root, "data", "logs", "private.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
  assert.equal(lines[0].request.messages[0].content, "[OMITTED]")
  assert.equal("reply" in lines[1], false)
  assert.equal("segments" in lines[1], false)
})

test("DeepSeek 客户端产生请求与响应追踪事件", async () => {
  const entries = []
  const modelLogger = {
    write: async (event, data) => entries.push({ event, data }),
  }
  const client = new DeepSeekClient({
    modelLogger,
    fetchImpl: async () =>
      response(200, {
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"reply":"好呀","emotion":"happy"}' },
          },
        ],
        usage: { total_tokens: 8 },
      }),
  })
  await client.complete({
    messages: [{ role: "user", content: "测试" }],
    json: true,
    trace: { type: "chat", sessionId: "s1" },
    config: {
      deepseek: {
        apiKey: "secret",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        timeoutMs: 100,
        maxRetries: 0,
        thinking: { type: "disabled" },
      },
      logging: { enabled: true },
    },
  })
  assert.deepEqual(entries.map(item => item.event), ["model_request", "model_response"])
  assert.equal(entries[0].data.trace.sessionId, "s1")
  assert.equal(entries[1].data.response.finishReason, "stop")
  assert.equal(JSON.stringify(entries).includes("secret"), false)
})
test("日志达到上限后按文件数轮转", async t => {
  const root = await makeRoot(t)
  const logger = new ModelLogger({ root })
  const config = {
    logging: {
      enabled: true,
      file: "data/logs/rotate.jsonl",
      includeResponse: true,
      maxBytes: 1024,
      maxFiles: 2,
    },
  }
  for (let index = 0; index < 3; index++)
    await logger.write(
      "model_response",
      {
        requestId: "r" + index,
        response: { content: "x".repeat(800) },
      },
      config,
    )
  const files = (await fs.readdir(path.join(root, "data", "logs"))).sort()
  assert.deepEqual(files, ["rotate.jsonl", "rotate.jsonl.1"])
})
test("非法 JSON 错误日志保留模型原始回复", async () => {
  const entries = []
  const client = new DeepSeekClient({
    modelLogger: {
      write: async (event, data) => entries.push({ event, data }),
    },
    fetchImpl: async () =>
      response(200, {
        choices: [{ finish_reason: "stop", message: { content: "not-json" } }],
        usage: { total_tokens: 5 },
      }),
  })
  await assert.rejects(
    client.complete({
      messages: [{ role: "user", content: "测试" }],
      json: true,
      config: {
        deepseek: {
          apiKey: "secret",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-flash",
          timeoutMs: 100,
          maxRetries: 0,
          thinking: { type: "disabled" },
        },
        logging: { enabled: true },
      },
    }),
  )
  assert.deepEqual(entries.map(item => item.event), ["model_request", "model_error"])
  assert.equal(entries[1].data.error.responseContent, "not-json")
  assert.equal(entries[1].data.error.usage.total_tokens, 5)
})
