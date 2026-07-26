import { Cause, Duration, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const queueHolds = new Map<SessionSchema.ID, symbol>()
    let resume: SessionExecution.Interface["resume"]
    let interrupt: SessionExecution.Interface["interrupt"]
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) =>
          runner.run({
            sessionID,
            force,
            execution: {
              resume,
              interrupt,
              queueDrainPaused: (targetID) => Effect.sync(() => queueHolds.has(targetID)),
            },
          }),
        ).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })
    resume = coordinator.run
    interrupt = coordinator.interrupt

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt,
      resume,
      wake: coordinator.wake,
      queueDrainPaused: (sessionID) => Effect.sync(() => queueHolds.has(sessionID)),
      pauseQueueDrain: (sessionID) =>
        Effect.sync(() => {
          const token = Symbol()
          queueHolds.set(sessionID, token)
          const timer = setTimeout(
            () => {
              if (queueHolds.get(sessionID) !== token) return
              queueHolds.delete(sessionID)
              Effect.runFork(coordinator.wake(sessionID))
            },
            Duration.toMillis(Duration.hours(24)),
          )
          timer.unref()
        }),
      resumeQueueDrain: (sessionID) =>
        Effect.sync(() => queueHolds.delete(sessionID)).pipe(Effect.andThen(coordinator.wake(sessionID))),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
