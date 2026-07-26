import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { currentSessionInitialState, reduceCurrentSession } from "./reducer"

const decodeMessages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))
const decodeEvent = Schema.decodeUnknownSync(SessionEvent.All)
const sessionID = "ses_event_order"
const assistantID = "msg_event_order_assistant"

describe("early idle event order", () => {
  test("applies text updates that arrive after an idle status event", () => {
    const textID = "prt_event_order_text"
    const [user, assistant] = decodeMessages([
      {
        id: "msg_event_order_user",
        type: "user",
        text: "Continue",
        time: { created: 1700000000000 },
      },
      {
        id: assistantID,
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode", id: "claude-opus-4-6" },
        content: [{ type: "text", id: textID, text: "Partial" }],
        time: { created: 1700000001000 },
      },
    ])
    let state = reduceCurrentSession(currentSessionInitialState(), {
      type: "hydrated",
      messages: [user!, assistant!],
      sequence: 0,
    })

    state = reduceCurrentSession(state, { type: "active-updated", active: true })
    state = reduceCurrentSession(state, {
      type: "event",
      event: decodeEvent({
        id: "evt_event_order_idle",
        type: "session.next.step.ended",
        durable: { aggregateID: sessionID, seq: 1, version: 2 },
        data: {
          timestamp: 1700000002000,
          sessionID,
          assistantMessageID: "msg_event_order_idle",
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    })
    state = reduceCurrentSession(state, { type: "active-updated", active: false })

    state = reduceCurrentSession(state, {
      type: "event",
      event: decodeEvent({
        id: "evt_event_order_text",
        type: "session.next.text.ended",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: {
          timestamp: 1700000002001,
          sessionID,
          assistantMessageID: assistantID,
          textID,
          text: "Final after early idle",
        },
      }),
    })
    state = reduceCurrentSession(state, {
      type: "event",
      event: decodeEvent({
        id: "evt_event_order_completed",
        type: "session.next.step.ended",
        durable: { aggregateID: sessionID, seq: 3, version: 2 },
        data: {
          timestamp: 1700000003000,
          sessionID,
          assistantMessageID: assistantID,
          finish: "stop",
          cost: 0.01,
          tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    })

    const message = state.messages.find((entry) => entry.id === assistant.id)
    expect(message?.type).toBe("assistant")
    if (message?.type !== "assistant") return
    expect(message.content).toEqual([{ type: "text", id: textID, text: "Final after early idle" }])
    expect(message.time.completed).toBeDefined()
  })
})
