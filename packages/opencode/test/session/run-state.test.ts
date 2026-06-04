import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { SessionRunState } from "@/session/run-state"
import { SessionID } from "@/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(SessionRunState.defaultLayer, testInstanceStoreLayer, CrossSpawnSpawner.defaultLayer),
)

it.instance("reports no runner before work starts", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const sessionID = SessionID.make("ses_run_idle")
    expect(yield* run.hasRunner(sessionID)).toBe(false)
  }),
)
