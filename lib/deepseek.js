const retryableStatuses = new Set([429, 500, 503])
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

export class DeepSeekError extends Error {
  constructor(message, { status = 0, code = "deepseek_error", retryable = false, silent = false, cause } = {}) {
    super(message, { cause })
    this.name = "DeepSeekError"
    this.status = status
    this.code = code
    this.retryable = retryable
    this.silent = silent
  }
}

function parseJsonContent(content) {
  let value = String(content || "").trim()
  const fence = String.fromCharCode(96).repeat(3)
  if (value.startsWith(fence)) {
    value = value.replace(new RegExp("^" + fence + "(?:json)?\\s*", "i"), "")
    value = value.replace(new RegExp("\\s*" + fence + "$"), "")
  }
  if (!value) throw new DeepSeekError("DeepSeek 返回了空内容", { code: "empty_content", retryable: true })
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new DeepSeekError("DeepSeek 返回的 JSON 无法解析", {
      code: "invalid_json",
      retryable: false,
      cause,
    })
  }
}

function statusError(status, body) {
  const apiMessage = body?.error?.message || body?.message || "HTTP " + status
  const error = new DeepSeekError("DeepSeek API 请求失败：" + apiMessage, {
    status,
    code: "http_" + status,
    retryable: retryableStatuses.has(status),
    silent: status === 401 || status === 402,
  })
  error.responseData = body
  return error
}

export class DeepSeekClient {
  constructor({ getConfig, fetchImpl = globalThis.fetch, sleep = wait, logger, modelLogger } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("当前 Node.js 环境不支持 fetch")
    this.getConfig = getConfig
    this.fetch = fetchImpl
    this.sleep = sleep
    this.logger = logger
    this.modelLogger = modelLogger
  }

  async complete({
    messages,
    json = false,
    model,
    maxTokens,
    temperature,
    config: suppliedConfig,
    trace,
  }) {
    const allConfig = suppliedConfig || (await this.getConfig?.())
    const config = allConfig?.deepseek || allConfig || {}
    const apiKey = String(config.apiKey || "").trim()
    if (!apiKey)
      throw new DeepSeekError("未配置 DeepSeek API key", {
        code: "missing_api_key",
        silent: true,
      })

    const thinking = config.thinking || { type: "disabled" }
    const payload = {
      model: model || config.model || "deepseek-flash",
      messages,
      thinking,
      max_tokens: maxTokens ?? config.maxTokens ?? 1200,
      stream: false,
    }
    if (thinking.type === "disabled")
      payload.temperature = temperature ?? config.temperature ?? 0.8
    if (json) payload.response_format = { type: "json_object" }

    const requestId =
      trace?.requestId || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
    const requestType = trace?.type || "chat"
    const startedAt = Date.now()
    await this.modelLogger?.write?.(
      "model_request",
      {
        requestId,
        type: requestType,
        trace,
        request: payload,
      },
      allConfig,
    )

    const retries = Math.max(0, Number(config.maxRetries) || 0)
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await this.request(payload, config, json)
        await this.modelLogger?.write?.(
          "model_response",
          {
            requestId,
            type: requestType,
            trace,
            durationMs: Date.now() - startedAt,
            attempt: attempt + 1,
            response: {
              content: result.content,
              data: result.data,
              usage: result.usage,
              finishReason: result.raw?.choices?.[0]?.finish_reason || "",
            },
          },
          allConfig,
        )
        return result
      } catch (error) {
        lastError =
          error instanceof DeepSeekError
            ? error
            : new DeepSeekError("DeepSeek 网络请求失败", {
                code: "network_error",
                retryable: true,
                cause: error,
              })
        const finalAttempt = !lastError.retryable || attempt >= retries
        await this.modelLogger?.write?.(
          finalAttempt ? "model_error" : "model_retry",
          {
            requestId,
            type: requestType,
            trace,
            durationMs: Date.now() - startedAt,
            attempt: attempt + 1,
            error: {
              name: lastError.name,
              message: lastError.message,
              code: lastError.code,
              status: lastError.status,
              retryable: lastError.retryable,
              responseContent: lastError.responseContent || "",
              responseData: lastError.responseData || null,
              usage: lastError.usage || null,
              finishReason: lastError.finishReason || "",
            },
          },
          allConfig,
        )
        if (finalAttempt) throw lastError
        const delay = Math.max(0, Number(config.retryDelayMs) || 800) * (attempt + 1)
        this.logger?.("warn", "DeepSeek 请求失败，准备重试", {
          code: lastError.code,
          status: lastError.status,
          attempt: attempt + 1,
        })
        await this.sleep(delay)
      }
    }
    throw lastError
  }

  async request(payload, config, jsonMode) {
    const controller = new AbortController()
    const timeoutMs = Math.max(1, Number(config.timeoutMs) || 60000)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const endpoint = String(config.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "") +
        "/chat/completions"
      let response
      try {
        response = await this.fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + config.apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
      } catch (cause) {
        if (cause?.name === "AbortError")
          throw new DeepSeekError("DeepSeek 请求超时", {
            code: "timeout",
            retryable: true,
            cause,
          })
        throw cause
      }

      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        body = { message: text.slice(0, 500) }
      }
      if (!response.ok) throw statusError(response.status, body)
      const content = body?.choices?.[0]?.message?.content
      if (typeof content !== "string")
        throw new DeepSeekError("DeepSeek 响应缺少 choices[0].message.content", {
          code: "malformed_response",
          retryable: false,
        })
      let data
      try {
        data = jsonMode ? parseJsonContent(content) : content
      } catch (error) {
        error.responseContent = content
        error.usage = body.usage || null
        error.finishReason = body?.choices?.[0]?.finish_reason || ""
        throw error
      }
      return {
        content,
        data,
        usage: body.usage || null,
        raw: body,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export { parseJsonContent }
