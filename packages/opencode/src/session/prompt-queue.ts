import { Bus } from "@/bus"
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

export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<QueueItem[]>
  readonly listPreview: (sessionID: SessionID) => Effect.Effect<QueueItemPreview[]>
  readonly enqueue: (sessionID: SessionID, data: PromptQueueData) => Effect.Effect<QueueItem>
  readonly update: (sessionID: SessionID, id: QueueItemID, data: PromptQueueData) => Effect.Effect<boolean>
  readonly remove: (sessionID: SessionID, id: QueueItemID) => Effect.Effect<boolean>
  readonly peek: (sessionID: SessionID) => Effect.Effect<QueueItem | undefined>
  readonly dequeue: (sessionID: SessionID) => Effect.Effect<QueueItem | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly pauseDrain: (sessionID: SessionID) => Effect.Effect<void>
  readonly resumeDrain: (sessionID: SessionID) => Effect.Effect<void>
  readonly drainPaused: (sessionID: SessionID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPromptQueue") {}

const drainPaused = new Map<string, Set<SessionID>>()

const pauseState = Effect.fn("SessionPromptQueue.pauseState")(function* () {
  const directory = yield* InstanceState.directory
  const existing = drainPaused.get(directory)
  if (existing) return existing
  const next = new Set<SessionID>()
  drainPaused.set(directory, next)
  return next
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const list = Effect.fn("SessionPromptQueue.list")(function* (sessionID: SessionID) {
      return yield* sqliteList(sessionID)
    })

    const listPreview = Effect.fn("SessionPromptQueue.listPreview")(function* (sessionID: SessionID) {
      const items = yield* list(sessionID)
      return items.map(PromptQueue.queueItemPreview)
    })

    const publish = Effect.fn("SessionPromptQueue.publish")(function* (sessionID: SessionID) {
      const items = yield* listPreview(sessionID)
      const payload = { sessionID, items }
      yield* bus.publish(Session.Event.QueueUpdated, payload)
    })

    const enqueue = Effect.fn("SessionPromptQueue.enqueue")(function* (sessionID: SessionID, data: PromptQueueData) {
      const item = yield* sqliteEnqueue(sessionID, data)
      yield* publish(sessionID)
      return item
    })

    const update = Effect.fn("SessionPromptQueue.update")(function* (
      sessionID: SessionID,
      id: QueueItemID,
      data: PromptQueueData,
    ) {
      const ok = yield* sqliteUpdate(sessionID, id, data)
      if (ok) yield* publish(sessionID)
      return ok
    })

    const remove = Effect.fn("SessionPromptQueue.remove")(function* (sessionID: SessionID, id: QueueItemID) {
      const ok = yield* sqliteRemove(sessionID, id)
      if (ok) yield* publish(sessionID)
      return ok
    })

    const peek = Effect.fn("SessionPromptQueue.peek")(function* (sessionID: SessionID) {
      return yield* sqlitePeek(sessionID)
    })

    const dequeue = Effect.fn("SessionPromptQueue.dequeue")(function* (sessionID: SessionID) {
      const item = yield* sqliteDequeue(sessionID)
      if (item) yield* publish(sessionID)
      return item
    })

    const clear = Effect.fn("SessionPromptQueue.clear")(function* (sessionID: SessionID) {
      yield* sqliteClear(sessionID)
      const paused = yield* pauseState()
      paused.delete(sessionID)
      yield* publish(sessionID)
    })

    const pauseDrain = Effect.fn("SessionPromptQueue.pauseDrain")(function* (sessionID: SessionID) {
      const paused = yield* pauseState()
      paused.add(sessionID)
    })

    const resumeDrain = Effect.fn("SessionPromptQueue.resumeDrain")(function* (sessionID: SessionID) {
      const paused = yield* pauseState()
      paused.delete(sessionID)
    })

    const drainPausedFor = Effect.fn("SessionPromptQueue.drainPaused")(function* (sessionID: SessionID) {
      return (yield* pauseState()).has(sessionID)
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
      drainPaused: drainPausedFor,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionPromptQueue from "./prompt-queue"
