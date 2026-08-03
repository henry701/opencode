import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { DateTime } from "effect"
import { firstPreparedMessageID, stripRepeatedPreparedContext } from "../src/handlers/prepared-context"

const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
}

const assistant = (id: string, prepared?: { systemPrompt?: string; toolDefinitions?: string }) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: "build",
    model,
    content: [],
    time: { created: DateTime.makeUnsafe(0) },
    ...prepared,
  })

describe("prepared context projection", () => {
  test("finds the first assistant carrying either prepared field", () => {
    const unprepared = assistant("msg_unprepared")
    const first = assistant("msg_first", { toolDefinitions: "first tools" })
    const later = assistant("msg_later", { systemPrompt: "later system" })

    expect(firstPreparedMessageID([unprepared, first, later])).toBe(first.id)
  })

  test("retains the first prepared metadata and strips repeated copies", () => {
    const first = assistant("msg_first", { systemPrompt: "first system", toolDefinitions: "first tools" })
    const later = assistant("msg_later", { systemPrompt: "later system", toolDefinitions: "later tools" })
    const firstID = firstPreparedMessageID([first, later])

    expect(stripRepeatedPreparedContext(first, firstID)).toBe(first)

    const projected = stripRepeatedPreparedContext(later, firstID)
    expect(projected).toMatchObject({
      id: later.id,
      type: "assistant",
      content: [],
    })
    expect(projected).not.toHaveProperty("systemPrompt")
    expect(projected).not.toHaveProperty("toolDefinitions")
    expect(later).toHaveProperty("systemPrompt", "later system")
    expect(later).toHaveProperty("toolDefinitions", "later tools")
  })
})
