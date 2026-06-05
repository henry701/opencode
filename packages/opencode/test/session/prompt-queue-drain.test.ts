import { afterEach, describe, expect, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionPromptQueue } from "@/session/prompt-queue"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Session } from "@/session/session"
import { httpApiLayer, requestInDirectory } from "../server/httpapi-layer"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const sample = (text: string) => ({
  version: 1 as const,
  agent: "build",
  model: ref,
  parts: [{ type: "text" as const, text }],
})

const queueLayer = Layer.mergeAll(Session.defaultLayer, SessionPromptQueue.defaultLayer)
const queueHttpLayer = Layer.mergeAll(queueLayer, httpApiLayer)

const itService = testEffect(queueLayer)
const itHttp = testEffect(Layer.mergeAll(SessionNs.defaultLayer, httpApiLayer))
const itHttpWithQueue = testEffect(queueHttpLayer)

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
})

describe("SessionPromptQueue drain pause (service)", () => {
  itService.instance("starts unpaused for a new session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      expect(yield* promptQueue.drainPaused(chat.id)).toBe(false)
    }),
  )

  itService.instance("pauseDrain is idempotent", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      yield* promptQueue.pauseDrain(chat.id)
      yield* promptQueue.pauseDrain(chat.id)
      expect(yield* promptQueue.drainPaused(chat.id)).toBe(true)
    }),
  )

  itService.instance("resumeDrain is idempotent when never paused", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      yield* promptQueue.resumeDrain(chat.id)
      yield* promptQueue.resumeDrain(chat.id)
      expect(yield* promptQueue.drainPaused(chat.id)).toBe(false)
    }),
  )

  itService.instance("pause and resume are isolated per session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const a = yield* sessions.create({ title: "a" })
      const b = yield* sessions.create({ title: "b" })
      yield* promptQueue.pauseDrain(a.id)
      expect(yield* promptQueue.drainPaused(a.id)).toBe(true)
      expect(yield* promptQueue.drainPaused(b.id)).toBe(false)
      yield* promptQueue.resumeDrain(a.id)
      expect(yield* promptQueue.drainPaused(a.id)).toBe(false)
      expect(yield* promptQueue.drainPaused(b.id)).toBe(false)
    }),
  )

  itService.instance("clear resets pause state but keeps sqlite queue until cleared", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      yield* promptQueue.enqueue(chat.id, sample("one"))
      yield* promptQueue.pauseDrain(chat.id)
      yield* promptQueue.clear(chat.id)
      expect(yield* promptQueue.drainPaused(chat.id)).toBe(false)
      expect(yield* promptQueue.peek(chat.id)).toBeUndefined()
    }),
  )

  itService.instance("pause does not remove or reorder queued items", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      const first = yield* promptQueue.enqueue(chat.id, sample("first"))
      const second = yield* promptQueue.enqueue(chat.id, sample("second"))
      yield* promptQueue.pauseDrain(chat.id)
      const items = yield* promptQueue.list(chat.id)
      expect(items.map((item) => item.id)).toEqual([first.id, second.id])
      const peek = yield* promptQueue.peek(chat.id)
      expect(peek?.id).toBe(first.id)
    }),
  )

  itService.instance("resumeDrain clears pause so later dequeues proceed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      yield* promptQueue.enqueue(chat.id, sample("head"))
      yield* promptQueue.pauseDrain(chat.id)
      expect(yield* promptQueue.dequeue(chat.id)).toBeDefined()
      yield* promptQueue.enqueue(chat.id, sample("tail"))
      yield* promptQueue.resumeDrain(chat.id)
      const head = yield* promptQueue.dequeue(chat.id)
      expect(head?.data.parts[0]?.type === "text" ? head.data.parts[0].text : "").toBe("tail")
    }),
  )

  itService.instance("enqueue update remove and manual dequeue work while paused", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const promptQueue = yield* SessionPromptQueue.Service
      const chat = yield* sessions.create({ title: "drain-pause" })
      const first = yield* promptQueue.enqueue(chat.id, sample("first"))
      yield* promptQueue.pauseDrain(chat.id)
      yield* promptQueue.enqueue(chat.id, sample("third"))
      yield* promptQueue.update(chat.id, first.id, sample("first-edited"))
      const items = yield* promptQueue.list(chat.id)
      expect(items).toHaveLength(2)
      const peekText = items[0]?.data.parts[0]?.type === "text" ? items[0].data.parts[0].text : ""
      expect(peekText).toBe("first-edited")
      const dequeued = yield* promptQueue.dequeue(chat.id)
      expect(dequeued?.data.parts[0]?.type === "text" ? dequeued.data.parts[0].text : "").toBe("first-edited")
      expect(yield* promptQueue.drainPaused(chat.id)).toBe(true)
      yield* promptQueue.remove(chat.id, items[1]!.id)
      expect(yield* promptQueue.peek(chat.id)).toBeUndefined()
    }),
  )
})

describe("session queue drain pause (http)", () => {
  const headers = {
    "content-type": "application/json",
  }

  itHttp.instance(
    "pause and resume return true for an existing session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const pause = yield* requestInDirectory(`/session/${session.id}/queue/drain-pause`, test.directory, {
          method: "POST",
        })
        expect(pause.status).toBe(200)
        expect(yield* pause.json).toBe(true)

        const resume = yield* requestInDirectory(`/session/${session.id}/queue/drain-resume`, test.directory, {
          method: "POST",
        })
        expect(resume.status).toBe(200)
        expect(yield* resume.json).toBe(true)
      }),
    { git: true },
  )

  itHttp.instance(
    "pause returns 404 for an unknown session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const res = yield* requestInDirectory(`/session/ses_missing/queue/drain-pause`, test.directory, {
          method: "POST",
        })
        expect(res.status).toBe(404)
      }),
    { git: true },
  )

  itHttp.instance(
    "queued items remain listed after pause",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const body = {
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text: "hold in queue" }],
        }

        const enqueue = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
        expect(enqueue.status).toBe(200)

        const pause = yield* requestInDirectory(`/session/${session.id}/queue/drain-pause`, test.directory, {
          method: "POST",
        })
        expect(pause.status).toBe(200)

        const list = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        const items = (yield* list.json) as { text: string }[]
        expect(items).toHaveLength(1)
        expect(items[0]?.text).toBe("hold in queue")
      }),
    { git: true },
  )

  itHttpWithQueue.instance(
    "http pause is visible to another queue service layer for the same instance",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const promptQueue = yield* SessionPromptQueue.Service
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )

        const pause = yield* requestInDirectory(`/session/${session.id}/queue/drain-pause`, test.directory, {
          method: "POST",
        })

        expect(pause.status).toBe(200)
        expect(yield* promptQueue.drainPaused(session.id)).toBe(true)
      }),
    { git: true },
  )

  itHttp.instance(
    "enqueue while paused appends without resuming drain",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Effect.acquireRelease(SessionNs.use.create({}), (created) =>
          SessionNs.use.remove(created.id).pipe(Effect.ignore),
        )
        const body = (text: string) => ({
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-4" },
          parts: [{ type: "text", text }],
        })

        yield* requestInDirectory(`/session/${session.id}/queue/drain-pause`, test.directory, { method: "POST" })

        yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(body("one")),
        })

        yield* requestInDirectory(`/session/${session.id}/queue`, test.directory, {
          method: "POST",
          headers,
          body: JSON.stringify(body("two")),
        })

        const list = yield* requestInDirectory(`/session/${session.id}/queue`, test.directory)
        const items = (yield* list.json) as { text: string }[]
        expect(items.map((item) => item.text)).toEqual(["one", "two"])
      }),
    { git: true },
  )
})
