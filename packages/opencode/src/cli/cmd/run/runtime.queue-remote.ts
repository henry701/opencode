import type { OpenCode, SessionsQueueEnqueueInput } from "@opencode-ai/client"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { Schema } from "effect"
import type { RunInput, RunPrompt } from "./types"

type QueueClient = ReturnType<typeof OpenCode.make>
type QueuedInput = Awaited<ReturnType<QueueClient["sessions"]["queueList"]>>[number]
type QueuePayload = SessionsQueueEnqueueInput["payload"]
const decodePayload = Schema.decodeUnknownSync(SessionInputPayload.Payload)
const encodePayload = Schema.encodeSync(SessionInputPayload.Payload)

export function queuedPromptPreviews(input: readonly QueuedInput[]) {
  return input.map((item) => ({
    id: item.id,
    text:
      item.payload.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n")
        .trim() || (item.payload.parts.some((part) => part.type === "file") ? "[attachment]" : ""),
  }))
}

export function queueEventSessionID(event: unknown) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return
  const type = Reflect.get(event, "type")
  const properties = Reflect.get(event, "properties")
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return
  const sessionID = Reflect.get(properties, "sessionID")
  if (typeof sessionID !== "string") return
  if (type === "session.next.prompt.revised" || type === "session.next.prompt.discarded") return sessionID
  if (type === "session.next.prompt.expedited") return sessionID
  if (type !== "session.next.prompt.admitted" && type !== "session.next.prompted") return
  if (Reflect.get(properties, "delivery") !== "queue") return
  return sessionID
}

export function buildQueuePromptPayload(input: {
  agent: string | undefined
  model: RunInput["model"]
  variant?: string
  prompt: RunPrompt
}): QueuePayload {
  const agent = input.prompt.queuePayload?.agent ?? input.agent
  const model = input.prompt.queuePayload?.model ?? input.model
  if (!agent || !model) throw new Error("Queued prompts require an agent and model")
  const original = input.prompt.queuePayload?.parts
  const firstText = original?.findIndex((part) => part.type === "text" && !part.synthetic && !part.ignored) ?? -1
  const parts = original
    ? firstText === -1
      ? [{ type: "text" as const, text: input.prompt.text }, ...original]
      : original.map((part, index) => {
          if (part.type !== "text" || part.synthetic || part.ignored) return part
          return {
            ...part,
            text: index === firstText ? input.prompt.text : "",
          }
        })
    : [{ type: "text" as const, text: input.prompt.text }, ...input.prompt.parts]
  return encodePayload(
    decodePayload({
      ...input.prompt.queuePayload,
      version: 1,
      agent,
      model: input.prompt.queuePayload
        ? model
        : {
            providerID: model.providerID,
            modelID: model.modelID,
            ...(input.variant === undefined ? {} : { variant: input.variant }),
          },
      parts,
    }),
  )
}

export function buildQueueSendPayload(input: {
  agent: string | undefined
  model: RunInput["model"]
  variant?: string
  prompt?: RunPrompt
}) {
  if (!input.prompt) return undefined
  return buildQueuePromptPayload({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    prompt: input.prompt,
  })
}

export function runPromptFromQueueDetail(input: {
  id: string
  payload?: QueuePayload
}): RunPrompt {
  const parts = input.payload?.parts ?? []
  return {
    text: parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text ?? ""] : []))
      .join("\n"),
    parts: parts.flatMap((part): RunPrompt["parts"] => (part.type === "text" ? [] : [{ ...part }])),
    queueID: input.id,
    queuePayload: input.payload,
    queued: true,
  }
}

export async function enqueueRemotePrompt(input: {
  client: QueueClient
  sessionID: string
  id: string
  prompt: RunPrompt
  payload: QueuePayload
}) {
  if (input.prompt.command) {
    await input.client.sessions.command({
      sessionID: input.sessionID,
      id: input.id,
      name: input.prompt.command.name,
      arguments: input.prompt.command.arguments,
      payload: input.payload,
      delivery: "queue",
    })
    return
  }
  await input.client.sessions.queueEnqueue({
    sessionID: input.sessionID,
    id: input.id,
    payload: input.payload,
  })
}

export async function loadCurrentCommandCatalog(client: QueueClient, directory: string) {
  return client.commands.list({ location: { directory } }).then((result) => [...result.data])
}
