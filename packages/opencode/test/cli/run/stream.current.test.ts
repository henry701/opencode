import { describe, expect, test } from "bun:test"
import type { EventsSubscribeOutput, SessionsContextOutput, SessionsEventsOutput } from "@opencode-ai/client"
import { OpenCode } from "@opencode-ai/client"
import {
  createCurrentSessionTransport,
  currentEventCommits,
  currentFooterEvent,
  currentMessageCommits,
} from "@/cli/cmd/run/stream.current"
import type { FooterApi, FooterEvent, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"

function footer() {
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []
  const api: FooterApi = {
    isClosed: false,
    onPrompt: () => () => {},
    onClose: () => () => {},
    event: (event) => events.push(event),
    append: (commit) => commits.push(commit),
    idle: () => Promise.resolve(),
    close() {},
    destroy() {},
  }
  return { api, events, commits }
}

describe("current interactive session presentation", () => {
  test("projects current context without legacy message or part shapes", () => {
    const message = {
      id: "msg_assistant",
      type: "assistant",
      agent: "build",
      model: { providerID: "test", id: "model", variant: "careful" },
      content: [
        { type: "reasoning", id: "reasoning", text: "check first" },
        { type: "text", id: "text", text: "done" },
        {
          type: "tool",
          id: "call",
          name: "read",
          state: {
            status: "completed",
            input: { filePath: "/tmp/a.ts" },
            structured: {},
            content: [{ type: "text", text: "contents" }],
          },
          time: { created: 1, completed: 2 },
        },
      ],
      time: { created: 1, completed: 2 },
    } satisfies SessionsContextOutput[number]

    expect(currentMessageCommits(message, true)).toEqual([
      {
        kind: "reasoning",
        source: "reasoning",
        messageID: "msg_assistant",
        partID: "reasoning",
        text: "",
        phase: "start",
      },
      {
        kind: "reasoning",
        source: "reasoning",
        messageID: "msg_assistant",
        partID: "reasoning",
        text: "check first",
        phase: "progress",
      },
      {
        kind: "reasoning",
        source: "reasoning",
        messageID: "msg_assistant",
        partID: "reasoning",
        text: "",
        phase: "final",
      },
      {
        kind: "assistant",
        source: "assistant",
        messageID: "msg_assistant",
        partID: "text",
        text: "",
        phase: "start",
      },
      {
        kind: "assistant",
        source: "assistant",
        messageID: "msg_assistant",
        partID: "text",
        text: "done",
        phase: "progress",
      },
      {
        kind: "assistant",
        source: "assistant",
        messageID: "msg_assistant",
        partID: "text",
        text: "",
        phase: "final",
      },
      {
        kind: "tool",
        source: "tool",
        messageID: "msg_assistant",
        partID: "call",
        tool: "read",
        text: "running read",
        phase: "start",
        toolState: "running",
      },
      {
        kind: "tool",
        source: "tool",
        messageID: "msg_assistant",
        partID: "call",
        tool: "read",
        text: "contents",
        phase: "progress",
        toolState: "completed",
      },
    ])
  })

  test("projects durable current events and keeps prepared context out of transcript text", () => {
    const event = {
      id: "evt_step",
      type: "session.next.step.started",
      durable: { aggregateID: "ses_test", seq: 3, version: 1 },
      data: {
        timestamp: 1,
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        systemPrompt: "private prepared system",
        toolDefinitions: '{"read":{"description":"read"}}',
      },
    } satisfies SessionsEventsOutput

    expect(currentEventCommits(event, true)).toEqual([])
    expect(
      currentEventCommits(
        {
          id: "evt_text",
          type: "session.next.text.ended",
          durable: { aggregateID: "ses_test", seq: 4, version: 1 },
          data: {
            timestamp: 2,
            sessionID: "ses_test",
            assistantMessageID: "msg_assistant",
            textID: "text",
            text: "answer",
          },
        },
        true,
      ),
    ).toEqual([
      {
        kind: "assistant",
        source: "assistant",
        messageID: "msg_assistant",
        partID: "text",
        text: "answer",
        phase: "progress",
      },
      {
        kind: "assistant",
        source: "assistant",
        messageID: "msg_assistant",
        partID: "text",
        text: "",
        phase: "final",
      },
    ])
  })

  test("routes current global blockers without legacy permission or question events", () => {
    const permission = {
      id: "evt_permission",
      type: "permission.v2.asked",
      data: {
        id: "per_test",
        sessionID: "ses_test",
        action: "bash",
        resources: ["git status"],
        save: ["git *"],
        metadata: { command: "git status" },
      },
    } satisfies EventsSubscribeOutput
    expect(currentFooterEvent(permission, "ses_test")).toEqual({
      type: "stream.view",
      view: { type: "permission", request: permission.data },
    })
    expect(currentFooterEvent(permission, "ses_other")).toBeUndefined()
    expect(
      currentFooterEvent(
        {
          id: "evt_replied",
          type: "permission.v2.replied",
          data: { sessionID: "ses_test", requestID: "per_test", reply: "once" },
        },
        "ses_test",
      ),
    ).toEqual({ type: "stream.view", view: { type: "prompt" } })
  })

  test("submits normal turns through current sessions.prompt with the complete payload", async () => {
    const requests: Request[] = []
    const fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init)
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/history")) {
          return Response.json({ data: [], hasMore: false })
        }
        if (pathname.endsWith("/context")) {
          return Response.json({ data: [] })
        }
        if (pathname.endsWith("/permission") || pathname.endsWith("/question")) {
          return Response.json({ data: [] })
        }
        if (pathname.endsWith("/event")) {
          return new Response("", { headers: { "content-type": "text/event-stream" } })
        }
        if (pathname.endsWith("/active")) {
          return Response.json({ data: {} })
        }
        if (pathname.endsWith("/prompt")) {
          return Response.json({
            data: {
              admittedSeq: 1,
              id: "msg_prompt",
              sessionID: "ses_test",
              prompt: { text: "hello" },
              delivery: "steer",
              timeCreated: 1,
              promotedSeq: 2,
            },
          })
        }
        throw new Error(`Unexpected request: ${request.method} ${pathname}`)
      },
      { preconnect() {} },
    )
    const ui = footer()
    const transport = await createCurrentSessionTransport({
      client: OpenCode.make({ baseUrl: "http://opencode.test", fetch }),
      sessionID: "ses_test",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const prompt = {
      text: "hello",
      parts: [{ type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" }],
    } satisfies RunPrompt

    await transport.runPromptTurn({
      agent: "review",
      model: { providerID: "test", modelID: "model" },
      variant: "careful",
      prompt,
      files: [],
      includeFiles: true,
    })
    await transport.close()

    const request = requests.find((item) => new URL(item.url).pathname.endsWith("/prompt"))
    const body = request && (await request.json())
    expect(body.id).toMatch(/^msg_/)
    expect(body).toEqual({
      id: body.id,
      payload: {
        version: 1,
        agent: "review",
        model: { providerID: "test", modelID: "model", variant: "careful" },
        parts: [
          { type: "text", text: "hello" },
          { type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" },
        ],
      },
      delivery: "steer",
    })
  })

  test("submits commands with a generated retry id and preserves complete payload controls", async () => {
    const requests: Request[] = []
    const fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const request = new Request(url, init)
        requests.push(request.clone())
        const pathname = new URL(request.url).pathname
        if (pathname.endsWith("/history")) return Response.json({ data: [], hasMore: false })
        if (pathname.endsWith("/context")) return Response.json({ data: [] })
        if (pathname.endsWith("/permission") || pathname.endsWith("/question")) return Response.json({ data: [] })
        if (pathname.endsWith("/event"))
          return new Response("", { headers: { "content-type": "text/event-stream" } })
        if (pathname.endsWith("/active")) return Response.json({ data: {} })
        if (pathname.endsWith("/command")) {
          return Response.json({
            data: {
              id: "msg_command",
              sessionID: "ses_test",
              prompt: { text: "expanded" },
              delivery: "steer",
              timeCreated: 1,
              promotedSeq: 2,
            },
          })
        }
        throw new Error(`Unexpected request: ${request.method} ${pathname}`)
      },
      { preconnect() {} },
    )
    const ui = footer()
    const transport = await createCurrentSessionTransport({
      client: OpenCode.make({ baseUrl: "http://opencode.test", fetch }),
      sessionID: "ses_test",
      thinking: true,
      limits: () => ({}),
      footer: ui.api,
    })
    const payload = {
      version: 1 as const,
      agent: "review",
      model: { providerID: "test", modelID: "model", variant: "careful" },
      tools: { bash: false },
      system: "command system",
      format: { type: "text" as const },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" as const }],
      parts: [
        { type: "text" as const, text: "/deploy staging" },
        { type: "text" as const, text: "hidden", ignored: true },
        { type: "file" as const, url: "file:///tmp/a.ts", mime: "text/plain" },
      ],
    }

    await transport.runPromptTurn({
      agent: "ignored",
      model: { providerID: "ignored", modelID: "ignored" },
      variant: undefined,
      prompt: {
        text: "/deploy staging",
        parts: [],
        command: { name: "deploy", arguments: "staging" },
        queuePayload: payload,
      },
      files: [],
      includeFiles: true,
    })
    await transport.close()

    const request = requests.find((item) => new URL(item.url).pathname.endsWith("/command"))
    const body = request && (await request.json())
    expect(body.id).toMatch(/^msg_/)
    expect(body).toEqual({
      id: body.id,
      name: "deploy",
      arguments: "staging",
      payload,
      delivery: "steer",
    })
  })
})
