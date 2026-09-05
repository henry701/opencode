import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    currentPageMessages: () => {
      events.push("page")
      return { items: [], throughSeq: 0 }
    },
  })

  const response = handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/api/session/session/message" }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})

test("V2 fixtures preserve configured reasoning variants and custom agents", async () => {
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: typeof handler) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    directory: "/fixture",
    project: {},
    sessions: [],
    provider: {
      all: [{ id: "test", models: { muse: { id: "muse", variants: { high: { reasoningEffort: "high" } } } } }],
      connected: ["test"],
      default: { providerID: "test", modelID: "muse" },
    },
    agents: [{ name: "reviewer", mode: "primary" }],
  })
  const request = async (path: string) => {
    let body = ""
    await handler!({
      request: () => ({ url: () => `http://127.0.0.1:4096${path}`, method: () => "GET" }),
      fulfill: (response: { body: string }) => {
        body = response.body
        return Promise.resolve()
      },
    } as unknown as Route)
    return JSON.parse(body)
  }
  expect((await request("/api/model")).data[0].variants).toEqual([
    { id: "high", settings: { reasoningEffort: "high" }, headers: {}, body: {} },
  ])
  expect((await request("/api/agent")).data[0].id).toBe("reviewer")
})
