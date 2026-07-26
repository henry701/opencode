import type { SessionsQueueGetOutput } from "@opencode-ai/client"
import type { Part } from "@opencode-ai/sdk/v2"

export type QueuedItem = {
  id: string
  text: string
}

export function firstQueuedLine(text: string) {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean)
  if (line) return line
  return ""
}

export function truncateQueueLine(text: string, maxLength = 72) {
  const line = firstQueuedLine(text)
  if (line.length <= maxLength) return line
  if (maxLength <= 1) return "..."
  return `${line.slice(0, maxLength - 1)}...`
}

type QueuePart = Part | SessionsQueueGetOutput["payload"]["parts"][number]

export function partsPreview(parts: readonly QueuePart[]) {
  const text = parts
    .filter((part): part is Extract<QueuePart, { type: "text" }> => {
      return part.type === "text" && !part.synthetic
    })
    .map((part) => part.text)
    .join("\n")
  const line = firstQueuedLine(text)
  if (line) return line
  if (parts.some((part) => part.type === "file")) return "[attachment]"
  return ""
}

export function runPromptPreview(prompt: { text: string; parts: Part[] }) {
  const line = firstQueuedLine(prompt.text)
  if (line) return line
  if (prompt.parts.some((part) => part.type === "file")) return "[attachment]"
  return ""
}
