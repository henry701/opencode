import type { SessionV1 } from "@opencode-ai/core/v1/session"

export function firstPreparedContextID(messages: readonly SessionV1.WithParts[]) {
  return messages.find(
    (message) =>
      message.info.role === "assistant" &&
      (message.info.system_prompt !== undefined || message.info.tool_defs !== undefined),
  )?.info.id
}

export function projectPreparedContext(
  messages: readonly SessionV1.WithParts[],
  firstPreparedID = firstPreparedContextID(messages),
) {
  if (firstPreparedID === undefined) return messages

  return messages.map((message) => {
    if (message.info.role !== "assistant" || message.info.id === firstPreparedID) return message
    const { system_prompt: _, tool_defs: __, ...info } = message.info
    return { ...message, info }
  })
}
