import { describe, expect, test } from "bun:test"
import { queueMutationError } from "../../../src/component/prompt/queue-actions"
import { queueEditCommitPlan, queueEditSwitchPlan, queueSendNowTransitionPlan } from "../../../src/queue/edit"

describe("main TUI prompt queue actions", () => {
  test("treats missing queue mutation results as failures", () => {
    expect(queueMutationError({ result: undefined, fallback: "no response" })).toBe("no response")
  })

  test("surfaces queue mutation response errors", () => {
    const error = new Error("not found")
    expect(queueMutationError({ result: { error }, fallback: "no response" })).toBe(error)
  })

  test("accepts queue mutation results without an error", () => {
    expect(queueMutationError({ result: { data: { id: "pqu_1" } }, fallback: "no response" })).toBeUndefined()
  })

  test("discards the current draft when switching queued messages", () => {
    expect(queueEditSwitchPlan({ currentID: "pqu_1", targetID: "pqu_2" })).toEqual({
      editID: "pqu_2",
      saveCurrent: false,
    })
  })

  test("saves non-empty queued edit commits", () => {
    expect(queueEditCommitPlan({ text: " updated queued prompt " })).toEqual({ type: "save" })
  })

  test("removes empty queued edit commits", () => {
    expect(queueEditCommitPlan({ text: " \n\t " })).toEqual({ type: "remove" })
  })

  test("send-now advances queued edit immediately instead of locking controls until the turn completes", () => {
    expect(
      queueSendNowTransitionPlan({
        items: [
          { id: "pqu_1", text: "first" },
          { id: "pqu_2", text: "second" },
        ],
        messageID: "pqu_1",
        editingID: "pqu_1",
      }),
    ).toEqual({
      type: "advance",
      editID: "pqu_2",
      releaseControlsBeforeSendSettles: true,
    })
  })

  test("send-now selects the queued edit above when the sent item has no item below", () => {
    expect(
      queueSendNowTransitionPlan({
        items: [
          { id: "pqu_1", text: "first" },
          { id: "pqu_2", text: "second" },
        ],
        messageID: "pqu_2",
        editingID: "pqu_2",
      }),
    ).toEqual({
      type: "advance",
      editID: "pqu_1",
      releaseControlsBeforeSendSettles: true,
    })
  })

  test("send-now exits queued edit immediately when no queued message remains", () => {
    expect(
      queueSendNowTransitionPlan({
        items: [{ id: "pqu_1", text: "first" }],
        messageID: "pqu_1",
        editingID: "pqu_1",
      }),
    ).toEqual({
      type: "exit",
      releaseControlsBeforeSendSettles: true,
    })
  })
})
