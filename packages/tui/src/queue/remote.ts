import type { OpenCode } from "@opencode-ai/client"

type QueueClient = ReturnType<typeof OpenCode.make>
type QueuedInput = Awaited<ReturnType<QueueClient["sessions"]["queueList"]>>[number]
export type QueuedPayload = QueuedInput["payload"]

export type QueuedPromptPreview = {
  id: string
  text: string
}

export function queuedPromptPreviews(input: readonly QueuedInput[]): QueuedPromptPreview[] {
  return input.map((item) => ({
    id: item.id,
    text:
      item.payload.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
        .join("\n")
        .trim() || (item.payload.parts.some((part) => part.type === "file") ? "[attachment]" : ""),
  }))
}

export function reviseQueuedPayload(payload: QueuedPayload, text: string): QueuedPayload {
  let revised = false
  const parts = payload.parts.map((part) => {
    if (part.type !== "text" || part.synthetic || part.ignored) return part
    if (revised) return { ...part, text: "" }
    revised = true
    return { ...part, text }
  })
  return {
    ...payload,
    parts: revised ? parts : [...parts, { type: "text", text }],
  }
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

export function parseRegisteredCommand(
  input: string,
  commands: readonly { name: string }[],
): { name: string; arguments: string } | undefined {
  const match = /^\/([^\s]+)(?:[ \t]+)?([\s\S]*)$/.exec(input)
  if (!match || !commands.some((command) => command.name === match[1])) return
  return {
    name: match[1]!,
    arguments: match[2] ?? "",
  }
}

export async function submitQueuedPayload(input: {
  client: QueueClient
  sessionID: string
  id: string
  payload: QueuedPayload
  command?: { name: string; arguments: string }
}) {
  if (input.command) {
    await input.client.sessions.command({
      sessionID: input.sessionID,
      id: input.id,
      name: input.command.name,
      arguments: input.command.arguments,
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
