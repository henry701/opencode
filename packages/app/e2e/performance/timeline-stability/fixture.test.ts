import { describe, expect, test } from "bun:test"
import {
  assistantMessage,
  event,
  toolPart,
  userMessage,
  validateTimelineEvent,
  validateTimelineMessages,
  type PartSeed,
} from "./fixture"

describe("timeline fixture validation", () => {
  test("accepts a valid timeline", () => {
    expect(validateTimelineMessages([userMessage(), assistantMessage()])).toHaveLength(2)
  })

  test("rejects malformed SDK values at runtime", () => {
    expect(() =>
      assistantMessage([], {
        error: { name: "APIError", data: { message: "failed" } } as never,
      }),
    ).toThrow()
    expect(() =>
      validateTimelineEvent({
        id: "evt_invalid_retry",
        type: "session.next.retried",
        data: { timestamp: 1, sessionID: "ses_timeline_stability", attempt: 1 },
      }),
    ).toThrow()
  })

  test("rejects duplicate message and content IDs", () => {
    expect(() => validateTimelineMessages([userMessage(), userMessage()])).toThrow(/duplicate message ID/)
    expect(() =>
      validateTimelineMessages([
        userMessage(),
        assistantMessage([
          { id: "txt_duplicate", type: "text", text: "first" },
          { id: "txt_duplicate", type: "text", text: "second" },
        ]),
      ]),
    ).toThrow(/duplicate content ID/)
  })

  test("assigns deterministic event IDs", () => {
    const first = event("session.next.retried", {
      timestamp: 1,
      sessionID: "ses_timeline_stability",
      attempt: 1,
      error: { message: "retry", isRetryable: true },
    })
    const second = event("session.next.retried", {
      timestamp: 2,
      sessionID: "ses_other_timeline",
      attempt: 2,
      error: { message: "retry", isRetryable: true },
    })
    expect(second.durable?.aggregateID).toBe("ses_other_timeline")
    expect(first.id).toMatch(/^evt_timeline_\d{4}$/)
    expect(Number(second.id.slice(-4))).toBe(Number(first.id.slice(-4)) + 1)
  })
})

if (false) {
  const userSeed = { id: "prt_type_user", type: "text", text: "typed" } satisfies PartSeed<"user">
  userMessage([userSeed])

  // @ts-expect-error Tool completion fields are not valid while pending.
  toolPart("prt_invalid_pending", "bash", "pending", {}, { output: "impossible" })
  // @ts-expect-error Tool completion fields are not valid while running.
  toolPart("prt_invalid_running", "bash", "running", {}, { output: "impossible" })
  // @ts-expect-error Tool error fields are not valid after completion.
  toolPart("prt_invalid_completed", "bash", "completed", {}, { error: "impossible" })

  assistantMessage([
    // @ts-expect-error Agent references belong to user messages, not assistant messages.
    { id: "prt_invalid_owner", type: "agent", name: "explore", source: { value: "@explore", start: 0, end: 8 } },
  ])

  // @ts-expect-error Native retry events require the provider error.
  event("session.next.retried", { timestamp: 1, sessionID: "ses_timeline_stability", attempt: 1 })
}
