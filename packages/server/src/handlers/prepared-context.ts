import { SessionMessage } from "@opencode-ai/core/session/message"

const isPreparedAssistant = (message: SessionMessage.Message): message is SessionMessage.Assistant =>
  message.type === "assistant" && (message.systemPrompt !== undefined || message.toolDefinitions !== undefined)

export const firstPreparedMessageID = (messages: readonly SessionMessage.Message[]) =>
  messages.find(isPreparedAssistant)?.id

export const stripRepeatedPreparedContext = (
  message: SessionMessage.Message,
  firstPreparedID: SessionMessage.ID | undefined,
): SessionMessage.Message => {
  if (firstPreparedID === undefined || !isPreparedAssistant(message) || message.id === firstPreparedID) return message
  const { systemPrompt: _, toolDefinitions: __, ...rest } = message
  return rest
}
