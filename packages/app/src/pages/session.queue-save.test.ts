import { describe, expect, test } from "bun:test"
import { applyQueueSaveSuccess } from "./session.queue-save"

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
