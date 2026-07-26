import type { RunPrompt } from "./types"

export type QueuedItem = {
  id: string
  text: string
}

export function firstQueuedLine(text: string) {
  return (
    text
      .split(/\r?\n/)
      .map((value) => value.trim())
      .find(Boolean) ?? ""
  )
}

export function truncateQueueLine(text: string, maxLength = 72) {
  const line = firstQueuedLine(text)
  if (line.length <= maxLength) return line
  if (maxLength <= 1) return "…"
  return `${line.slice(0, maxLength - 1)}…`
}

export function runPromptPreview(prompt: RunPrompt) {
  const line = firstQueuedLine(prompt.text)
  if (line) return line
  if (prompt.parts.some((part) => part.type === "file" || part.type === "agent")) return "[attachment]"
  return ""
}
