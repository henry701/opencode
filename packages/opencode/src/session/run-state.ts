import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { partsPreview } from "@/queue/preview"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly hasRunner: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly defer: (sessionID: SessionID, message: MessageV2.WithParts) => Effect.Effect<void>
  readonly updateDeferred: (
    sessionID: SessionID,
    messageID: MessageID,
    message: MessageV2.WithParts,
  ) => Effect.Effect<boolean>
  readonly takeDeferred: (
    sessionID: SessionID,
    messageID: MessageID,
  ) => Effect.Effect<MessageV2.WithParts | undefined>
  readonly popDeferred: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts | undefined>
  readonly drainDeferred: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts[]>
  readonly hasDeferred: (sessionID: SessionID) => Effect.Effect<boolean>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        const deferred = new Map<SessionID, MessageV2.WithParts[]>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            deferred.clear()
          }),
        )
        return { runners, deferred, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
    })

    const hasRunner = Effect.fn("SessionRunState.hasRunner")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.runners.get(sessionID)?.busy ?? false
    })

    const publishDeferred = Effect.fn("SessionRunState.publishDeferred")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID) ?? []
      yield* bus.publish(Session.Event.DeferredUpdated, {
        sessionID,
        items: queue.map((entry) => ({
          id: entry.info.id,
          text: partsPreview(entry.parts),
        })),
      })
    })

    const defer = Effect.fn("SessionRunState.defer")(function* (sessionID: SessionID, message: MessageV2.WithParts) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID)
      if (queue) queue.push(message)
      else data.deferred.set(sessionID, [message])
      yield* publishDeferred(sessionID)
    })

    const updateDeferred = Effect.fn("SessionRunState.updateDeferred")(function* (
      sessionID: SessionID,
      messageID: MessageID,
      message: MessageV2.WithParts,
    ) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID)
      if (!queue) return false
      const index = queue.findIndex((entry) => entry.info.id === messageID)
      if (index < 0) return false
      queue[index] = message
      yield* publishDeferred(sessionID)
      return true
    })

    const takeDeferred = Effect.fn("SessionRunState.takeDeferred")(function* (
      sessionID: SessionID,
      messageID: MessageID,
    ) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID)
      if (!queue) return undefined
      const index = queue.findIndex((entry) => entry.info.id === messageID)
      if (index < 0) return undefined
      const [next] = queue.splice(index, 1)
      if (queue.length === 0) data.deferred.delete(sessionID)
      yield* publishDeferred(sessionID)
      return next
    })

    const popDeferred = Effect.fn("SessionRunState.popDeferred")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID)
      if (!queue?.length) return undefined
      const next = queue.shift()!
      if (queue.length === 0) data.deferred.delete(sessionID)
      yield* publishDeferred(sessionID)
      return next
    })

    const drainDeferred = Effect.fn("SessionRunState.drainDeferred")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const queue = data.deferred.get(sessionID) ?? []
      data.deferred.delete(sessionID)
      return queue
    })

    const hasDeferred = Effect.fn("SessionRunState.hasDeferred")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return (data.deferred.get(sessionID)?.length ?? 0) > 0
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      data.deferred.delete(sessionID)
      yield* publishDeferred(sessionID)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      assertNotBusy,
      cancel,
      hasRunner,
      defer,
      updateDeferred,
      takeDeferred,
      popDeferred,
      drainDeferred,
      hasDeferred,
      ensureRunning,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
