import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { normalizeCurrentSessionMessages, normalizeSessionMessages } from "./session-message"

const decodeCurrentMessage = Schema.decodeUnknownSync(SessionMessage.Message)

describe("normalizeSessionMessages", () => {
  test("maps current task child identities for navigation without replacing legacy metadata", () => {
    for (const structured of [{ sessionID: "child" }, { sessionID: "child", sessionId: "legacy-child" }]) {
      const result = normalizeCurrentSessionMessages("parent", [
        decodeCurrentMessage({
          id: "msg_user",
          type: "user",
          text: "Delegate",
          files: [],
          agents: [],
          time: { created: 1 },
        }),
        decodeCurrentMessage({
          id: "msg_assistant",
          type: "assistant",
          agent: "build",
          model: { id: "model", providerID: "provider" },
          time: { created: 2, completed: 3 },
          content: [
            {
              id: "task",
              type: "tool",
              name: "task",
              time: { created: 2, completed: 3 },
              state: { status: "completed", input: { description: "Child task" }, structured, content: [] },
            },
          ],
        }),
      ])
      expect(result.parts.get("msg_assistant")).toMatchObject([
        { type: "tool", state: { metadata: { ...structured, sessionId: structured.sessionId ?? "child" } } },
      ])
    }
  })

  test("adapts current messages for the compatibility timeline", () => {
    const result = normalizeCurrentSessionMessages("ses_1", [
      decodeCurrentMessage({
        id: "msg_user",
        type: "user",
        text: "hello",
        files: [],
        agents: [],
        time: { created: 1 },
      }),
      decodeCurrentMessage({
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        systemPrompt: "prepared system",
        toolDefinitions: '[{"name":"read"}]',
        content: [
          { type: "text", id: "text", text: "world" },
          {
            type: "tool",
            id: "call_read",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              structured: {},
              content: [{ type: "text", text: "contents" }],
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
        time: { created: 2, completed: 4 },
      }),
    ])

    expect(result.source.map((message) => message.type)).toEqual(["user", "assistant"])
    expect(result.messages).toMatchObject([
      { id: "msg_user", role: "user" },
      {
        id: "msg_assistant",
        role: "assistant",
        parentID: "msg_user",
        systemPrompt: "prepared system",
        toolDefinitions: '[{"name":"read"}]',
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
      },
    ])
    expect(result.parts.get("msg_assistant")).toMatchObject([
      { type: "text", text: "world" },
      { type: "tool", callID: "call_read", state: { status: "completed", output: "contents" } },
    ])
  })

  test("keeps admitted model metadata authoritative across a provider switch", () => {
    const payload = {
      version: 1,
      agent: "plan",
      model: { providerID: "anthropic", modelID: "sonnet", variant: "high" },
      parts: [{ type: "text", text: "Admitted prompt" }],
    }
    const result = normalizeCurrentSessionMessages("ses_1", [
      decodeCurrentMessage({ id: "user", type: "user", text: "Admitted prompt", payload, time: { created: 1 } }),
      decodeCurrentMessage({
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt" },
        content: [],
        time: { created: 2, completed: 3 },
      }),
      decodeCurrentMessage({ id: "pending", type: "user", text: "Next prompt", payload, time: { created: 4 } }),
    ])
    expect(result.messages).toMatchObject([
      { id: "user", agent: payload.agent, model: payload.model },
      { id: "assistant", agent: "build", providerID: "openai", modelID: "gpt" },
      { id: "pending", agent: payload.agent, model: payload.model },
    ])
  })

  test("preserves current user attachments and payload comments in the compatibility projection", () => {
    const text = "Use @explore with @src/a.ts"
    const parts = [
      {
        type: "text",
        text: "Comment context",
        synthetic: true,
        metadata: {
          opencodeComment: { path: "src/a.ts", comment: "Keep stable", selection: { startLine: 4, endLine: 8 } },
        },
      },
      { type: "text", text },
      { type: "file", mime: "image/png", filename: "pixel.png", url: "data:image/png;base64,eA==" },
      {
        type: "file",
        mime: "text/plain",
        filename: "a.ts",
        url: "src/a.ts",
        source: { type: "file", path: "src/a.ts", text: { value: "@src/a.ts", start: 18, end: 27 } },
      },
      { type: "agent", name: "explore", source: { value: "@explore", start: 4, end: 12 } },
    ]
    const message = {
      id: "msg_rich",
      type: "user",
      text,
      files: [{ uri: "data:image/png;base64,eA==", mime: "image/png", name: "pixel.png" }],
      agents: [{ name: "explore", source: { text: "@explore", start: 4, end: 12 } }],
      time: { created: 1 },
    }
    const projected = normalizeCurrentSessionMessages("ses_1", [decodeCurrentMessage(message)])
    expect(projected.parts.get("msg_rich")).toMatchObject([
      { type: "text", text },
      { type: "file", url: "data:image/png;base64,eA==", filename: "pixel.png" },
      { type: "agent", source: { value: "@explore", start: 4, end: 12 } },
    ])
    const result = normalizeCurrentSessionMessages("ses_1", [
      decodeCurrentMessage({
        ...message,
        payload: { version: 1, agent: "build", model: { providerID: "provider", modelID: "model" }, parts },
      }),
    ])
    expect(result.messages[0]).toMatchObject({ agent: "build", model: { providerID: "provider", modelID: "model" } })
    expect(result.parts.get("msg_rich")).toMatchObject(parts)
    expect(
      result.parts.get("msg_rich")?.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_rich"),
    ).toBe(true)
  })

  test("renders current synthetic text, structured tool metadata, and snapshot diffs", () => {
    const result = normalizeCurrentSessionMessages("ses_1", [
      decodeCurrentMessage({
        id: "msg_synthetic",
        type: "synthetic",
        sessionID: "ses_1",
        text: "Generated context",
        time: { created: 1 },
      }),
      decodeCurrentMessage({
        id: "msg_user",
        type: "user",
        text: "edit it",
        files: [],
        agents: [],
        time: { created: 2 },
      }),
      decodeCurrentMessage({
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        snapshot: { diffs: [{ file: "README.md", additions: 2, deletions: 1, status: "modified" }] },
        content: [
          {
            type: "tool",
            id: "call_edit",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "/repo/README.md" },
              structured: {
                files: [{ file: "README.md", patch: "@@", additions: 2, deletions: 1 }],
              },
              content: [{ type: "text", text: "Edited" }],
            },
            time: { created: 3, ran: 4, completed: 5 },
          },
        ],
        time: { created: 3, completed: 5 },
      }),
    ])

    expect(result.parts.get("msg_synthetic")).toMatchObject([
      { type: "text", text: "Generated context", synthetic: true },
    ])
    expect(result.parts.get("msg_assistant")).toMatchObject([
      {
        type: "tool",
        state: {
          status: "completed",
          metadata: { filediff: { file: "README.md", patch: "@@", additions: 2, deletions: 1 } },
        },
      },
    ])
    expect(result.messages.find((message) => message.id === "msg_user")).toMatchObject({
      summary: { diffs: [{ file: "README.md", additions: 2, deletions: 1, status: "modified" }] },
    })
  })

  test("projects current turns into stable legacy rendering records", () => {
    const source = [
      { id: "msg_1", type: "agent-switched", agent: "build", time: { created: 1 } },
      {
        id: "msg_2",
        type: "model-switched",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        time: { created: 2 },
      },
      {
        id: "msg_3",
        type: "user",
        text: "inspect @src/client.ts",
        files: [
          {
            data: "aGVsbG8=",
            mime: "text/plain",
            name: "note.txt",
            source: { type: "inline" },
          },
          {
            data: "ZXhwb3J0IHt9",
            mime: "text/plain",
            name: "client.ts",
            source: { type: "inline" },
            mention: { text: "@src/client.ts", start: 8, end: 22 },
          },
        ],
        agents: [{ name: "review", mention: { text: "@review", start: 0, end: 7 } }],
        time: { created: 3 },
      },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "claude", providerID: "anthropic", variant: "high" },
        content: [
          { type: "reasoning", text: "Thinking", time: { created: 4, completed: 5 } },
          { type: "text", text: "Result" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "note.txt" },
              metadata: { title: "note.txt" },
              content: [{ type: "text", text: "hello" }],
            },
            time: { created: 5, ran: 6, completed: 7 },
          },
        ],
        cost: 0.1,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        time: { created: 4, completed: 7 },
      },
      {
        id: "msg_5",
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "summary",
        recent: "recent",
        time: { created: 8 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({
      id: "msg_3",
      role: "user",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude", variant: "high" },
    })
    expect(result.messages[1]).toMatchObject({ id: "msg_4", role: "assistant", parentID: "msg_3", cost: 0.1 })
    expect(result.parts.get("msg_3")?.map((part) => part.id)).toEqual([
      "msg_3:text:0",
      "msg_3:file:0",
      "msg_3:file:1",
      "msg_3:agent:0",
      "msg_5:compaction",
    ])
    expect(result.parts.get("msg_3")?.[2]).toMatchObject({
      type: "file",
      source: {
        type: "file",
        path: "src/client.ts",
        text: { value: "@src/client.ts", start: 8, end: 22 },
      },
    })
    expect(result.parts.get("msg_4")?.map((part) => part.id)).toEqual(["msg_4:reasoning:0", "msg_4:text:0", "call_1"])
    expect(result.parts.get("msg_4")?.[2]).toMatchObject({
      type: "tool",
      tool: "read",
      state: { status: "completed", output: "hello" },
    })
  })

  test("does not invent a parent for an assistant-only page", () => {
    const source = [
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "orphan" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]

    expect(normalizeSessionMessages("ses_1", source).messages).toEqual([])
  })

  test("keeps prepared context from compatibility assistant records", () => {
    const source = [
      { id: "msg_user", type: "user", text: "hello", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "world" }],
        system_prompt: "prepared system",
        tool_defs: '[{"name":"read"}]',
        time: { created: 2, completed: 3 },
      } as Extract<SessionMessageInfo, { type: "assistant" }> & {
        system_prompt: string
        tool_defs: string
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages[1]).toMatchObject({
      role: "assistant",
      systemPrompt: "prepared system",
      toolDefinitions: '[{"name":"read"}]',
    })
  })

  test("projects a current shell message into a renderable standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "printf hello",
        status: "exited",
        exit: 0,
        output: { output: "hello", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.messages).toEqual([
      expect.objectContaining({ id: "msg_shell", role: "user" }),
      expect.objectContaining({ id: "msg_shell:assistant", role: "assistant", parentID: "msg_shell" }),
    ])
    expect(result.parts.get("msg_shell")).toEqual([expect.objectContaining({ type: "text", text: "printf hello" })])
    expect(result.parts.get("msg_shell:assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "bash",
        state: expect.objectContaining({
          status: "completed",
          input: { command: "printf hello" },
          output: "hello",
          title: "Shell",
        }),
      }),
    ])
  })

  test("adapts current edit fields for the legacy edit renderer", () => {
    const source = [
      { id: "msg_user", type: "user", text: "edit it", time: { created: 1 } },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [
          {
            type: "tool",
            id: "call_edit",
            name: "edit",
            state: {
              status: "completed",
              input: { path: "/repo/README.md", oldString: "old", newString: "new" },
              content: [{ type: "text", text: "Edited file successfully" }],
              metadata: {
                files: [
                  {
                    file: "README.md",
                    patch: "@@ -1 +1 @@\n-old\n+new",
                    additions: 1,
                    deletions: 1,
                    status: "modified",
                  },
                ],
                replacements: 1,
              },
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        time: { created: 2, completed: 4 },
      },
    ] satisfies SessionMessageInfo[]

    const result = normalizeSessionMessages("ses_1", source)

    expect(result.parts.get("msg_assistant")).toEqual([
      expect.objectContaining({
        type: "tool",
        tool: "edit",
        state: expect.objectContaining({
          status: "completed",
          input: expect.objectContaining({ path: "/repo/README.md", filePath: "/repo/README.md" }),
          metadata: expect.objectContaining({
            filediff: {
              file: "README.md",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
            },
          }),
        }),
      }),
    ])
  })
})
