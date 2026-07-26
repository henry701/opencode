import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Schema } from "effect"
import { currentTimelineRows, presentCurrentTimeline } from "./current-presentation"

const decodeMessages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))

describe("current session timeline presentation", () => {
  test("keeps native messages and groups user, assistant, text, and tool transitions", () => {
    const messages = decodeMessages([
      {
        id: "msg_user",
        type: "user",
        text: "Review this",
        files: [],
        agents: [],
        payload: {
          version: 1,
          agent: "reviewer",
          model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
          tools: { bash: false },
          system: "requested system",
          format: { type: "json_schema", schema: { type: "object" } },
          permissions: [{ permission: "bash", pattern: "*", action: "deny" }],
          parts: [
            { id: "prt_text", type: "text", text: "Review this" },
            { id: "prt_hidden", type: "text", text: "context", synthetic: true },
          ],
        },
        time: { created: 1 },
      },
      {
        id: "msg_assistant",
        type: "assistant",
        agent: "reviewer",
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        systemPrompt: "prepared provider system",
        toolDefinitions: '[{"name":"bash"}]',
        content: [
          { id: "txt_1", type: "text", text: "Done" },
          { id: "rsn_1", type: "reasoning", text: "Checked", time: { created: 2, completed: 3 } },
          {
            id: "call_1",
            type: "tool",
            name: "bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              structured: { title: "Run pwd" },
              content: [{ type: "text", text: "/repo" }],
              result: { exitCode: 0 },
            },
            time: { created: 2, ran: 3, completed: 4 },
          },
        ],
        finish: "stop",
        cost: 0.01,
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
        time: { created: 2, completed: 5 },
      },
    ])

    const result = presentCurrentTimeline({
      messages,
      agent: "build",
      model: messages[1]?.type === "assistant" ? messages[1].model : undefined,
    })
    const user = messages.find((message): message is SessionMessage.User => message.type === "user")!
    const assistant = messages.find((message): message is SessionMessage.Assistant => message.type === "assistant")!

    expect(result.messages).toBe(messages)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0]).toEqual({
      message: user,
      agent: "reviewer",
      model: assistant.model,
      assistants: [assistant],
      compactions: [],
      comments: [],
      diffs: [],
    })
    expect(result.turns[0]?.assistants[0]?.content.map((part) => part.type)).toEqual(["text", "reasoning", "tool"])
    expect(result.turns[0]?.assistants[0]?.systemPrompt).toBe("prepared provider system")
    expect(result.turns[0]?.assistants[0]?.toolDefinitions).toBe('[{"name":"bash"}]')
  })

  test("tracks model and variant switches and keeps shell messages native", () => {
    const messages = decodeMessages([
      {
        id: "msg_agent",
        type: "agent-switched",
        agent: "reviewer",
        time: { created: 1 },
      },
      {
        id: "msg_model",
        type: "model-switched",
        model: { providerID: "openai", id: "gpt-5", variant: "high" },
        time: { created: 2 },
      },
      {
        id: "msg_shell",
        type: "shell",
        callID: "shell_1",
        command: "pwd",
        output: "/repo",
        time: { created: 3, completed: 4 },
      },
    ])

    const result = presentCurrentTimeline({
      messages,
      agent: "build",
      model: messages[1]?.type === "model-switched" ? messages[1].model : undefined,
    })
    const switched = messages.find(
      (message): message is SessionMessage.ModelSwitched => message.type === "model-switched",
    )!
    const shell = messages.find((message): message is SessionMessage.Shell => message.type === "shell")!

    expect(result.messages).toBe(messages)
    expect(result.turns).toEqual([
      {
        message: shell,
        agent: "reviewer",
        model: switched.model,
        assistants: [],
        compactions: [],
        comments: [],
        diffs: [],
      },
    ])
    expect(result.turns[0]?.message.type).toBe("shell")
  })

  test("projects a native retry event for the active turn", () => {
    const messages = decodeMessages([{ id: "msg_retry_user", type: "user", text: "retry this", time: { created: 1 } }])
    const retry = Schema.decodeUnknownSync(SessionEvent.Retried)({
      id: "evt_retry",
      type: "session.next.retried",
      durable: { aggregateID: "ses_test", seq: 2, version: 1 },
      data: {
        timestamp: 2,
        sessionID: "ses_test",
        attempt: 2,
        error: { message: "Provider overloaded", isRetryable: true },
      },
    })
    const presentation = presentCurrentTimeline({ messages, retry })

    expect(presentation.retry).toBe(retry)
    expect(currentTimelineRows(presentation, true, false).map((row) => row._tag)).toEqual(["UserMessage", "Retry"])
  })

  test("projects native comments, historical diffs, and interruption semantics", () => {
    const messages = decodeMessages([
      {
        id: "msg_rich_user",
        type: "user",
        text: "Continue",
        payload: {
          version: 1,
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-5" },
          parts: [
            {
              type: "text",
              text: "The user made the following comment regarding line 3 of src/a.ts: Keep this",
              synthetic: true,
            },
            { type: "text", text: "Continue" },
          ],
        },
        time: { created: 1 },
      },
      {
        id: "msg_interrupted",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ id: "txt_partial", type: "text", text: "Partial" }],
        snapshot: {
          diffs: [{ file: "src/a.ts", additions: 2, deletions: 1 }],
        },
        finish: "error",
        error: { type: "interrupted", message: "Provider turn interrupted" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_next_user",
        type: "user",
        text: "Next",
        time: { created: 4 },
      },
    ])
    const presentation = presentCurrentTimeline({ messages })

    expect(presentation.turns[0]?.comments).toHaveLength(1)
    expect(presentation.turns[0]?.diffs).toEqual([{ file: "src/a.ts", additions: 2, deletions: 1 }])
    expect(currentTimelineRows(presentation, false, false).map((row) => row._tag)).toEqual([
      "CommentStrip",
      "UserMessage",
      "AssistantPart",
      "TurnDivider",
      "DiffSummary",
      "TurnGap",
      "UserMessage",
    ])
  })

  test("groups consecutive native context tools without grouping across visible content", () => {
    const messages = decodeMessages([
      { id: "msg_context_user", type: "user", text: "Inspect", time: { created: 1 } },
      {
        id: "msg_context_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        content: [
          tool("read_1", "read"),
          tool("grep_1", "grep"),
          { id: "txt_between", type: "text", text: "Found it" },
          tool("list_1", "list"),
        ],
        time: { created: 2, completed: 3 },
      },
    ])
    const rows = currentTimelineRows(presentCurrentTimeline({ messages }), false, false)
    const groups = rows.flatMap((row) => (row._tag === "AssistantPart" ? [row.group] : []))

    expect(groups.map((group) => group.type)).toEqual(["context", "part", "context"])
    expect(groups[0]?.type === "context" ? groups[0].refs.map((ref) => ref.partID) : []).toEqual(["read_1", "grep_1"])
  })

  test("keeps a hidden native reasoning heading on the active thinking row", () => {
    const messages = decodeMessages([
      { id: "msg_thinking_user", type: "user", text: "Think", time: { created: 1 } },
      {
        id: "msg_thinking_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ id: "reasoning_heading", type: "reasoning", text: "## Inspecting stability" }],
        time: { created: 2 },
      },
    ])
    const row = currentTimelineRows(presentCurrentTimeline({ messages }), true, false).find(
      (item) => item._tag === "Thinking",
    )

    expect(row?._tag === "Thinking" && row.reasoningHeading).toBe("Inspecting stability")
  })

  test("hides the thinking row when visible reasoning is projected", () => {
    const messages = decodeMessages([
      { id: "msg_thinking_user", type: "user", text: "Think", time: { created: 1 } },
      {
        id: "msg_thinking_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ id: "reasoning_heading", type: "reasoning", text: "## Inspecting stability" }],
        time: { created: 2 },
      },
    ])
    const rows = currentTimelineRows(presentCurrentTimeline({ messages }), true, true)

    expect(rows.some((item) => item._tag === "Thinking")).toBe(false)
    expect(rows.some((item) => item._tag === "AssistantPart")).toBe(true)
  })
})

function tool(id: string, name: string) {
  return {
    id,
    type: "tool" as const,
    name,
    state: { status: "completed" as const, input: {}, structured: {}, content: [] },
    time: { created: 2, completed: 3 },
  }
}
