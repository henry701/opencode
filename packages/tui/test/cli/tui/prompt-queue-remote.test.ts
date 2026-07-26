import { describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import {
  parseRegisteredCommand,
  queueEventSessionID,
  queuedPromptPreviews,
  reviseQueuedPayload,
  submitQueuedPayload,
} from "../../../src/queue/remote"

describe("typed prompt queue state", () => {
  test("builds previews from durable queued input payloads", () => {
    expect(
      queuedPromptPreviews([
        {
          id: "pqu_text",
          sessionID: "ses_1",
          position: 0,
          timeCreated: 1,
          payload: {
            version: 1,
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5" },
            parts: [
              { type: "text", text: "first", synthetic: true },
              { type: "text", text: "visible" },
              { type: "text", text: "ignored", ignored: true },
            ],
          },
        },
        {
          id: "pqu_file",
          sessionID: "ses_1",
          position: 1,
          timeCreated: 2,
          payload: {
            version: 1,
            agent: "build",
            model: { providerID: "openai", modelID: "gpt-5" },
            parts: [{ type: "file", mime: "text/plain", url: "file:///tmp/input.txt" }],
          },
        },
      ]),
    ).toEqual([
      { id: "pqu_text", text: "visible" },
      { id: "pqu_file", text: "[attachment]" },
    ])
  })

  test("revises only model-visible text and preserves the complete queued payload", () => {
    const payload = {
      version: 1 as const,
      agent: "review",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      tools: { bash: false, read: true },
      system: "Queue-specific system prompt",
      format: { type: "json_schema" as const, schema: { type: "object" }, retryCount: 2 },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" as const }],
      parts: [
        { id: "visible-1", type: "text" as const, text: "old first", metadata: { source: "user" } },
        { id: "synthetic-1", type: "text" as const, text: "keep synthetic", synthetic: true },
        { id: "ignored-1", type: "text" as const, text: "keep ignored", ignored: true },
        { id: "visible-2", type: "text" as const, text: "old second" },
        {
          id: "file-1",
          type: "file" as const,
          mime: "text/plain",
          filename: "context.txt",
          url: "file:///tmp/context.txt",
        },
        {
          id: "subtask-1",
          type: "subtask" as const,
          prompt: "delegate",
          description: "keep subtask",
          agent: "review",
        },
      ],
    }

    expect(reviseQueuedPayload(payload, "edited visible text")).toEqual({
      ...payload,
      parts: [
        { id: "visible-1", type: "text", text: "edited visible text", metadata: { source: "user" } },
        { id: "synthetic-1", type: "text", text: "keep synthetic", synthetic: true },
        { id: "ignored-1", type: "text", text: "keep ignored", ignored: true },
        { id: "visible-2", type: "text", text: "" },
        payload.parts[4],
        payload.parts[5],
      ],
    })
  })

  test("invalidates only queue-changing durable prompt lifecycle events", () => {
    for (const type of [
      "session.next.prompt.revised",
      "session.next.prompt.discarded",
      "session.next.prompt.expedited",
    ]) {
      expect(queueEventSessionID({ type, properties: { sessionID: "ses_1" } })).toBe("ses_1")
    }
    expect(
      queueEventSessionID({
        type: "session.next.prompt.admitted",
        properties: { sessionID: "ses_1", delivery: "queue" },
      }),
    ).toBe("ses_1")
    expect(
      queueEventSessionID({
        type: "session.next.prompted",
        properties: { sessionID: "ses_1", delivery: "queue" },
      }),
    ).toBe("ses_1")
    expect(
      queueEventSessionID({
        type: "session.next.prompt.admitted",
        properties: { sessionID: "ses_1", delivery: "steer" },
      }),
    ).toBeUndefined()
  })

  test("parses only commands from the native location catalog and preserves multiline arguments", () => {
    const commands = [{ name: "deploy", template: "deploy $ARGUMENTS" }]

    expect(parseRegisteredCommand("/deploy staging\nwith checks", commands)).toEqual({
      name: "deploy",
      arguments: "staging\nwith checks",
    })
    expect(parseRegisteredCommand("/missing staging", commands)).toBeUndefined()
  })

  test("queues recognized slash commands through sessions.command with a stable id and full payload", async () => {
    const requests: Request[] = []
    const client = OpenCode.make({
      baseUrl: "http://opencode.test",
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          const request = new Request(url, init)
          requests.push(request.clone())
          return Response.json({
            data: {
              id: "msg_tui",
              sessionID: "ses_1",
              prompt: { text: "expanded" },
              delivery: "queue",
              timeCreated: 1,
            },
          })
        },
        { preconnect() {} },
      ),
    })
    const payload = {
      version: 1 as const,
      agent: "review",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      tools: { bash: false },
      system: "queued system",
      format: { type: "text" as const },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" as const }],
      parts: [
        { type: "text" as const, text: "/deploy staging" },
        { type: "text" as const, text: "hidden", ignored: true },
        { type: "file" as const, url: "file:///tmp/a.ts", mime: "text/plain" },
      ],
    }

    await submitQueuedPayload({
      client,
      sessionID: "ses_1",
      id: "msg_tui",
      payload,
      command: { name: "deploy", arguments: "staging" },
    })

    const request = requests[0]
    expect(new URL(request!.url).pathname).toBe("/api/session/ses_1/command")
    expect(await request!.json()).toEqual({
      id: "msg_tui",
      name: "deploy",
      arguments: "staging",
      payload,
      delivery: "queue",
    })
  })
})
