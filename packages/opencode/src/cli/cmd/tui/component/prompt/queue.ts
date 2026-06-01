import type { Message, Part } from "@opencode-ai/sdk/v2"
import type { QueuedItem } from "@/queue/preview"
import { partsPreview } from "@/queue/preview"
import type { PromptInfo } from "./history"
import { strip } from "./part"

export type DeferredQueueInput = {
  messages: Message[]
  parts: Record<string, Part[] | undefined>
  pendingAssistantID?: string
}

export function listDeferredQueued(input: DeferredQueueInput) {
  if (!input.pendingAssistantID) return [] as QueuedItem[]

  const pending = input.messages.find((message) => message.id === input.pendingAssistantID)
  if (!pending || pending.role !== "assistant" || !pending.parentID) return [] as QueuedItem[]

  const openUserID = pending.parentID

  const items: QueuedItem[] = []
  for (const message of input.messages) {
    if (message.role !== "user") continue
    if (message.delivery !== "deferred") continue
    if (message.id <= openUserID) continue
    const answer = input.messages.findLast(
      (entry): entry is Extract<Message, { role: "assistant" }> =>
        entry.role === "assistant" && entry.parentID === message.id,
    )
    if (answer?.finish && !["tool-calls", "unknown"].includes(answer.finish)) continue

    const preview = partsPreview(input.parts[message.id] ?? [])
    if (!preview) continue
    items.push({ id: message.id, text: preview })
  }

  return items
}

export function pendingDeferredMessageIds(input: DeferredQueueInput) {
  return new Set(listDeferredQueued(input).map((item) => item.id))
}

export function partsToPromptInfo(parts: Part[]): PromptInfo {
  return parts.reduce(
    (agg, part) => {
      if (part.type === "text") {
        if (!part.synthetic) agg.input += part.text
      }
      if (part.type === "file") agg.parts.push(strip(part))
      return agg
    },
    { input: "", parts: [] as PromptInfo["parts"] },
  )
}
