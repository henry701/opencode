import { describe, expect, test } from "bun:test"
import { queueMutationError } from "@/cli/cmd/tui/component/prompt/queue-actions"

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
})
