import { expect, test } from "bun:test"
import { isInteractiveRun } from "@/cli/cmd/run"

test("run interactive mode accepts the public interactive flag", () => {
  expect(isInteractiveRun({ interactive: true })).toBe(true)
})

test("run mini mode remains interactive", () => {
  expect(isInteractiveRun({ mini: true })).toBe(true)
})
