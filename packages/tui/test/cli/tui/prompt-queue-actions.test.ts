import { describe, expect, test } from "bun:test"
import { queueMutationError } from "../../../src/component/prompt/queue-actions"
import { queueEditCommitPlan, queueEditSwitchPlan, queueSendNowDispatch } from "../../../src/queue/edit"

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

  test("send-now dispatch releases controls before the send turn settles", async () => {
    let resolveSend!: () => void
    let released = false
    let settled = false
    const sendTask = queueSendNowDispatch({
      send: () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve
        }),
      onError: () => {},
      releaseControls: () => {
        released = true
      },
    })
    void sendTask.then(() => {
      settled = true
    })

    await Bun.sleep(0)

    expect(released).toBe(true)
    expect(settled).toBe(false)

    resolveSend()
    await sendTask
    expect(settled).toBe(true)
  })
})
