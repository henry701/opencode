import { afterEach, describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, httpApiLayer))

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session queue routes", () => {
  const createUserMessage = (sessionID: SessionNs.Info["id"], text: string) =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const message = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: message.id,
        type: "text",
        text,
      })
      return message
    })

  it.instance(
    "enqueue, list, update, remove, and send",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const headers = { "content-type": "application/json" }

        const enqueue = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4" },
            parts: [{ type: "text", text: "queued one" }],
          }),
        })
        expect(enqueue.status).toBe(200)
        const first = (yield* enqueue.json) as { id: string; text: string }
        expect(first.text).toBe("queued one")

        const list = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        expect(list.status).toBe(200)
        const items = (yield* list.json) as { id: string; text: string }[]
        expect(items).toEqual([first])

        const get = yield* requestInDirectory(`/session/${session.id}/queue/${first.id}`, test.directory)
        expect(get.status).toBe(200)
        const detail = (yield* get.json) as {
          id: string
          parts: { type: string; text?: string }[]
        }
        expect(detail.id).toBe(first.id)
        expect(detail.parts[0]?.text).toBe("queued one")

        const update = yield* requestInDirectory(`/session/${session.id}/queue/${first.id}`, test.directory, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4" },
            parts: [{ type: "text", text: "queued edited" }],
          }),
        })
        expect(update.status).toBe(200)

        const listed = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        const afterUpdate = (yield* listed.json) as { id: string; text: string }[]
        expect(afterUpdate[0]?.text).toBe("queued edited")

        const remove = yield* requestInDirectory(`/session/${session.id}/queue/${first.id}`, test.directory, {
          method: "DELETE",
        })
        expect(remove.status).toBe(200)

        const empty = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        expect((yield* empty.json) as unknown[]).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "preserves queued prompts when web rollback reverts a message",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const message = yield* createUserMessage(session.id, "rollback anchor")
        const headers = { "content-type": "application/json" }

        const enqueue = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4" },
            parts: [{ type: "text", text: "stay queued after rollback" }],
          }),
        })
        expect(enqueue.status).toBe(200)
        const queued = (yield* enqueue.json) as { id: string; text: string }

        const revert = yield* requestInDirectory(`/session/${session.id}/revert`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({ messageID: message.id }),
        })
        expect(revert.status).toBe(200)

        const list = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        expect(list.status).toBe(200)
        expect((yield* list.json) as { id: string; text: string }[]).toEqual([queued])
      }),
    { git: true },
  )

  it.instance(
    "abort does not clear the prompt queue",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const headers = { "content-type": "application/json" }
        const body = {
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "stay queued" }],
        }

        const enqueue = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
        expect(enqueue.status).toBe(200)

        const abort = yield* requestInDirectory(`/session/${session.id}/abort`, test.directory, { method: "POST" })
        expect(abort.status).toBe(200)

        const list = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        expect(list.status).toBe(200)
        expect((yield* list.json) as unknown[]).toHaveLength(1)
      }),
    { git: true },
  )

  it.instance(
    "send returns not found for a stale queue item",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const headers = { "content-type": "application/json" }
        const enqueue = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-4" },
            parts: [{ type: "text", text: "stale" }],
          }),
        })
        const item = (yield* enqueue.json) as { id: string }
        const remove = yield* requestInDirectory(`/session/${session.id}/queue/${item.id}`, test.directory, {
          method: "DELETE",
          headers,
        })
        expect(remove.status).toBe(200)

        const response = yield* requestInDirectory(`/session/${session.id}/queue/${item.id}/send`, test.directory, {
          method: "POST",
          headers,
          body: "null",
        })

        const body = (yield* response.json) as { data?: { message?: string } }
        expect(response.status, JSON.stringify(body)).toBe(404)
        expect(body).toMatchObject({
          data: { message: "Queued message not found" },
        })
      }),
    { git: true },
  )

  it.instance(
    "allows more than three queued prompts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const headers = { "content-type": "application/json" }
        const body = {
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "queued" }],
        }

        for (let i = 0; i < 4; i++) {
          const res = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          })
          expect(res.status).toBe(200)
        }

        const listed = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        expect(listed.status).toBe(200)
        expect((yield* listed.json) as unknown[]).toHaveLength(4)
      }),
    { git: true },
  )

})
