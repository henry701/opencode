import { Database } from "@/storage/db"
import { partsPreview } from "@/queue/preview"
import { MessageV2 } from "@/session/message-v2"
import { PromptQueueTable } from "@/session/session.sql"
import { MessageID, PartID, QueueItemID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { and, asc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Permission } from "@/permission"

export const PromptQueuePart = Schema.Union([
  MessageV2.TextPartInput,
  MessageV2.FilePartInput,
  MessageV2.AgentPartInput,
  MessageV2.SubtaskPartInput,
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
  format: Schema.optional(MessageV2.Format),
  parts: Schema.Array(PromptQueuePart),
  permissions: Schema.optional(Schema.Array(Schema.Any)),
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

function queuePartsForPreview(parts: readonly PromptQueuePart[]): MessageV2.Part[] {
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

function rowToItem(row: typeof PromptQueueTable.$inferSelect): QueueItem {
  return {
    id: row.id,
    sessionID: row.session_id,
    position: row.position,
    time_created: row.time_created,
    data: row.data as PromptQueueData,
  }
}

export const sqliteList = Effect.fn("PromptQueue.sqliteList")(function* (sessionID: SessionID) {
  const rows = yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(PromptQueueTable)
        .where(eq(PromptQueueTable.session_id, sessionID))
        .orderBy(asc(PromptQueueTable.position))
        .all(),
    ),
  )
  return rows.map(rowToItem)
})

export const sqliteEnqueue = Effect.fn("PromptQueue.sqliteEnqueue")(function* (sessionID: SessionID, data: PromptQueueData) {
  return yield* Effect.sync(() => Database.use((db) => sqliteEnqueueWithDb(db, sessionID, data)))
})

export function sqliteEnqueueWithDb(db: Database.TxOrDb, sessionID: SessionID, data: PromptQueueData): QueueItem {
  const existing = db
    .select()
    .from(PromptQueueTable)
    .where(eq(PromptQueueTable.session_id, sessionID))
    .orderBy(asc(PromptQueueTable.position))
    .all()
  const item: QueueItem = {
    id: QueueItemID.ascending(),
    sessionID,
    position: existing.length === 0 ? 0 : existing[existing.length - 1]!.position + 1,
    time_created: Date.now(),
    data,
  }
  db.insert(PromptQueueTable)
    .values({
      id: item.id,
      session_id: sessionID,
      position: item.position,
      time_created: item.time_created,
      time_updated: item.time_created,
      data,
    })
    .run()
  return item
}

export const sqliteUpdate = Effect.fn("PromptQueue.sqliteUpdate")(function* (
  sessionID: SessionID,
  id: QueueItemID,
  data: PromptQueueData,
) {
  const updated = yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .update(PromptQueueTable)
        .set({ data, time_updated: Date.now() })
        .where(and(eq(PromptQueueTable.id, id), eq(PromptQueueTable.session_id, sessionID)))
        .returning({ id: PromptQueueTable.id })
        .get(),
    ),
  )
  return !!updated
})

export const sqliteRemove = Effect.fn("PromptQueue.sqliteRemove")(function* (sessionID: SessionID, id: QueueItemID) {
  const removed = yield* Effect.sync(() =>
    Database.transaction((db) => {
      const row = db
        .select()
        .from(PromptQueueTable)
        .where(eq(PromptQueueTable.id, id))
        .get()
      if (!row || row.session_id !== sessionID) return false
      db.delete(PromptQueueTable).where(eq(PromptQueueTable.id, id)).run()
      const rest = db
        .select()
        .from(PromptQueueTable)
        .where(eq(PromptQueueTable.session_id, sessionID))
        .orderBy(asc(PromptQueueTable.position))
        .all()
      for (const [position, entry] of rest.entries()) {
        if (entry.position === position) continue
        db.update(PromptQueueTable).set({ position, time_updated: Date.now() }).where(eq(PromptQueueTable.id, entry.id)).run()
      }
      return true
    }),
  )
  return removed
})

export const sqlitePeek = Effect.fn("PromptQueue.sqlitePeek")(function* (sessionID: SessionID) {
  const items = yield* sqliteList(sessionID)
  return peekHead(items)
})

export const sqliteDequeue = Effect.fn("PromptQueue.sqliteDequeue")(function* (sessionID: SessionID) {
  const head = yield* sqlitePeek(sessionID)
  if (!head) return undefined
  yield* sqliteRemove(sessionID, head.id)
  return head
})

export const sqliteClear = Effect.fn("PromptQueue.sqliteClear")(function* (sessionID: SessionID) {
  yield* Effect.sync(() =>
    Database.use((db) => db.delete(PromptQueueTable).where(eq(PromptQueueTable.session_id, sessionID)).run()),
  )
})

export function materializeQueuedItem(item: QueueItem): MessageV2.WithParts {
  const id = MessageID.ascending()
  const created = Date.now()
  const info: MessageV2.User = {
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

export function queueDataFromMessage(message: MessageV2.WithParts): PromptQueueData {
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
  message: MessageV2.WithParts,
  permissions?: Permission.Ruleset,
): PromptQueueData {
  const data = queueDataFromMessage(message)
  if (!permissions) return data
  return { ...data, permissions }
}

export * as PromptQueue from "./prompt-queue"
