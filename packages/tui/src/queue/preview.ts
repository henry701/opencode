import type { Part, QueueItemDetail } from "@opencode-ai/sdk/v2"

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

export function partsPreview(parts: Part[] | QueueItemDetail["parts"]) {
  const text = parts
    .filter((part): part is Extract<(Part | QueueItemDetail["parts"][number]), { type: "text" }> => {
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
