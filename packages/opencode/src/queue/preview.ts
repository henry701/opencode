import type { Part } from "@opencode-ai/sdk/v2"
import type { RunPrompt } from "@/cli/cmd/run/types"

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

/** Single-line preview for compact queue rows (ellipsis when truncated). */
export function truncateQueueLine(text: string, maxLength = 72) {
  const line = firstQueuedLine(text)
  if (line.length <= maxLength) return line
  if (maxLength <= 1) return "…"
  return `${line.slice(0, maxLength - 1)}…`
}

export function partsPreview(parts: Part[]) {
  const text = parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.synthetic)
    .map((part) => part.text)
    .join("\n")
  const line = firstQueuedLine(text)
  if (line) return line
  if (parts.some((part) => part.type === "file")) return "[attachment]"
  return ""
}

export function runPromptPreview(prompt: RunPrompt) {
  const line = firstQueuedLine(prompt.text)
  if (line) return line
  if (prompt.parts.some((part) => part.type === "file" || part.type === "agent")) return "[attachment]"
  return ""
}
