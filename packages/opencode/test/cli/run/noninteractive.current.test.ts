import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { resolveCurrentCommandSession, runCurrentCommandTurn } from "@/cli/cmd/run/noninteractive.current"
import type { FooterApi, StreamCommit } from "@/cli/cmd/run/types"

test("noninteractive commands use current events and command APIs end to end", async () => {
  const requests: Request[] = []
  const commits: StreamCommit[] = []
  let sessionEvents: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      requests.push(request.clone())
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/history")) return Response.json({ data: [], hasMore: false })
      if (pathname.endsWith("/context")) return Response.json({ data: [] })
      if (pathname.endsWith("/permission") || pathname.endsWith("/question")) return Response.json({ data: [] })
      if (pathname === "/api/event")
        return new Response("", { headers: { "content-type": "text/event-stream" } })
      if (pathname.endsWith("/event")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sessionEvents = controller
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (pathname.endsWith("/active")) return Response.json({ data: {} })
      if (pathname.endsWith("/command")) {
        sessionEvents?.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: "evt_text",
              type: "session.next.text.ended",
              durable: { aggregateID: "ses_test", seq: 1, version: 1 },
              data: {
                timestamp: 1,
                sessionID: "ses_test",
                assistantMessageID: "msg_assistant",
                textID: "text",
                text: "command result",
              },
            })}\n\n`,
          ),
        )
        sessionEvents?.close()
        return Response.json({
          data: {
            id: "msg_command",
            sessionID: "ses_test",
            prompt: { text: "expanded" },
            delivery: "steer",
            timeCreated: 1,
            promotedSeq: 1,
          },
        })
      }
      throw new Error(`Unexpected request: ${request.method} ${pathname}`)
    },
    { preconnect() {} },
  )
  const footer: FooterApi = {
    isClosed: false,
    onPrompt: () => () => {},
    onClose: () => () => {},
    event() {},
    append(commit) {
      commits.push(commit)
    },
    idle: () => Promise.resolve(),
    close() {},
    destroy() {},
  }

  await runCurrentCommandTurn({
    client: OpenCode.make({ baseUrl: "http://opencode.test", fetch }),
    footer,
    sessionID: "ses_test",
    agent: "review",
    model: { providerID: "openai", modelID: "gpt-5" },
    variant: "high",
    command: "deploy",
    arguments: "staging",
    parts: [{ type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/plain" }],
    permissions: [{ permission: "bash", pattern: "*", action: "deny" }],
    thinking: true,
  })

  const command = requests.find((request) => new URL(request.url).pathname.endsWith("/command"))
  const body = command && (await command.json())
  expect(body.id).toMatch(/^msg_/)
  expect(body).toEqual({
    id: body.id,
    name: "deploy",
    arguments: "staging",
    payload: {
      version: 1,
      agent: "review",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" }],
      parts: [
        { type: "text", text: "staging" },
        { type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/plain" },
      ],
    },
    delivery: "steer",
  })
  expect(commits).toContainEqual({
    kind: "assistant",
    source: "assistant",
    messageID: "msg_assistant",
    partID: "text",
    text: "command result",
    phase: "progress",
  })
  expect(requests.some((request) => new URL(request.url).pathname.startsWith("/session/"))).toBe(false)
})

test("noninteractive commands resolve continued sessions through the current session catalog", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://opencode.test",
    fetch: Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init)
        requests.push(request.clone())
        return Response.json({
          data: [
            {
              id: "ses_child",
              parentID: "ses_parent",
              projectID: "project",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 2, updated: 2 },
              title: "child",
              location: { directory: "/repo" },
            },
            {
              id: "ses_parent",
              projectID: "project",
              agent: "build",
              model: { providerID: "openai", id: "gpt-5" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
              title: "parent",
              location: { directory: "/repo" },
            },
          ],
          cursor: {},
        })
      },
      { preconnect() {} },
    ),
  })

  const session = await resolveCurrentCommandSession({
    client,
    directory: "/repo",
    continue: true,
  })

  expect(session.id).toBe("ses_parent")
  const request = requests[0]
  expect(request.method).toBe("GET")
  expect(new URL(request.url).pathname).toBe("/api/session")
  expect(new URL(request.url).searchParams.get("directory")).toBe("/repo")
})

test("noninteractive commands fork and title sessions through current session APIs", async () => {
  const requests: Request[] = []
  const client = OpenCode.make({
    baseUrl: "http://opencode.test",
    fetch: Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init)
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/fork")) {
          return Response.json({
            data: {
              id: "ses_fork",
              parentID: "ses_parent",
              projectID: "project",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 2, updated: 2 },
              title: "parent",
              location: { directory: "/repo" },
            },
          })
        }
        if (request.method === "PATCH") {
          return Response.json({
            data: {
              id: "ses_fork",
              parentID: "ses_parent",
              projectID: "project",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 2, updated: 3 },
              title: "renamed fork",
              location: { directory: "/repo" },
            },
          })
        }
        throw new Error(`Unexpected request: ${request.method} ${pathname}`)
      },
      { preconnect() {} },
    ),
  })

  const session = await resolveCurrentCommandSession({
    client,
    directory: "/repo",
    sessionID: "ses_parent",
    fork: true,
    title: "renamed fork",
  })

  expect(session.id).toBe("ses_fork")
  expect(session.title).toBe("renamed fork")
  expect(
    requests.map((request) => ({
      method: request.method,
      pathname: new URL(request.url).pathname,
    })),
  ).toEqual([
    { method: "POST", pathname: "/api/session/ses_parent/fork" },
    { method: "PATCH", pathname: "/api/session/ses_fork" },
  ])
  expect(await requests[1].json()).toEqual({ title: "renamed fork" })
})
