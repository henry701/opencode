import { describe, expect, test } from "bun:test"
import {
  buildQueuePromptPayload,
  buildQueueSendPayload,
  enqueueRemotePrompt,
  loadCurrentCommandCatalog,
  queueEventSessionID,
  queuedPromptPreviews,
  runPromptFromQueueDetail,
} from "@/cli/cmd/run/runtime.queue-remote"
import { OpenCode } from "@opencode-ai/client"
import { ModelID, ProviderID } from "@/provider/schema"

describe("run remote queue payloads", () => {
  test("enqueue and update payloads use the typed SessionInput payload", () => {
    expect(
      buildQueuePromptPayload({
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "minimal",
        prompt: {
          text: "queued",
          parts: [{ type: "text", text: "context" }],
        },
      }),
    ).toEqual({
      version: 1,
      agent: "build",
      model: { providerID: "test", modelID: "test-model", variant: "minimal" },
      parts: [
        { type: "text", text: "queued" },
        { type: "text", text: "context" },
      ],
    })
  })

  test("edited send-now uses the typed SessionInput payload", () => {
    expect(
      buildQueueSendPayload({
        agent: "plan",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "fast",
        prompt: {
          text: "edited",
          parts: [{ type: "text", text: "extra" }],
          queueID: "pqu_test",
        },
      }),
    ).toEqual({
      version: 1,
      agent: "plan",
      model: { providerID: "test", modelID: "test-model", variant: "fast" },
      parts: [
        { type: "text", text: "edited" },
        { type: "text", text: "extra" },
      ],
    })
  })

  test("omits the payload for unedited send-now so the server uses stored queue data", () => {
    expect(
      buildQueueSendPayload({
        agent: "plan",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "fast",
      }),
    ).toBeUndefined()
  })

  test("queued input conversion preserves full text and attachments for editing", () => {
    const payload = {
      version: 1,
      agent: "build",
      model: { providerID: "test", modelID: "test-model", variant: "careful" },
      tools: { write: false },
      system: "Keep the original controls",
      format: { type: "text" },
      permissions: [{ permission: "read", pattern: "*", action: "allow" }],
      parts: [
        { id: "part_one", type: "text", text: "line one", metadata: { source: "first" } },
        { id: "part_two", type: "text", text: "line two" },
        { id: "part_synthetic", type: "text", text: "Attached media from tool result:", synthetic: true },
        { type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" },
      ],
    } as const
    const prompt = runPromptFromQueueDetail({ id: "pqu_full", payload })

    expect(prompt).toEqual({
      text: "line one\nline two",
      parts: [{ type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" }],
      queueID: "pqu_full",
      queuePayload: payload,
      queued: true,
    })
    expect(
      buildQueuePromptPayload({
        agent: "plan",
        model: { providerID: ProviderID.make("other"), modelID: ModelID.make("other-model") },
        variant: "fast",
        prompt: { ...prompt, text: "edited" },
      }),
    ).toEqual({
      ...payload,
      parts: [
        { id: "part_one", type: "text", text: "edited", metadata: { source: "first" } },
        { id: "part_two", type: "text", text: "" },
        { id: "part_synthetic", type: "text", text: "Attached media from tool result:", synthetic: true },
        { type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" },
      ],
    })
  })

  test("refreshes previews for typed queue lifecycle events", () => {
    expect(
      queuedPromptPreviews([
        {
          id: "pqu_full",
          sessionID: "ses_1",
          position: 0,
          timeCreated: 1,
          payload: {
            version: 1,
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "queued" }],
          },
        },
      ]),
    ).toEqual([{ id: "pqu_full", text: "queued" }])

    for (const type of [
      "session.next.prompt.revised",
      "session.next.prompt.discarded",
      "session.next.prompt.expedited",
    ]) {
      expect(queueEventSessionID({ type, properties: { sessionID: "ses_1" } })).toBe("ses_1")
    }
    expect(
      queueEventSessionID({
        type: "session.next.prompted",
        properties: { sessionID: "ses_1", delivery: "queue" },
      }),
    ).toBe("ses_1")
  })

  test("queues recognized commands through the native command endpoint with an id and complete payload", async () => {
    const requests: Request[] = []
    const client = OpenCode.make({
      baseUrl: "http://opencode.test",
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          const request = new Request(url, init)
          requests.push(request.clone())
          return Response.json({
            data: {
              id: "msg_command",
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
      system: "queued command system",
      format: { type: "text" as const },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" as const }],
      parts: [
        { type: "text" as const, text: "/deploy staging" },
        { type: "text" as const, text: "hidden", ignored: true },
        { type: "file" as const, url: "file:///tmp/a.ts", mime: "text/plain" },
      ],
    }

    await enqueueRemotePrompt({
      client,
      sessionID: "ses_1",
      id: "msg_command",
      prompt: {
        messageID: "msg_command",
        text: "/deploy staging",
        parts: [],
        command: { name: "deploy", arguments: "staging" },
      },
      payload,
    })

    const request = requests[0]
    expect(new URL(request!.url).pathname).toBe("/api/session/ses_1/command")
    expect(await request!.json()).toEqual({
      id: "msg_command",
      name: "deploy",
      arguments: "staging",
      payload,
      delivery: "queue",
    })
  })

  test("loads the active command catalog from the current location endpoint", async () => {
    const requests: Request[] = []
    const client = OpenCode.make({
      baseUrl: "http://opencode.test",
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          const request = new Request(url, init)
          requests.push(request.clone())
          return Response.json({
            location: {
              directory: "/workspace",
              project: { id: "project", directory: "/workspace" },
            },
            data: [{ name: "deploy", template: "deploy $ARGUMENTS", description: "Deploy" }],
          })
        },
        { preconnect() {} },
      ),
    })

    expect(await loadCurrentCommandCatalog(client, "/workspace")).toEqual([
      { name: "deploy", template: "deploy $ARGUMENTS", description: "Deploy" },
    ])
    expect(new URL(requests[0]!.url).pathname).toBe("/api/command")
    expect(new URL(requests[0]!.url).searchParams.get("location[directory]")).toBe("/workspace")
  })
})
