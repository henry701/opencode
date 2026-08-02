import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { getSessionPreparedContext, getSessionSystemPrompt } from "./session-context-system"

const user = (id: string, system?: string): SessionMessage.User => ({
  id: id as SessionMessage.ID,
  type: "user",
  text: id,
  files: [],
  agents: [],
  payload: {
    version: 1,
    agent: "build",
  model: { providerID: "test" as never, modelID: "model" as never },
    system,
    parts: [{ type: "text", text: id }],
  },
  time: { created: 1 as never },
})

const assistant = (id: string, systemPrompt?: string, toolDefinitions?: string): SessionMessage.Assistant => ({
  id: id as SessionMessage.ID,
  type: "assistant",
  agent: "build",
  model: { providerID: "test" as never, id: "model" as never },
  systemPrompt,
  toolDefinitions,
  content: [],
  tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1 as never, completed: 2 as never },
})

describe("getSessionSystemPrompt", () => {
  test("prefers the latest exact prepared assistant system prompt", () => {
    expect(getSessionSystemPrompt([user("msg_u1", "user system"), assistant("msg_a1", " assistant system ")])).toBe(
      "assistant system",
    )
  })

  test("falls back to the latest native user payload system prompt", () => {
    expect(getSessionSystemPrompt([user("msg_u1", "old"), user("msg_u2", " current ")])).toBe("current")
  })

  test("correlates prepared context with the selected assistant turn", () => {
    const messages = [
      user("msg_01", "first user system"),
      assistant("msg_02", "first prepared system", "first tools"),
      user("msg_03", "second user system"),
      assistant("msg_04", "second prepared system", "second tools"),
      assistant("msg_05", "later zero-token system", "later tools"),
    ]

    expect(getSessionPreparedContext(messages, { messageID: "msg_04" })).toEqual({
      systemPrompt: "second prepared system",
      toolDefinitions: "second tools",
    })
  })

  test("uses the active assistant at the exact revert boundary", () => {
    const messages = [
      user("msg_01", "first user system"),
      assistant("msg_02", "first prepared system", "first tools"),
      user("msg_03", "second user system"),
      assistant("msg_04", "second prepared system", "second tools"),
    ]

    expect(
      getSessionPreparedContext(messages, {
        messageID: "msg_04",
        revert: { messageID: "msg_03" },
      }),
    ).toEqual({
      systemPrompt: "first prepared system",
      toolDefinitions: "first tools",
    })
    expect(
      getSessionPreparedContext(messages, {
        messageID: "msg_04",
        revert: { messageID: "msg_04", partID: "part_01" },
      }),
    ).toEqual({
      systemPrompt: "second prepared system",
      toolDefinitions: "second tools",
    })
  })

  test("falls back to the active user payload when the selected assistant omitted prepared context", () => {
    const messages = [
      user("msg_01", "first user system"),
      assistant("msg_02", "first prepared system", "first tools"),
      user("msg_03", "current user system"),
      assistant("msg_04"),
    ]

    expect(getSessionPreparedContext(messages, { messageID: "msg_04" })).toEqual({
      systemPrompt: "first prepared system",
      toolDefinitions: "first tools",
    })
  })
})
