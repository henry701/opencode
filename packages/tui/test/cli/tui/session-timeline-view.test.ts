import { expect, test } from "bun:test"
import { currentTimelineMessages } from "../../../src/routes/session/timeline-view"
import type { SessionMessage, SessionMessageAssistant, SessionMessageUser } from "@opencode-ai/sdk/v2"

test("selects the native current timeline without converting message or content identities", () => {
  const user: SessionMessageUser = { id: "msg_user", type: "user", text: "hello", time: { created: 2 } }
  const assistant: SessionMessageAssistant = {
    id: "msg_assistant",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    systemPrompt: "exact prepared system",
    toolDefinitions: '[{"name":"read"}]',
    content: [{ id: "txt_1", type: "text", text: "done" }],
    time: { created: 3, completed: 4 },
  }
  const switched: SessionMessage = {
    id: "msg_switch",
    type: "model-switched",
    model: { providerID: "test", id: "other" },
    time: { created: 1 },
  }

  const result = currentTimelineMessages([assistant, user, switched])

  expect(result).toEqual([user, assistant])
  expect(result[0]).toBe(user)
  expect(result[1]).toBe(assistant)
  expect(result[1]?.type === "assistant" && result[1].content[0]).toBe(assistant.content[0])
  expect(result[1]?.type === "assistant" && result[1].systemPrompt).toBe("exact prepared system")
  expect(result[1]?.type === "assistant" && result[1].toolDefinitions).toContain("read")
})
