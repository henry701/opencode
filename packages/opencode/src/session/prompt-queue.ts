import {
  PromptQueue,
  type PromptQueueData,
  type QueueItem,
  type QueueItemPreview,
  sqliteClear,
  sqliteDequeue,
  sqliteEnqueue,
  sqliteList,
  sqlitePeek,
  sqliteRemove,
  sqliteUpdate,
} from "@/queue/prompt-queue"
import * as Session from "./session"
import { QueueItemID, SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<QueueItem[]>
  readonly listPreview: (sessionID: SessionID) => Effect.Effect<QueueItemPreview[]>
  readonly enqueue: (sessionID: SessionID, data: PromptQueueData) => Effect.Effect<QueueItem>
  readonly update: (sessionID: SessionID, id: QueueItemID, data: PromptQueueData) => Effect.Effect<boolean>
  readonly remove: (sessionID: SessionID, id: QueueItemID) => Effect.Effect<boolean>
  readonly peek: (sessionID: SessionID) => Effect.Effect<QueueItem | undefined>
  readonly dequeue: (sessionID: SessionID) => Effect.Effect<QueueItem | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly pauseDrain: (sessionID: SessionID) => Effect.Effect<number>
  readonly resumeDrain: (sessionID: SessionID) => Effect.Effect<void>
  readonly resumeExpiredDrain: (sessionID: SessionID, token: number) => Effect.Effect<boolean>
  readonly drainPaused: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptQueue") {}

const drainPaused = new Map<string, Map<SessionID, { expires: number; token: number }>>()
export const drainPauseTTL = 24 * 60 * 60 * 1000
let drainPauseToken = 0

const pauseState = Effect.fn("SessionPromptQueue.pauseState")(function* () {
  const directory = yield* InstanceState.directory
  const existing = drainPaused.get(directory)
  if (existing) return existing
  const next = new Map<SessionID, { expires: number; token: number }>()
  drainPaused.set(directory, next)
  return next
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2Bridge.Service

    const list = Effect.fn("SessionPromptQueue.list")(function* (sessionID: SessionID) {
      return yield* sqliteList(sessionID).pipe(Effect.provideService(Database.Service, database))
    })

    const listPreview = Effect.fn("SessionPromptQueue.listPreview")(function* (sessionID: SessionID) {
      const items = yield* list(sessionID)
      return items.map(PromptQueue.queueItemPreview)
    })

    const publish = Effect.fn("SessionPromptQueue.publish")(function* (sessionID: SessionID) {
      const items = yield* listPreview(sessionID)
      const payload = { sessionID, items }
      yield* events.publish(Session.Event.QueueUpdated, payload)
    })

    const enqueue = Effect.fn("SessionPromptQueue.enqueue")(function* (sessionID: SessionID, data: PromptQueueData) {
      const item = yield* sqliteEnqueue(sessionID, data).pipe(
        Effect.provideService(Database.Service, database),
        Effect.provideService(EventV2Bridge.Service, events),
      )
      yield* publish(sessionID)
      return item
    })

    const update = Effect.fn("SessionPromptQueue.update")(function* (
      sessionID: SessionID,
      id: QueueItemID,
      data: PromptQueueData,
    ) {
      const ok = yield* sqliteUpdate(sessionID, id, data).pipe(Effect.provideService(Database.Service, database))
      if (ok) yield* publish(sessionID)
      return ok
    })

    const remove = Effect.fn("SessionPromptQueue.remove")(function* (sessionID: SessionID, id: QueueItemID) {
      const ok = yield* sqliteRemove(sessionID, id).pipe(Effect.provideService(Database.Service, database))
      if (ok) yield* publish(sessionID)
      return ok
    })

    const peek = Effect.fn("SessionPromptQueue.peek")(function* (sessionID: SessionID) {
      return yield* sqlitePeek(sessionID).pipe(Effect.provideService(Database.Service, database))
    })

    const dequeue = Effect.fn("SessionPromptQueue.dequeue")(function* (sessionID: SessionID) {
      const item = yield* sqliteDequeue(sessionID).pipe(Effect.provideService(Database.Service, database))
      if (item) yield* publish(sessionID)
      return item
    })

    const clear = Effect.fn("SessionPromptQueue.clear")(function* (sessionID: SessionID) {
      yield* sqliteClear(sessionID).pipe(Effect.provideService(Database.Service, database))
      const paused = yield* pauseState()
      paused.delete(sessionID)
      yield* publish(sessionID)
    })

    const pauseDrain = Effect.fn("SessionPromptQueue.pauseDrain")(function* (sessionID: SessionID) {
      const paused = yield* pauseState()
      const token = ++drainPauseToken
      paused.set(sessionID, { expires: Date.now() + drainPauseTTL, token })
      return token
    })

    const resumeDrain = Effect.fn("SessionPromptQueue.resumeDrain")(function* (sessionID: SessionID) {
      const paused = yield* pauseState()
      paused.delete(sessionID)
    })

    const resumeExpiredDrain = Effect.fn("SessionPromptQueue.resumeExpiredDrain")(function* (
      sessionID: SessionID,
      token: number,
    ) {
      const paused = yield* pauseState()
      const entry = paused.get(sessionID)
      if (!entry || entry.token !== token || entry.expires > Date.now()) return false
      paused.delete(sessionID)
      return true
    })

    const drainPausedFor = Effect.fn("SessionPromptQueue.drainPaused")(function* (sessionID: SessionID) {
      const paused = yield* pauseState()
      const entry = paused.get(sessionID)
      if (!entry) return false
      if (entry.expires > Date.now()) return true
      paused.delete(sessionID)
      return false
    })

    return Service.of({
      list,
      listPreview,
      enqueue,
      update,
      remove,
      peek,
      dequeue,
      clear,
      pauseDrain,
      resumeDrain,
      resumeExpiredDrain,
      drainPaused: drainPausedFor,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.mergeAll(EventV2Bridge.defaultLayer, Database.defaultLayer)))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node])

export * as SessionPromptQueue from "./prompt-queue"
