import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"
import { getSessionSystemPrompt } from "./session-context-system"

const user = (id: string, system?: string) => {
  return {
    id,
    role: "user",
    system,
    time: { created: 1 },
  } as unknown as Message
}

const assistant = (id: string, systemPrompt?: string) => {
  return {
    id,
    role: "assistant",
    system_prompt: systemPrompt,
    time: { created: 1 },
  } as unknown as Message
}

describe("getSessionSystemPrompt", () => {
  test("prefers the latest stored assistant system prompt", () => {
    expect(getSessionSystemPrompt([user("u1", "user system"), assistant("a1", " assistant system ")] as Message[])).toBe(
      "assistant system",
    )
  })

  test("falls back to the latest user system prompt", () => {
    expect(getSessionSystemPrompt([user("u1", "old"), user("u2", " current ")] as Message[])).toBe("current")
  })
})
