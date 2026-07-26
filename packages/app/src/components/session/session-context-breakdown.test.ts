import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"
import { getSessionSystemPrompt } from "./session-context-system"

const user = (id: string) => {
  return {
    id: id as SessionMessage.ID,
    type: "user",
    text: "hello world",
    files: [],
    agents: [],
    time: { created: 1 },
  } as unknown as SessionMessage.User
}

const assistant = (
  id: string,
  content: SessionMessage.Assistant["content"] = [],
  toolDefinitions?: string,
  systemPrompt?: string,
) => {
  return {
    id: id as SessionMessage.ID,
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    content,
    tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
    toolDefinitions,
    systemPrompt,
  } as unknown as SessionMessage.Assistant
}

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("msg_u1"), assistant("msg_a1", [{ id: "txt_1", type: "text", text: "assistant response" }])]

    const output = estimateSessionContextBreakdown({
      messages,
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
    const messages = [
      { ...user("msg_u1"), text: "x".repeat(400) },
      assistant("msg_a1", [{ id: "txt_1", type: "text", text: "y".repeat(400) }]),
    ]

    const output = estimateSessionContextBreakdown({
      messages,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })

  test("counts the latest assistant tool definitions separately", () => {
    const storedToolDefs = "stored tool definitions"
    const selectedToolDefs = "selected tool definitions"
    const messages = [
      user("msg_u1"),
      assistant("msg_a1", [{ id: "txt_1", type: "text", text: "first response" }], storedToolDefs),
    ]

    const output = estimateSessionContextBreakdown({
      messages,
      input: 100,
      systemPrompt: "system",
      toolDefinitions: selectedToolDefs,
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.toolDefs).toBe(Math.ceil(selectedToolDefs.length / 4))
  })

  test("uses persisted assistant context metadata for system and tool definition segments", () => {
    const systemPrompt = "persisted assistant system prompt"
    const toolDefs = "persisted tool definitions"
    const messages = [
      user("msg_u1"),
      assistant("msg_a1", [{ id: "txt_1", type: "text", text: "answer" }], toolDefs, systemPrompt),
    ]

    const output = estimateSessionContextBreakdown({
      messages,
      input: 100,
      systemPrompt: getSessionSystemPrompt(messages),
      toolDefinitions: toolDefs,
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(Math.ceil(systemPrompt.length / 4))
    expect(map.toolDefs).toBe(Math.ceil(toolDefs.length / 4))
  })
})
