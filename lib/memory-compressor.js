function clip(text, max) {
  const value = String(text || "")
  return value.length > max ? value.slice(0, max) + "…" : value
}

function sessionTranscript(session, maxMessages, maxChars) {
  const lines = []
  let count = 0
  for (const batch of session.sessionBatches || []) {
    for (const message of batch.messages || []) {
      if (count++ >= maxMessages) break
      lines.push("[" + message.displayName + " | " + message.userId + "] " + message.text)
    }
    if (count++ < maxMessages && batch.reply) lines.push("[机器人] " + batch.reply)
    if (count >= maxMessages) break
  }
  return clip(lines.join("\n"), maxChars)
}

export function buildMemoryEvaluationMessages({ session, memories, config }) {
  const memoryConfig = config.memory || {}
  const participants = Object.values(session.participants || {}).map(participant => ({
    userId: participant.userId,
    displayName: participant.displayName,
    oldMemory: memories[participant.userId]?.memory || "",
  }))
  const transcript = sessionTranscript(
    session,
    memoryConfig.maxSessionMessagesForEvaluation || 100,
    memoryConfig.maxSessionCharsForEvaluation || 12000,
  )
  const system = [
    "你负责评估一次 QQ 对话 session 是否包含值得长期记住的用户信息。",
    "只保存与具体用户明确相关、对未来对话有帮助的信息，例如稳定偏好、长期项目、称呼或明确要求记住的约定。",
    "不要保存短期闲聊、猜测、敏感凭据、群体信息或无法归属到具体用户的信息。",
    "输出必须是合法 JSON，不要使用 Markdown 代码围栏。",
    '固定格式：{"version":1,"sessionSummary":"摘要","userMemoryUpdates":[{"userId":"123","shouldUpdateMemory":true,"updateReason":"理由","newMemory":"合并旧记忆后的完整长期记忆"}]}',
    "不需要更新时 shouldUpdateMemory 为 false 且 newMemory 为 null。",
    "只能返回本次参与用户；newMemory 必须是合并旧记忆后的完整文本，而不是增量补丁。",
  ].join("\n")
  const user = JSON.stringify(
    {
      scene: session.scene,
      groupId: session.groupId,
      participants,
      transcript,
    },
    null,
    2,
  )
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ]
}

export function validateMemoryEvaluation(value, participantIds) {
  if (!value || typeof value !== "object" || !Array.isArray(value.userMemoryUpdates))
    throw new TypeError("记忆评估响应结构无效")
  const allowed = new Set(participantIds.map(String))
  const seen = new Set()
  const updates = []
  for (const item of value.userMemoryUpdates) {
    const userId = String(item?.userId || "")
    if (!allowed.has(userId) || seen.has(userId) || typeof item.shouldUpdateMemory !== "boolean")
      continue
    seen.add(userId)
    if (item.shouldUpdateMemory && (typeof item.newMemory !== "string" || !item.newMemory.trim()))
      continue
    updates.push({
      userId,
      shouldUpdateMemory: item.shouldUpdateMemory,
      updateReason: typeof item.updateReason === "string" ? item.updateReason : "",
      newMemory: item.shouldUpdateMemory ? item.newMemory.trim() : null,
    })
  }
  return {
    version: 1,
    sessionSummary: typeof value.sessionSummary === "string" ? value.sessionSummary : "",
    userMemoryUpdates: updates,
  }
}

export async function evaluateSessionMemory({
  session,
  config,
  client,
  memoryStore,
  logger,
  modelLogger,
}) {
  const memoryConfig = config.memory || {}
  if (!memoryConfig.enabled || !memoryConfig.userMemoryEnabled)
    return { skipped: true, reason: "disabled" }

  const participantIds = Object.keys(session.participants || {})
  const memories = await memoryStore.readMany(session.participants)
  let rawContent = ""
  try {
    const response = await client.complete({
      messages: buildMemoryEvaluationMessages({ session, memories, config }),
      json: true,
      model: memoryConfig.evaluationModel || "deepseek-v4-flash",
      maxTokens: memoryConfig.evaluationMaxTokens || 1600,
      temperature: memoryConfig.evaluationTemperature ?? 0.2,
      config,
      trace: {
        type: "memory_evaluation",
        sessionId: session.id,
        sessionKey: session.sessionKey,
        scene: session.scene,
        groupId: session.groupId,
        participantIds,
      },
    })
    rawContent = response.content
    const evaluation = validateMemoryEvaluation(response.data, participantIds)
    await memoryStore.applySessionEvaluation({
      session,
      updates: evaluation.userMemoryUpdates,
      evaluationAttempted: true,
      maxMemoryChars: memoryConfig.maxStoredMemoryChars || 8000,
    })
    await modelLogger?.write?.(
      "memory_applied",
      {
        type: "memory_evaluation",
        sessionId: session.id,
        sessionKey: session.sessionKey,
        sessionSummary: evaluation.sessionSummary,
        updates: evaluation.userMemoryUpdates,
      },
      config,
    )
    return { skipped: false, evaluation }
  } catch (error) {
    logger?.("error", "session 记忆评估失败", error)
    if (config.runtime?.saveFailedMemoryEvaluations !== false)
      await memoryStore
        .saveFailedEvaluation(
          session,
          error,
          {
            rawContent: clip(rawContent, 20000),
            participantMemories: memories,
          },
          config.runtime?.maxFailedMemoryEvaluationFiles || 20,
        )
        .catch(saveError => logger?.("error", "保存失败记忆评估材料时出错", saveError))
    await memoryStore.applySessionEvaluation({
      session,
      updates: [],
      evaluationAttempted: true,
      maxMemoryChars: memoryConfig.maxStoredMemoryChars || 8000,
    })
    await modelLogger?.write?.(
      "memory_failed",
      {
        type: "memory_evaluation",
        sessionId: session.id,
        sessionKey: session.sessionKey,
        error: {
          name: error?.name || "Error",
          message: String(error?.message || error),
          code: error?.code || "",
          status: Number(error?.status) || 0,
        },
      },
      config,
    )
    return { skipped: false, error }
  }
}
