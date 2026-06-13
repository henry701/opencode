import { expect, test } from "bun:test"
import { listDeferredQueued, pendingDeferredMessageIds } from "../../../src/component/prompt/queue"
import { runPromptPreview, truncateQueueLine } from "../../../src/queue/preview"
import { queueDockRows, queueDockVisibleItems } from "../../../src/queue/queue-dock"

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
  })
  expect(preview).toBe("line one")
})

test("truncateQueueLine keeps one line with ellipsis", () => {
  expect(truncateQueueLine("alphabet soup", 8)).toBe("alphabe...")
})

test("queueDockRows keeps idle height stable when more than two items are queued", () => {
  expect(queueDockRows({ count: 3, editing: false })).toBe(queueDockRows({ count: 8, editing: false }))
})

test("queueDockRows caps edit list height at three visible queued items", () => {
  expect(queueDockRows({ count: 3, editing: true })).toBe(queueDockRows({ count: 8, editing: true }))
})

test("queueDockRows reserves bottom padding in idle mode", () => {
  expect(queueDockRows({ count: 1, editing: false })).toBe(5)
  expect(queueDockRows({ count: 1, editing: false, collapsed: true })).toBe(3)
})

test("queueDockVisibleItems centers the active edit when possible", () => {
  const items = [
    { id: "pqu_1", text: "one" },
    { id: "pqu_2", text: "two" },
    { id: "pqu_3", text: "three" },
    { id: "pqu_4", text: "four" },
    { id: "pqu_5", text: "five" },
  ]

  expect(queueDockVisibleItems({ items, editing: true, editingID: "pqu_3" })).toEqual([
    { item: items[1], ordinal: 2 },
    { item: items[2], ordinal: 3 },
    { item: items[3], ordinal: 4 },
  ])
})

test("queueDockVisibleItems shows two below when editing the first item", () => {
  const items = [
    { id: "pqu_1", text: "one" },
    { id: "pqu_2", text: "two" },
    { id: "pqu_3", text: "three" },
    { id: "pqu_4", text: "four" },
  ]

  expect(queueDockVisibleItems({ items, editing: true, editingID: "pqu_1" }).map((entry) => entry.ordinal)).toEqual([
    1, 2, 3,
  ])
})

test("queueDockVisibleItems shows two above when editing the last item", () => {
  const items = [
    { id: "pqu_1", text: "one" },
    { id: "pqu_2", text: "two" },
    { id: "pqu_3", text: "three" },
    { id: "pqu_4", text: "four" },
  ]

  expect(queueDockVisibleItems({ items, editing: true, editingID: "pqu_4" }).map((entry) => entry.ordinal)).toEqual([
    2, 3, 4,
  ])
})
