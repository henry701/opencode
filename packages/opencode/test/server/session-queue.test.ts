import { afterEach, describe, expect, mock } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("session queue routes", () => {
  it.instance(
    "enqueue, list, update, remove, and send",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const enqueue = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "openai", modelID: "gpt-4" },
                parts: [{ type: "text", text: "queued one" }],
              }),
            }),
          ),
        )
        expect(enqueue.status).toBe(200)
        const first = (yield* Effect.promise(() => enqueue.json())) as { id: string; text: string }
        expect(first.text).toBe("queued one")

        const list = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "GET",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect(list.status).toBe(200)
        const items = (yield* Effect.promise(() => list.json())) as { id: string; text: string }[]
        expect(items).toEqual([first])

        const get = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue/${first.id}`, {
              method: "GET",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect(get.status).toBe(200)
        const detail = (yield* Effect.promise(() => get.json())) as {
          id: string
          parts: { type: string; text?: string }[]
        }
        expect(detail.id).toBe(first.id)
        expect(detail.parts[0]?.text).toBe("queued one")

        const update = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue/${first.id}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                agent: "build",
                model: { providerID: "openai", modelID: "gpt-4" },
                parts: [{ type: "text", text: "queued edited" }],
              }),
            }),
          ),
        )
        expect(update.status).toBe(200)

        const listed = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "GET",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        const afterUpdate = (yield* Effect.promise(() => listed.json())) as { id: string; text: string }[]
        expect(afterUpdate[0]?.text).toBe("queued edited")

        const remove = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue/${first.id}`, {
              method: "DELETE",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect(remove.status).toBe(200)

        const empty = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "GET",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect((yield* Effect.promise(() => empty.json())) as unknown[]).toEqual([])
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

        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const body = {
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "stay queued" }],
        }

        const enqueue = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            }),
          ),
        )
        expect(enqueue.status).toBe(200)

        const abort = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/abort`, {
              method: "POST",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect(abort.status).toBe(200)

        const list = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "GET",
              headers: { "x-opencode-directory": test.directory },
            }),
          ),
        )
        expect(list.status).toBe(200)
        expect((yield* Effect.promise(() => list.json())) as unknown[]).toHaveLength(1)
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

        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const body = {
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "queued" }],
        }

        for (let i = 0; i < 4; i++) {
          const res = yield* Effect.promise(() =>
            Promise.resolve(
              Server.Default().app.request(`/session/${session.id}/queue`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
              }),
            ),
          )
          expect(res.status).toBe(200)
        }

        const listed = yield* Effect.promise(() =>
          Promise.resolve(
            Server.Default().app.request(`/session/${session.id}/queue`, {
              method: "GET",
              headers,
            }),
          ),
        )
        expect(listed.status).toBe(200)
        expect((yield* Effect.promise(() => listed.json())) as unknown[]).toHaveLength(4)
      }),
    { git: true },
  )

})
