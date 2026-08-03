import { describe, expect, test } from "bun:test"
import type { MessagesListOutput, SessionsEventsOutput, SessionsGetOutput } from "@/utils/current-client"
import { createRoot } from "solid-js"
import { createCurrentSessionModel, type CurrentSessionPort } from "./model"

const session: SessionsGetOutput = {
  id: "ses_test",
  projectID: "prj_test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  title: "Test",
  location: { directory: "/tmp/project" },
}

const prompted = (seq: number) =>
  ({
    id: `evt_${seq}`,
    type: "session.next.prompted",
    durable: { aggregateID: "ses_test", seq, version: 1 },
    data: {
      timestamp: seq,
      sessionID: "ses_test",
      messageID: `msg_${seq}`,
      prompt: { text: "queued" },
      delivery: "queue",
    },
  }) as const

const messages = (
  items: Array<{ id: string; text: string; created: number }>,
  next?: string,
  throughSeq = 0,
): MessagesListOutput => ({
  data: items.map((item) => ({
    id: item.id,
    type: "user",
    text: item.text,
    time: { created: item.created },
  })),
  throughSeq,
  cursor: { next },
})

function controlledEvents(event?: SessionsEventsOutput) {
  return async function* (_input: { sessionID: string; after?: number }, options?: { signal?: AbortSignal }) {
    if (event) yield event
    await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
  }
}

function makePort(input?: {
  events?: SessionsEventsOutput
  pages?: MessagesListOutput[]
  queueList?: () => Promise<[]>
}) {
  const pages = [...(input?.pages ?? [messages([])])]
  return {
    sessions: {
      get: async () => session,
      active: async () => ({}),
      events: controlledEvents(input?.events),
      queueList: input?.queueList ?? (async () => []),
    },
    messages: {
      list: async () => pages.shift() ?? messages([]),
    },
  } satisfies CurrentSessionPort
}

describe("current session model", () => {
  test("buffers SSE during hydration and refreshes server-authoritative queue state", async () => {
    let queueReads = 0
    const event = prompted(4)
    const port = makePort({
      events: event,
      pages: [messages([{ id: "msg_1", text: "existing", created: 1 }], undefined, 3), messages([])],
      queueList: async () => {
        queueReads++
        return []
      },
    })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const model = createCurrentSessionModel({
          sessionID: () => "ses_test",
          client: () => port,
          autoStart: false,
          reconnectDelayMs: 1,
        })
        model
          .start()
          .then(() => {
            expect(model.readiness()).toBe("ready")
            expect(model.lastEventSequence()).toBe(4)
            expect(model.messages().map((message) => String(message.id))).toContain("msg_4")
            expect(queueReads).toBeGreaterThanOrEqual(2)
            model.dispose()
            dispose()
            resolve()
          })
          .catch(reject)
      })
    })
  })

  test("loads older pages in chronological order", async () => {
    const port = makePort({
      pages: [
        messages(
          [
            { id: "msg_3", text: "newest", created: 3 },
            { id: "msg_2", text: "new", created: 2 },
          ],
          "older",
          3,
        ),
        messages([{ id: "msg_1", text: "old", created: 1 }]),
      ],
    })

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const model = createCurrentSessionModel({
          sessionID: () => "ses_test",
          client: () => port,
          autoStart: false,
        })
        model
          .start()
          .then(() => model.loadOlder())
          .then(() => {
            expect(model.messages().map((message) => String(message.id))).toEqual(["msg_1", "msg_2", "msg_3"])
            expect(model.hasOlder()).toBe(false)
            model.dispose()
            dispose()
            resolve()
          })
          .catch(reject)
      })
    })
  })

  test("reconnects after the last observed durable sequence", async () => {
    const base = makePort({ pages: [messages([], undefined, 0)] })
    const after: Array<number | undefined> = []
    let attempt = 0
    const port = {
      ...base,
      sessions: {
        ...base.sessions,
        events(input: { sessionID: string; after?: number }, options?: { signal?: AbortSignal }) {
          after.push(input.after)
          const event = prompted(++attempt)
          return (async function* () {
            yield event
            if (attempt === 1) return
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            )
          })()
        },
      },
    } satisfies CurrentSessionPort

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const model = createCurrentSessionModel({
          sessionID: () => "ses_test",
          client: () => port,
          autoStart: false,
          reconnectDelayMs: 1,
        })
        model
          .start()
          .then(() => until(() => model.lastEventSequence() === 2))
          .then(() => {
            expect(after.slice(0, 2)).toEqual([0, 1])
            expect(model.connection()).toBe("open")
            model.dispose()
            dispose()
            resolve()
          })
          .catch(reject)
      })
    })
  })

  test("refreshes context during manual refresh", async () => {
    let contextReads = 0
    const base = makePort({ pages: [messages([], undefined, 0), messages([])] })
    const port = {
      ...base,
      sessions: {
        ...base.sessions,
        context: async () => {
          contextReads++
          return [
            {
              id: "msg_context",
              type: "user" as const,
              text: "context",
              time: { created: 1 },
            },
          ]
        },
      },
    } satisfies CurrentSessionPort

    await new Promise<void>((resolve, reject) => {
      createRoot((dispose) => {
        const model = createCurrentSessionModel({
          sessionID: () => "ses_test",
          client: () => port,
          autoStart: false,
        })
        model
          .start()
          .then(() => model.refresh())
          .then(() => {
            expect(contextReads).toBe(2)
            expect(model.context().map((message) => String(message.id))).toEqual(["msg_context"])
            model.dispose()
            dispose()
            resolve()
          })
          .catch(reject)
      })
    })
  })
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for current session model")
    await Bun.sleep(1)
  }
}
