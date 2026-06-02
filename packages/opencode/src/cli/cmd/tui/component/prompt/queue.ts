import type { Part } from "@opencode-ai/sdk/v2"
import type { QueuedItem } from "@/queue/preview"
import type { PromptInfo } from "./history"
import { strip } from "./part"

export type DeferredQueueInput = {
  pending?: QueuedItem[]
}

/** Server-backed queue previews (from `session.queue.updated`). */
export function listDeferredQueued(input: DeferredQueueInput) {
  return input.pending ?? []
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
