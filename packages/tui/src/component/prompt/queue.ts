import type { SessionsQueueGetOutput } from "@opencode-ai/client"
import type { Part } from "@opencode-ai/sdk/v2"
import type { QueuedItem } from "../../queue/preview"
import type { PromptInfo } from "./history"
import { stripPromptPartIDs } from "../../prompt/part"

export type DeferredQueueInput = {
  pending?: QueuedItem[]
}

/** Server-backed queue previews refreshed from durable prompt lifecycle events. */
export function listDeferredQueued(input: DeferredQueueInput) {
  return input.pending ?? []
}

export function pendingDeferredMessageIds(input: DeferredQueueInput) {
  return new Set(listDeferredQueued(input).map((item) => item.id))
}

type QueuePart = Part | SessionsQueueGetOutput["payload"]["parts"][number]

function stripQueuePart(part: QueuePart): PromptInfo["parts"][number] | undefined {
  if (part.type !== "file") return undefined
  if ("id" in part && "messageID" in part && "sessionID" in part) return stripPromptPartIDs(part)
  return part
}

export function partsToPromptInfo(parts: readonly QueuePart[]): PromptInfo {
  return parts.reduce(
    (agg, part) => {
      if (part.type === "text") {
        if (!part.synthetic && !part.ignored) agg.input += part.text
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
