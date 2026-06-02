import { expect, test } from "bun:test"
import { listDeferredQueued, pendingDeferredMessageIds } from "../../../src/cli/cmd/tui/component/prompt/queue"
import { runPromptPreview, truncateQueueLine } from "../../../src/queue/preview"
import { queueDockRows } from "../../../src/queue/queue-dock"
import type { RunPrompt } from "../../../src/cli/cmd/run/types"

test("listDeferredQueued returns server queue previews", () => {
  const items = listDeferredQueued({
    pending: [
      { id: "pqu_1", text: "queued one" },
      { id: "pqu_2", text: "queued two" },
    ],
  })

  expect(items).toEqual([
    { id: "pqu_1", text: "queued one" },
    { id: "pqu_2", text: "queued two" },
  ])
})

test("listDeferredQueued is empty without pending previews", () => {
  expect(listDeferredQueued({})).toEqual([])
})

test("pendingDeferredMessageIds matches listDeferredQueued ids", () => {
  const input = {
    pending: [{ id: "pqu_1", text: "queued one" }],
  }

  expect(pendingDeferredMessageIds(input)).toEqual(new Set(["pqu_1"]))
})

test("runPromptPreview uses the first non-empty line", () => {
  const preview = runPromptPreview({
    text: "line one\nline two",
    parts: [],
  } satisfies RunPrompt)
  expect(preview).toBe("line one")
})

test("truncateQueueLine keeps one line with ellipsis", () => {
  expect(truncateQueueLine("alphabet soup", 8)).toBe("alphabe…")
})

test("queueDockRows caps idle list height when more than two items", () => {
  expect(queueDockRows({ count: 5, editing: false })).toBeLessThan(queueDockRows({ count: 5, editing: true }))
})

test("queueDockRows reserves bottom padding in idle mode", () => {
  expect(queueDockRows({ count: 1, editing: false })).toBe(4)
  expect(queueDockRows({ count: 1, editing: false, collapsed: true })).toBe(3)
})
