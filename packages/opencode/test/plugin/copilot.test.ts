import { describe, expect, test } from "bun:test"
import { SYNTHETIC_PATTERNS, isSynthetic, detectAgent } from "../../src/plugin/github-copilot/copilot"
import { SYNTHETIC_ATTACHMENT_PROMPT } from "../../src/session/message-v2"

function getInitiator(body: any): "user" | "agent" {
  const messages = body?.messages || body?.input || []
  return detectAgent(messages) ? "agent" : "user"
}

describe("plugin.copilot", () => {
  describe("SYNTHETIC_PATTERNS", () => {
    test("only three patterns matching real synthetic strings", () => {
      expect(SYNTHETIC_PATTERNS).toHaveLength(3)
    })
  })

  describe("isSynthetic", () => {
    test("detects tool attachment pattern", () => {
      expect(isSynthetic("Attached media from tool result:")).toBe(true)
      expect(isSynthetic(SYNTHETIC_ATTACHMENT_PROMPT)).toBe(true)
    })

    test("detects compaction pattern", () => {
      expect(isSynthetic("What did we do so far?")).toBe(true)
      expect(isSynthetic("What did we do so far? ")).toBe(true)
    })

    test("detects subtask pattern", () => {
      expect(isSynthetic("The following tool was executed by the user")).toBe(true)
    })

    test("phantom patterns from old code no longer match", () => {
      expect(isSynthetic("Tool read_file returned an attachment:")).toBe(false)
      expect(isSynthetic("Tool result: foo")).toBe(false)
      expect(isSynthetic("Tool bash returned an attachment:")).toBe(false)
    })

    test("ignores normal user messages", () => {
      expect(isSynthetic("Hello, can you help me?")).toBe(false)
      expect(isSynthetic("Read the file README.md")).toBe(false)
      expect(isSynthetic("What did we do yesterday?")).toBe(false)
    })

    test("handles empty and invalid input", () => {
      expect(isSynthetic("")).toBe(false)
      expect(isSynthetic(null as any)).toBe(false)
      expect(isSynthetic(undefined as any)).toBe(false)
    })
  })

  describe("detectAgent", () => {
    test("first user message returns user", () => {
      expect(getInitiator({ messages: [{ role: "user", content: "Hello" }] })).toBe("user")
    })

    test("empty messages returns user", () => {
      expect(getInitiator({ messages: [] })).toBe("user")
      expect(getInitiator({})).toBe("user")
      expect(getInitiator(null)).toBe("user")
    })

    test("assistant message returns agent", () => {
      expect(getInitiator({ messages: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }] })).toBe("agent")
    })

    test("tool message returns agent", () => {
      expect(getInitiator({ messages: [{ role: "user", content: "Run test" }, { role: "tool", content: "Test passed" }] })).toBe("agent")
    })

    test("synthetic tool attachment returns agent", () => {
      expect(getInitiator({ messages: [{ role: "user", content: "Attached media from tool result:" }] })).toBe("agent")
    })

    test("synthetic compaction returns agent", () => {
      expect(getInitiator({ messages: [{ role: "user", content: "What did we do so far? " }] })).toBe("agent")
    })

    test("synthetic with array content returns agent", () => {
      expect(getInitiator({
        messages: [{
          role: "user",
          content: [{ type: "text", text: "Attached media from tool result:" }, { type: "file", url: "file://out.txt" }],
        }],
      })).toBe("agent")
    })

    test("responses API format works", () => {
      expect(getInitiator({ input: [{ role: "user", content: "Hello" }] })).toBe("user")
      expect(getInitiator({ input: [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }] })).toBe("agent")
    })
  })

  describe("regression: issues #8030 and #8067", () => {
    test("synthetic user message in conversation does not charge premium", () => {
      expect(getInitiator({
        messages: [
          { role: "user", content: "Read file.txt" },
          { role: "assistant", content: "Reading..." },
          { role: "user", content: "Attached media from tool result:" },
        ],
      })).toBe("agent")
    })

    test("multi-turn with real user follow-up still agent (assistant exists)", () => {
      expect(getInitiator({
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "Now do something else" },
        ],
      })).toBe("agent")
    })
  })
})
