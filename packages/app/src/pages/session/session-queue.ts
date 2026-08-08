import type {
  SessionsCommandInput,
  SessionsCommandOutput,
  SessionsQueueEnqueueInput,
  SessionsQueueEnqueueOutput,
  SessionsQueueListOutput,
  SessionsQueueUpdateInput,
} from "@/utils/current-client"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createSessionPayloadWithImages } from "@/components/prompt-input/session-payload"
import { promptFromSessionPayload } from "@/components/prompt-input/prompt-from-session-payload"
import { createPathHelpers } from "@/context/file/path"
import type { ContextItem } from "@/context/prompt"
import { readCommentMetadata } from "@/utils/comment-note"
import { Identifier } from "@/utils/id"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { Schema } from "effect"

type QueueWriter = {
  command?: (input: SessionsCommandInput) => Promise<SessionsCommandOutput>
  queueEnqueue: (input: SessionsQueueEnqueueInput) => Promise<SessionsQueueEnqueueOutput>
  queueUpdate: (input: SessionsQueueUpdateInput) => Promise<void>
  queueDrainResume: (input: { sessionID: string }) => Promise<void>
}
type QueueItem = Pick<SessionsQueueListOutput[number], "id" | "sessionID" | "payload">

export function queuedFollowup(
  item: QueueItem,
  directory: string,
  attachmentName: string,
): FollowupDraft {
  const payload = Schema.decodeUnknownSync(SessionInputPayload.Payload)(item.payload)
  return {
    sessionID: item.sessionID,
    sessionDirectory: directory,
    prompt: promptFromSessionPayload(payload, { directory, attachmentName }),
    context: contextItems(payload.parts, directory),
    agent: item.payload.agent,
    model: {
      providerID: item.payload.model.providerID,
      modelID: item.payload.model.modelID,
    },
    variant: item.payload.model.variant,
    queueID: item.id,
    queuePayload: item.payload,
  }
}

export async function saveQueuedFollowup(input: { client: QueueWriter; draft: FollowupDraft }) {
  const payload = await createSessionPayloadWithImages(input.draft)
  if (!input.draft.queueID && input.draft.command) {
    if (!input.client.command) throw new Error("Current command API is unavailable")
    return input.client.command({
      id: Identifier.ascending("message"),
      sessionID: input.draft.sessionID,
      name: input.draft.command.name,
      arguments: input.draft.command.arguments,
      payload,
      delivery: "queue",
    })
  }
  if (!input.draft.queueID) {
    return input.client.queueEnqueue({
      sessionID: input.draft.sessionID,
      payload,
    })
  }
  await input.client.queueUpdate({
    sessionID: input.draft.sessionID,
    messageID: input.draft.queueID,
    payload,
  })
  await input.client.queueDrainResume({ sessionID: input.draft.sessionID })
}

function contextItems(parts: QueueItem["payload"]["parts"], directory: string) {
  const comments = parts.flatMap((part, index): Array<ContextItem & { key: string }> => {
    if (part.type !== "text" || part.synthetic || part.ignored) return []
    const comment = readCommentMetadata(part.metadata)
    if (!comment) return []
    return [{ key: part.id ?? `queue-context-comment-${index}`, type: "file", ...comment }]
  })
  const commented = new Set(comments.map((item) => item.path))
  const paths = createPathHelpers(() => directory)
  return [
    ...comments,
    ...parts.flatMap((part, index): Array<ContextItem & { key: string }> => {
      if (part.type !== "file" || part.source || part.url.startsWith("data:")) return []
      const path = paths.normalize(part.url)
      if (commented.has(path)) return []
      const params = new URLSearchParams(part.url.split("?", 2)[1] ?? "")
      const startLine = Number(params.get("start"))
      const endLine = Number(params.get("end"))
      return [
        {
          key: part.id ?? `queue-context-${index}`,
          type: "file",
          path,
          ...(!Number.isFinite(startLine) || !Number.isFinite(endLine)
            ? {}
            : {
                selection: {
                  startLine,
                  startChar: 0,
                  endLine,
                  endChar: 0,
                },
              }),
        },
      ]
    }),
  ]
}
