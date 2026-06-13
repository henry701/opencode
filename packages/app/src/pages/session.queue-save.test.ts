import { describe, expect, test } from "bun:test"
import { applyQueueSaveSuccess, removeQueuedFollowup } from "./session.queue-save"

describe("queue save success", () => {
  test("resumes server drain after saving an edited queued prompt", () => {
    const calls: string[] = []

    applyQueueSaveSuccess({
      sessionID: "ses_test",
      queueID: "pqu_test",
      clearFailed: () => calls.push("clearFailed"),
      clearPaused: () => calls.push("clearPaused"),
      clearEdit: () => calls.push("clearEdit"),
      stopEditing: () => calls.push("stopEditing"),
      resumeDrain: (sessionID) => calls.push(`resume:${sessionID}`),
    })

    expect(calls).toEqual(["clearFailed", "clearPaused", "clearEdit", "stopEditing", "resume:ses_test"])
  })

  test("does not resume drain after appending a new queued prompt", () => {
    const calls: string[] = []

    applyQueueSaveSuccess({
      sessionID: "ses_test",
      clearFailed: () => calls.push("clearFailed"),
      clearPaused: () => calls.push("clearPaused"),
      clearEdit: () => calls.push("clearEdit"),
      stopEditing: () => calls.push("stopEditing"),
      resumeDrain: (sessionID) => calls.push(`resume:${sessionID}`),
    })

    expect(calls).toEqual(["clearFailed", "clearPaused"])
  })
})

describe("queue local removal", () => {
  test("removes a sent queued prompt from the local preview list", () => {
    expect(
      removeQueuedFollowup(
        [
          { id: "pqu_1", text: "one" },
          { id: "pqu_2", text: "two" },
          { id: "pqu_3", text: "three" },
        ],
        "pqu_2",
      ),
    ).toEqual([
      { id: "pqu_1", text: "one" },
      { id: "pqu_3", text: "three" },
    ])
  })

  test("preserves the same list when the queued prompt is absent", () => {
    const items = [{ id: "pqu_1", text: "one" }]

    expect(removeQueuedFollowup(items, "pqu_missing")).toBe(items)
  })
})
