import { describe, expect, test } from "bun:test"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { Schema } from "effect"
import { currentSessionInitialState, reduceCurrentSession, type CurrentSessionAction } from "./reducer"

const decodeMessages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))
const decodeEvent = Schema.decodeUnknownSync(SessionEvent.All)

const user = (id: string, text: string, created: number) =>
  decodeMessages([
    {
      id,
      type: "user",
      text,
      time: { created },
    },
  ])[0]!

function dispatch(actions: CurrentSessionAction[]) {
  return actions.reduce(reduceCurrentSession, currentSessionInitialState())
}

describe("current session reducer", () => {
  test("hydrates a chronological native projection and preserves prepared provider context", () => {
    const state = dispatch([
      {
        type: "hydrated",
        sequence: 7,
        cursor: "older",
        messages: decodeMessages([
          {
            id: "msg_user",
            type: "user",
            text: "explain",
            time: { created: 1 },
          },
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "reviewer",
            model: { providerID: "openai", id: "gpt-5" },
            systemPrompt: "prepared system",
            toolDefinitions: '[{"name":"read"}]',
            content: [{ type: "text", id: "txt_1", text: "answer" }],
            time: { created: 2, completed: 3 },
          },
        ]),
      },
    ])

    expect(state.readiness).toBe("ready")
    expect(state.hasOlder).toBe(true)
    expect(state.messages.map((message) => String(message.id))).toEqual(["msg_user", "msg_assistant"])
    const assistant = state.messages[1]
    expect(assistant?.type === "assistant" && assistant.systemPrompt).toBe("prepared system")
    expect(assistant?.type === "assistant" && assistant.toolDefinitions).toBe('[{"name":"read"}]')
  })

  test("prepends older pages without duplicating messages already updated by live events", () => {
    const state = dispatch([
      {
        type: "hydrated",
        sequence: 2,
        cursor: "page-2",
        messages: [user("msg_2", "new", 2), user("msg_3", "newest", 3)],
      },
      {
        type: "older-loaded",
        cursor: undefined,
        messages: [user("msg_1", "oldest", 1), user("msg_2", "stale", 2)],
      },
    ])

    expect(state.messages.map((message) => [message.id, message.type === "user" ? message.text : ""])).toEqual([
      ["msg_1", "oldest"],
      ["msg_2", "new"],
      ["msg_3", "newest"],
    ])
    expect(state.hasOlder).toBe(false)
  })

  test("projects native current events and ignores a replayed durable sequence", () => {
    const started = decodeEvent({
      id: "evt_started",
      type: "session.next.step.started",
      durable: { aggregateID: "ses_test", seq: 5, version: 1 },
      data: {
        timestamp: 10,
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        agent: "reviewer",
        model: { providerID: "openai", id: "gpt-5" },
        systemPrompt: "exact prepared system",
        toolDefinitions: '[{"name":"echo","inputSchema":{"type":"object"}}]',
      },
    })
    const ended = decodeEvent({
      id: "evt_text",
      type: "session.next.text.ended",
      durable: { aggregateID: "ses_test", seq: 7, version: 1 },
      data: {
        timestamp: 11,
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        textID: "txt_1",
        text: "complete",
      },
    })
    const replayed = decodeEvent({
      id: "evt_text_replayed",
      type: "session.next.text.started",
      durable: { aggregateID: "ses_test", seq: 6, version: 1 },
      data: {
        timestamp: 11,
        sessionID: "ses_test",
        assistantMessageID: "msg_assistant",
        textID: "txt_1",
      },
    })

    const state = dispatch([
      { type: "hydrated", sequence: 4, messages: [] },
      { type: "event", event: started },
      {
        type: "event",
        event: decodeEvent({
          id: "evt_text_started",
          type: "session.next.text.started",
          durable: { aggregateID: "ses_test", seq: 6, version: 1 },
          data: {
            timestamp: 11,
            sessionID: "ses_test",
            assistantMessageID: "msg_assistant",
            textID: "txt_1",
          },
        }),
      },
      { type: "event", event: ended },
      { type: "event", event: replayed },
    ])

    expect(state.lastEventSequence).toBe(7)
    expect(state.messages).toHaveLength(1)
    const assistant = state.messages[0]
    expect(assistant?.type === "assistant" && assistant.systemPrompt).toBe("exact prepared system")
    expect(assistant?.type === "assistant" && assistant.toolDefinitions).toContain('"echo"')
    expect(assistant?.type === "assistant" && assistant.content).toEqual([
      { type: "text", id: "txt_1", text: "complete" },
    ])
  })

  test("keeps a promoted user prompt visible when its provider step fails", () => {
    const state = dispatch([
      { type: "hydrated", sequence: 10, messages: [] },
      {
        type: "event",
        event: decodeEvent({
          id: "evt_prompted",
          type: "session.next.prompted",
          durable: { aggregateID: "ses_test", seq: 11, version: 1 },
          data: {
            timestamp: 11,
            sessionID: "ses_test",
            messageID: "msg_hi",
            prompt: { text: "hi" },
            delivery: "steer",
          },
        }),
      },
      {
        type: "event",
        event: decodeEvent({
          id: "evt_started",
          type: "session.next.step.started",
          durable: { aggregateID: "ses_test", seq: 12, version: 1 },
          data: {
            timestamp: 12,
            sessionID: "ses_test",
            assistantMessageID: "msg_error",
            agent: "build",
            model: { providerID: "opencode", id: "mimo-v2.5-free" },
          },
        }),
      },
      {
        type: "event",
        event: decodeEvent({
          id: "evt_failed",
          type: "session.next.step.failed",
          durable: { aggregateID: "ses_test", seq: 13, version: 2 },
          data: {
            timestamp: 13,
            sessionID: "ses_test",
            assistantMessageID: "msg_error",
            error: { type: "unknown", message: "Provider unavailable" },
          },
        }),
      },
    ])

    expect(state.messages).toMatchObject([
      { id: "msg_hi", type: "user", text: "hi" },
      { id: "msg_error", type: "assistant", finish: "error", error: { message: "Provider unavailable" } },
    ])
  })

  test("replaces a projected message in place and keeps timeline order", () => {
    const state = dispatch([
      {
        type: "hydrated",
        sequence: 1,
        messages: [user("msg_1", "first", 1), user("msg_2", "old", 2)],
      },
      { type: "message-replaced", message: user("msg_2", "authoritative", 2) },
    ])

    expect(state.messages.map((message) => String(message.id))).toEqual(["msg_1", "msg_2"])
    expect(state.messages[1]?.type === "user" && state.messages[1].text).toBe("authoritative")
  })

  test("reconciles the authoritative newest window and removes reverted messages", () => {
    const state = dispatch([
      {
        type: "hydrated",
        sequence: 3,
        cursor: "older",
        messages: [user("msg_1", "retained older", 1), user("msg_2", "keep", 2), user("msg_3", "reverted", 3)],
      },
      {
        type: "newest-merged",
        messages: [user("msg_2", "authoritative", 2)],
        hasOlder: true,
      },
    ])

    expect(state.messages.map((message) => String(message.id))).toEqual(["msg_1", "msg_2"])
    expect(state.messages[1]?.type === "user" && state.messages[1].text).toBe("authoritative")
  })

  test("retains native retry state until the next provider step starts", () => {
    const retried = decodeEvent({
      id: "evt_retry",
      type: "session.next.retried",
      durable: { aggregateID: "ses_test", seq: 2, version: 1 },
      data: {
        timestamp: 2,
        sessionID: "ses_test",
        attempt: 3,
        error: { message: "Provider overloaded", isRetryable: true },
      },
    })
    const started = decodeEvent({
      id: "evt_retry_started",
      type: "session.next.step.started",
      durable: { aggregateID: "ses_test", seq: 3, version: 1 },
      data: {
        timestamp: 3,
        sessionID: "ses_test",
        assistantMessageID: "msg_retry_assistant",
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
      },
    })

    const retrying = dispatch([
      { type: "hydrated", sequence: 1, messages: [] },
      { type: "event", event: retried },
    ])
    const running = reduceCurrentSession(retrying, { type: "event", event: started })

    expect(retrying.retry?.type).toBe("session.next.retried")
    expect(retrying.retry?.data.error.message).toBe("Provider overloaded")
    expect(retrying.active).toBe(true)
    expect(running.retry).toBeUndefined()
  })
})
