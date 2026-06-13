import type { Part, QueueItemDetail } from "@opencode-ai/sdk/v2"
import type { QueuedItem } from "../../queue/preview"
import type { PromptInfo } from "./history"
import { stripPromptPartIDs } from "../../prompt/part"

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

type QueuePart = Part | QueueItemDetail["parts"][number]

function stripQueuePart(part: QueuePart): PromptInfo["parts"][number] | undefined {
  if (part.type !== "file") return undefined
  if ("id" in part && "messageID" in part && "sessionID" in part) return stripPromptPartIDs(part)
  return part
}

export function partsToPromptInfo(parts: QueuePart[]): PromptInfo {
  return parts.reduce(
    (agg, part) => {
      if (part.type === "text") {
        if (!part.synthetic) agg.input += part.text
      }
      if (part.type === "file") {
        const stripped = stripQueuePart(part)
        if (stripped) agg.parts.push(stripped)
      }
      return agg
    },
    { input: "", parts: [] as PromptInfo["parts"] },
  )
}
