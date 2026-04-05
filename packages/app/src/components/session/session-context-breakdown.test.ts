import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string) => {
  return {
    id,
    role: "user",
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string, toolDefs?: string) => {
  return {
    id,
    role: "assistant",
    time: { created: 1 },
    tool_defs: toolDefs,
  } as unknown as Message
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "hello world" }] as unknown as Part[],
      a1: [{ type: "text", text: "assistant response" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1"), assistant("a1")]
    const parts = {
      u1: [{ type: "text", text: "x".repeat(400) }] as unknown as Part[],
      a1: [{ type: "text", text: "y".repeat(400) }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })

  test("only counts tool_defs from latest assistant message", () => {
    const td1 = "tool defs v1"
    const td2 = "tool defs v2"
    const messages = [user("u1"), assistant("a1", td1), assistant("a2", td2)]
    const parts = {
      u1: [{ type: "text", text: "hello" }] as unknown as Part[],
      a1: [{ type: "text", text: "response 1" }] as unknown as Part[],
      a2: [{ type: "text", text: "response 2" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 100,
      systemPrompt: "system",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.toolDefs).toBe(Math.ceil(td2.length / 4))
  })

  test("counts tool_defs when only first assistant has it", () => {
    const td1 = "tool defs v1"
    const messages = [user("u1"), assistant("a1", td1), assistant("a2")]
    const parts = {
      u1: [{ type: "text", text: "hello" }] as unknown as Part[],
      a1: [{ type: "text", text: "response 1" }] as unknown as Part[],
      a2: [{ type: "text", text: "response 2" }] as unknown as Part[],
    }

    const output = estimateSessionContextBreakdown({
      messages,
      parts,
      input: 100,
      systemPrompt: "system",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.toolDefs).toBe(Math.ceil(td1.length / 4))
  })
})
