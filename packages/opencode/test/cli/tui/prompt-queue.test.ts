import { describe, expect, test } from "bun:test"

// Mirrors queue guard logic in packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx

function canQueue(input: {
  disabled: boolean
  workspaceCreating: boolean
  autocompleteVisible: boolean
  text: string
  mode: "normal" | "shell"
  slashCommand: boolean
}) {
  if (input.disabled) return false
  if (input.workspaceCreating) return false
  if (input.autocompleteVisible) return false
  if (!input.text.trim()) return false
  if (input.mode === "shell") return false
  if (input.slashCommand) return false
  return true
}

describe("main TUI prompt queue guards", () => {
  test("allows normal mode with text", () => {
    expect(
      canQueue({
        disabled: false,
        workspaceCreating: false,
        autocompleteVisible: false,
        text: "follow up",
        mode: "normal",
        slashCommand: false,
      }),
    ).toBe(true)
  })

  test("blocks shell mode", () => {
    expect(
      canQueue({
        disabled: false,
        workspaceCreating: false,
        autocompleteVisible: false,
        text: "ls",
        mode: "shell",
        slashCommand: false,
      }),
    ).toBe(false)
  })

  test("blocks empty input", () => {
    expect(
      canQueue({
        disabled: false,
        workspaceCreating: false,
        autocompleteVisible: false,
        text: "   ",
        mode: "normal",
        slashCommand: false,
      }),
    ).toBe(false)
  })

  test("blocks slash commands", () => {
    expect(
      canQueue({
        disabled: false,
        workspaceCreating: false,
        autocompleteVisible: false,
        text: "/compact",
        mode: "normal",
        slashCommand: true,
      }),
    ).toBe(false)
  })

  test("blocks disabled prompt", () => {
    expect(
      canQueue({
        disabled: true,
        workspaceCreating: false,
        autocompleteVisible: false,
        text: "hello",
        mode: "normal",
        slashCommand: false,
      }),
    ).toBe(false)
  })
})

describe("Prompt queue in-flight guard", () => {
  test("concurrent queue and submit only run once", async () => {
    let inFlight = false
    const calls: string[] = []

    async function send(label: string) {
      if (inFlight) return false
      inFlight = true
      try {
        await Bun.sleep(5)
        calls.push(label)
        return true
      } finally {
        inFlight = false
      }
    }

    await Promise.all([send("queue"), send("submit")])

    expect(calls).toHaveLength(1)
  })
})
