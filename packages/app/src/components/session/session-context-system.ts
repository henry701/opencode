import type { SessionMessage } from "@opencode-ai/schema/session-message"

type Revert = {
  messageID: string
  partID?: string
}

type PreparedContextInput = {
  messageID?: string
  revert?: Revert
}

export function selectSessionContextMessages(messages: readonly SessionMessage.Message[], revert?: Revert) {
  if (!revert) return messages
  return messages.filter((message) => {
    if (message.id < revert.messageID) return true
    return message.id === revert.messageID && revert.partID !== undefined
  })
}

export function getSessionPreparedContext(
  messages: readonly SessionMessage.Message[],
  input: PreparedContextInput = {},
) {
  const active = selectSessionContextMessages(messages, input.revert)
  const selected = input.messageID ? active.find((message) => message.id === input.messageID) : undefined
  const assistant =
    selected?.type === "assistant"
      ? selected
      : active.findLast(
          (message): message is SessionMessage.Assistant =>
            message.type === "assistant" &&
            Boolean(message.systemPrompt?.trim() || message.toolDefinitions?.trim()),
        )
  const systemPrompt = assistant?.systemPrompt?.trim()
  if (systemPrompt) return { systemPrompt, toolDefinitions: assistant?.toolDefinitions }

  const userSystem = active.findLast(
    (message): message is SessionMessage.User => message.type === "user" && Boolean(message.payload?.system?.trim()),
  )
  return {
    systemPrompt: userSystem?.payload?.system?.trim(),
    toolDefinitions: assistant?.toolDefinitions,
  }
}

export function getSessionSystemPrompt(messages: readonly SessionMessage.Message[]) {
  return getSessionPreparedContext(messages).systemPrompt
}
