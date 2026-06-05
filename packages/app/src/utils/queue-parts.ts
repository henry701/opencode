import type {
  AgentPartInput,
  FilePartInput,
  Part,
  SubtaskPartInput,
  TextPartInput,
} from "@opencode-ai/sdk/v2"
import { Identifier } from "@/utils/id"

type QueuePart = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

export function partsFromQueueDetail(parts: readonly QueuePart[], sessionID: string): Part[] {
  const messageID = Identifier.ascending("message")
  return parts.map((part) => {
    const id = Identifier.ascending("part")
    if (part.type === "text") return { ...part, id, messageID, sessionID }
    if (part.type === "file") return { ...part, id, messageID, sessionID }
    if (part.type === "agent") return { ...part, id, messageID, sessionID }
    return { ...part, id, messageID, sessionID }
  })
}
