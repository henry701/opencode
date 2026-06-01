import { expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { MessageV2 } from "@/session/message-v2"
import { SessionRunState } from "@/session/run-state"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") }

const it = testEffect(
  Layer.mergeAll(SessionRunState.defaultLayer, testInstanceStoreLayer, CrossSpawnSpawner.defaultLayer),
)

const message = (sessionID: SessionID, text: string): MessageV2.WithParts => {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  }
}

it.instance("tracks deferred messages per session", () =>
  Effect.gen(function* () {
    const run = yield* SessionRunState.Service
    const one = SessionID.make("ses_defer_one")
    const two = SessionID.make("ses_defer_two")
    const first = message(one, "first")
    const second = message(one, "second")
    const other = message(two, "other")

    expect(yield* run.hasDeferred(one)).toBe(false)
    expect(yield* run.hasRunner(one)).toBe(false)

    yield* run.defer(one, first)
    yield* run.defer(one, second)
    yield* run.defer(two, other)

    expect(yield* run.hasDeferred(one)).toBe(true)
    expect(yield* run.hasDeferred(two)).toBe(true)

    expect(yield* run.drainDeferred(one)).toEqual([first, second])
    expect(yield* run.hasDeferred(one)).toBe(false)
    expect(yield* run.drainDeferred(two)).toEqual([other])
  }),
)
