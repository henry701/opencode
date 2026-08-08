import type { SessionsPromptInput } from "@/utils/current-client"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { Schema } from "effect"
import { buildRequestParts } from "./build-request-parts"
import type { FollowupDraft } from "./submit"
import { Identifier } from "@/utils/id"
import { blobDataUrl } from "@/utils/draft-store"

type Payload = NonNullable<SessionsPromptInput["payload"]>
const decodePayload = Schema.decodeUnknownSync(SessionInputPayload.Payload)
const encodePayload = Schema.encodeSync(SessionInputPayload.Payload)

export function createSessionPayload(draft: FollowupDraft, imageDataUrls?: ReadonlyMap<string, string>): Payload {
  const text = draft.prompt.map((part) => ("content" in part ? part.content : "")).join("")
  const images = draft.prompt.filter((part) => part.type === "image")
  const encodedImages = images.map((attachment) => ({
    ...attachment,
    dataUrl: imageDataUrls?.get(attachment.id) ?? attachment.blob.url,
  }))
  const built = buildRequestParts({
    prompt: draft.prompt,
    context: draft.context,
    images: encodedImages,
    text,
    sessionID: draft.sessionID,
    messageID: Identifier.ascending("message"),
    sessionDirectory: draft.sessionDirectory,
  }).requestParts
  const previous = draft.queuePayload
  const model = {
    providerID: draft.model.providerID,
    modelID: draft.model.modelID,
    ...(draft.variant ? { variant: draft.variant } : {}),
  }
  const parts = encodePayload(
    decodePayload({
      version: 1,
      agent: draft.agent,
      model,
      parts: built,
    }),
  ).parts
  return encodePayload(
    decodePayload({
      version: 1,
      agent: draft.agent,
      model,
      ...(previous?.tools ? { tools: previous.tools } : {}),
      ...(previous?.system ? { system: previous.system } : {}),
      ...(previous?.format ? { format: previous.format } : {}),
      ...(previous?.permissions ? { permissions: previous.permissions } : {}),
      parts: previous ? mergeEditableParts(previous.parts, parts) : parts,
    }),
  )
}

export async function createSessionPayloadWithImages(draft: FollowupDraft): Promise<Payload> {
  const images = draft.prompt.filter((part) => part.type === "image")
  const imageDataUrls = new Map(
    await Promise.all(
      images.map(async (attachment) => [attachment.id, await blobDataUrl(attachment.blob, attachment.mime)] as const),
    ),
  )
  return createSessionPayload(draft, imageDataUrls)
}

function mergeEditableParts(previous: Payload["parts"], next: Payload["parts"]) {
  const hidden = (part: Payload["parts"][number]) =>
    part.type === "subtask" || (part.type === "text" && (part.synthetic === true || part.ignored === true))
  const index = previous.findIndex((part) => !hidden(part))
  if (index === -1) return [...previous, ...next]
  return [...previous.slice(0, index).filter(hidden), ...next, ...previous.slice(index).filter(hidden)]
}
