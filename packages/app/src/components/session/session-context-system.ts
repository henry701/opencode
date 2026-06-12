import type { Message } from "@opencode-ai/sdk/v2/client"

export function getSessionSystemPrompt(messages: Message[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    const trimmed = msg.system_prompt?.trim()
    if (trimmed) return trimmed
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "user") continue
    const trimmed = msg.system?.trim()
    if (trimmed) return trimmed
  }
}
