import { partsPreview } from "@/queue/preview"
import { MessageID, PartID, QueueItemID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { and, asc, eq, isNull } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionV1 } from "@opencode-ai/core/v1/session"

export const PromptQueuePart = Schema.Union([
  SessionV1.TextPartInput,
  SessionV1.FilePartInput,
  SessionV1.AgentPartInput,
  SessionV1.SubtaskPartInput,
]).annotate({ discriminator: "type" })
export type PromptQueuePart = Schema.Schema.Type<typeof PromptQueuePart>

const promptQueueDataFields = {
  version: Schema.Literal(1),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: ProviderID,
    modelID: ModelID,
    variant: Schema.optional(Schema.String),
  }),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  system: Schema.optional(Schema.String),
  format: Schema.optional(SessionV1.Format),
  parts: Schema.Array(PromptQueuePart),
  permissions: Schema.optional(Schema.Array(PermissionV1.Rule)),
} as const

export const PromptQueueData = Schema.Struct(promptQueueDataFields).annotate({ identifier: "PromptQueueData" })
export type PromptQueueData = Schema.Schema.Type<typeof PromptQueueData>

export type QueueItem = {
  id: QueueItemID
  sessionID: SessionID
  position: number
  time_created: number
  data: PromptQueueData
}

export type QueueItemPreview = {
  id: QueueItemID
  text: string
}

export const QueueItemDetail = Schema.Struct({
  id: QueueItemID,
  ...promptQueueDataFields,
}).annotate({ identifier: "QueueItemDetail" })
export type QueueItemDetail = Schema.Schema.Type<typeof QueueItemDetail>

export function queueItemPreview(item: QueueItem): QueueItemPreview {
  return {
    id: item.id,
    text: partsPreview(queuePartsForPreview(item.data.parts)),
  }
}

function queuePartsForPreview(parts: readonly PromptQueuePart[]): SessionV1.Part[] {
  return [...parts].map((part) => {
    const id = PartID.ascending()
    const messageID = MessageID.ascending()
    const sessionID = SessionID.make("ses_preview")
    if (part.type === "text") return { ...part, id, messageID, sessionID }
    if (part.type === "file") return { ...part, id, messageID, sessionID }
    if (part.type === "agent") return { ...part, id, messageID, sessionID }
    return { ...part, id, messageID, sessionID }
  })
}

export function enqueueItem<T extends { position: number }>(queue: readonly T[], item: T): T[] {
  const position = queue.length === 0 ? 0 : Math.max(...queue.map((entry) => entry.position)) + 1
  return [...queue, { ...item, position }]
}

export function shiftHead<T>(queue: readonly T[]): { head: T | undefined; rest: T[] } {
  if (queue.length === 0) return { head: undefined, rest: [] }
  return { head: queue[0], rest: queue.slice(1) }
}

export function replaceItem<T extends { id: QueueItemID }>(queue: readonly T[], id: QueueItemID, item: T): T[] | undefined {
  const index = queue.findIndex((entry) => entry.id === id)
  if (index < 0) return undefined
  const next = [...queue]
  next[index] = item
  return next
}

export function removeItem<T extends { id: QueueItemID }>(queue: readonly T[], id: QueueItemID): T[] | undefined {
  const index = queue.findIndex((entry) => entry.id === id)
  if (index < 0) return undefined
  const next = [...queue]
  next.splice(index, 1)
  return next.map((entry, position) => ({ ...entry, position }))
}

export function peekHead<T>(queue: readonly T[]): T | undefined {
  return queue[0]
}

export class MemoryPromptQueue {
  private readonly queues = new Map<SessionID, QueueItem[]>()

  list(sessionID: SessionID): QueueItem[] {
    return [...(this.queues.get(sessionID) ?? [])]
  }

  enqueue(sessionID: SessionID, data: PromptQueueData): QueueItem {
    const queue = this.queues.get(sessionID) ?? []
    const item: QueueItem = {
      id: QueueItemID.ascending(),
      sessionID,
      position: queue.length === 0 ? 0 : queue[queue.length - 1]!.position + 1,
      time_created: Date.now(),
      data,
    }
    this.queues.set(sessionID, [...queue, item])
    return item
  }

  update(sessionID: SessionID, id: QueueItemID, data: PromptQueueData): boolean {
    const queue = this.queues.get(sessionID)
    if (!queue) return false
    const index = queue.findIndex((entry) => entry.id === id)
    if (index < 0) return false
    const next = [...queue]
    next[index] = { ...next[index]!, data }
    this.queues.set(sessionID, next)
    return true
  }

  remove(sessionID: SessionID, id: QueueItemID): boolean {
    const queue = this.queues.get(sessionID)
    if (!queue) return false
    const next = removeItem(queue, id)
    if (!next) return false
    if (next.length === 0) this.queues.delete(sessionID)
    else this.queues.set(sessionID, next)
    return true
  }

  peek(sessionID: SessionID): QueueItem | undefined {
    return peekHead(this.queues.get(sessionID) ?? [])
  }

  dequeue(sessionID: SessionID): QueueItem | undefined {
    const queue = this.queues.get(sessionID)
    if (!queue?.length) return undefined
    const { head, rest } = shiftHead(queue)
    if (rest.length === 0) this.queues.delete(sessionID)
    else this.queues.set(sessionID, rest.map((entry, position) => ({ ...entry, position })))
    return head
  }

  clear(sessionID: SessionID): void {
    this.queues.delete(sessionID)
  }
}

const QUEUE_PAYLOAD = "__opencodeQueue"

type StoredQueuePrompt = {
  [QUEUE_PAYLOAD]: PromptQueueData
}

const pendingQueue = (sessionID: SessionID) =>
  and(
    eq(SessionInputTable.session_id, sessionID),
    eq(SessionInputTable.delivery, "queue"),
    isNull(SessionInputTable.promoted_seq),
  )

const summaryPrompt = (data: PromptQueueData) =>
  Prompt.fromUserMessage({
    text: data.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
  })

const storePrompt = (data: PromptQueueData): Prompt => ({ [QUEUE_PAYLOAD]: data }) as unknown as Prompt

const readQueuePrompt = (row: typeof SessionInputTable.$inferSelect): PromptQueueData => {
  const prompt = row.prompt as unknown
  if (prompt && typeof prompt === "object" && QUEUE_PAYLOAD in prompt) {
    return (prompt as StoredQueuePrompt)[QUEUE_PAYLOAD]
  }
  throw new Error("Queued session input is missing payload")
}

const rowToItem = (row: typeof SessionInputTable.$inferSelect): QueueItem => ({
  id: QueueItemID.make(row.id),
  sessionID: row.session_id,
  position: row.admitted_seq,
  time_created: row.time_created,
  data: readQueuePrompt(row),
})

export const sqliteList = Effect.fn("PromptQueue.sqliteList")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(pendingQueue(sessionID))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(rowToItem)
})

export const sqliteEnqueue = Effect.fn("PromptQueue.sqliteEnqueue")(function* (sessionID: SessionID, data: PromptQueueData) {
  const { db } = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const id = MessageID.ascending()
  const messageID = SessionMessage.ID.make(id)
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const admitted = yield* SessionInput.admit(db, events, {
            id: messageID,
            sessionID,
            prompt: summaryPrompt(data),
            delivery: "queue",
          })
          if (!admitted) return yield* Effect.die("Failed to admit queued prompt")
          yield* db
            .update(SessionInputTable)
            .set({ prompt: storePrompt(data) })
            .where(eq(SessionInputTable.id, messageID))
            .run()
            .pipe(Effect.orDie)
          const row = yield* db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, messageID))
            .get()
            .pipe(Effect.orDie)
          if (row === undefined) return yield* Effect.die("Queued prompt row missing after admit")
          return rowToItem(row)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const sqliteUpdate = Effect.fn("PromptQueue.sqliteUpdate")(function* (
  sessionID: SessionID,
  id: QueueItemID,
  data: PromptQueueData,
) {
  const { db } = yield* Database.Service
  const updated = yield* db
    .update(SessionInputTable)
    .set({ prompt: storePrompt(data) })
    .where(and(eq(SessionInputTable.id, SessionMessage.ID.make(id)), pendingQueue(sessionID)))
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  return updated !== undefined
})

export const sqliteRemove = Effect.fn("PromptQueue.sqliteRemove")(function* (sessionID: SessionID, id: QueueItemID) {
  const { db } = yield* Database.Service
  const removed = yield* db
    .delete(SessionInputTable)
    .where(and(eq(SessionInputTable.id, SessionMessage.ID.make(id)), pendingQueue(sessionID)))
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  return removed !== undefined
})

export const sqlitePeek = Effect.fn("PromptQueue.sqlitePeek")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(pendingQueue(sessionID))
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : rowToItem(row)
})

export const sqliteDequeue = Effect.fn("PromptQueue.sqliteDequeue")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const head = yield* db
            .select()
            .from(SessionInputTable)
            .where(pendingQueue(sessionID))
            .orderBy(asc(SessionInputTable.admitted_seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (head === undefined) return undefined
          yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, head.id)).run().pipe(Effect.orDie)
          return rowToItem(head)
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

export const sqliteClear = Effect.fn("PromptQueue.sqliteClear")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  yield* db.delete(SessionInputTable).where(pendingQueue(sessionID)).run().pipe(Effect.orDie)
})

export function materializeQueuedItem(item: QueueItem): SessionV1.WithParts {
  const id = MessageID.ascending()
  const created = Date.now()
  const info: SessionV1.User = {
    id,
    role: "user",
    sessionID: item.sessionID,
    time: { created },
    agent: item.data.agent,
    model: item.data.model,
    tools: item.data.tools,
    system: item.data.system,
    format: item.data.format,
    delivery: "immediate",
  }
  const parts = item.data.parts.map((part) => {
    const partID = part.id ? PartID.make(part.id) : PartID.ascending()
    if (part.type === "text") {
      return { ...part, id: partID, messageID: id, sessionID: item.sessionID }
    }
    if (part.type === "file") {
      return { ...part, id: partID, messageID: id, sessionID: item.sessionID }
    }
    if (part.type === "agent") {
      return { ...part, id: partID, messageID: id, sessionID: item.sessionID }
    }
    return { ...part, id: partID, messageID: id, sessionID: item.sessionID }
  })
  return { info, parts }
}

export function queueDataFromMessage(message: SessionV1.WithParts): PromptQueueData {
  if (message.info.role !== "user") {
    throw new Error("Only user messages can be queued")
  }
  const parts: PromptQueuePart[] = message.parts.map((part) => {
    if (part.type === "text") {
      return {
        type: "text",
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        time: part.time,
        metadata: part.metadata,
      }
    }
    if (part.type === "file") {
      return {
        type: "file",
        mime: part.mime,
        filename: part.filename,
        url: part.url,
        source: part.source,
      }
    }
    if (part.type === "agent") {
      return {
        type: "agent",
        name: part.name,
        source: part.source,
      }
    }
    if (part.type === "subtask") {
      return {
        type: "subtask",
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
        model: part.model,
        command: part.command,
      }
    }
    throw new Error(`Unsupported queued part type: ${part.type}`)
  })
  return {
    version: 1,
    agent: message.info.agent,
    model: message.info.model,
    tools: message.info.tools,
    system: message.info.system,
    format: message.info.format,
    parts,
  }
}

export function queueDataFromMessageWithPermissions(
  message: SessionV1.WithParts,
  permissions?: PermissionV1.Ruleset,
): PromptQueueData {
  const data = queueDataFromMessage(message)
  if (!permissions) return data
  return { ...data, permissions }
}

export * as PromptQueue from "./prompt-queue"
