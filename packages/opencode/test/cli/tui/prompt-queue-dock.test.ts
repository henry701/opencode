import { expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { listDeferredQueued, pendingDeferredMessageIds } from "../../../src/cli/cmd/tui/component/prompt/queue"
import { runPromptPreview } from "../../../src/queue/preview"
import type { RunPrompt } from "../../../src/cli/cmd/run/types"

test("listDeferredQueued returns pending deferred user messages", () => {
  const items = listDeferredQueued({
    messages: [
      { id: "u1", role: "user", time: { created: 1 } },
      { id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } },
      { id: "u2", role: "user", delivery: "deferred", time: { created: 3 } },
      { id: "u3", role: "user", delivery: "deferred", time: { created: 4 } },
      { id: "a2", role: "assistant", parentID: "u3", finish: "stop", time: { created: 5 } },
    ] as Message[],
    parts: {
      u2: [{ id: "p1", sessionID: "s", messageID: "u2", type: "text" as const, text: "queued one" }],
      u3: [{ id: "p2", sessionID: "s", messageID: "u3", type: "text" as const, text: "queued two" }],
    },
    pendingAssistantID: "a1",
  })

  expect(items).toEqual([{ id: "u2", text: "queued one" }])
})

test("listDeferredQueued keeps deferred visible when a newer assistant is in flight", () => {
  const items = listDeferredQueued({
    messages: [
      { id: "u1", role: "user", time: { created: 1 } },
      { id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } },
      { id: "u2", role: "user", delivery: "deferred", time: { created: 3 } },
      { id: "a2", role: "assistant", parentID: "u1", time: { created: 4 } },
    ] as Message[],
    parts: {
      u2: [{ id: "p1", sessionID: "s", messageID: "u2", type: "text" as const, text: "still queued" }],
    },
    pendingAssistantID: "a2",
  })

  expect(items).toEqual([{ id: "u2", text: "still queued" }])
})

test("pendingDeferredMessageIds matches listDeferredQueued ids", () => {
  const input = {
    messages: [
      { id: "u1", role: "user", time: { created: 1 } },
      { id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } },
      { id: "u2", role: "user", delivery: "deferred", time: { created: 3 } },
    ] as Message[],
    parts: {
      u2: [{ id: "p1", sessionID: "s", messageID: "u2", type: "text" as const, text: "queued one" }],
    },
    pendingAssistantID: "a1",
  }

  expect(pendingDeferredMessageIds(input)).toEqual(new Set(["u2"]))
})

test("runPromptPreview uses the first non-empty line", () => {
  const preview = runPromptPreview({
    text: "line one\nline two",
    parts: [],
  } satisfies RunPrompt)
  expect(preview).toBe("line one")
})
