import { expect, describe, test } from "bun:test"
import { Effect } from "effect"
import {
  MemoryPromptQueue,
  materializeQueuedItem,
  PromptQueue,
  type PromptQueueData,
} from "@/queue/prompt-queue"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/session/schema"

function sampleData(text: string): PromptQueueData {
  return {
    version: 1,
    agent: "build",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    parts: [{ type: "text", text }],
  }
}

describe("MemoryPromptQueue", () => {
  const memory = new MemoryPromptQueue()
  const sessionID = SessionID.make("ses_queue_mem")

  test("enqueues without a fixed cap", () => {
    memory.clear(sessionID)
    memory.enqueue(sessionID, sampleData("one"))
    memory.enqueue(sessionID, sampleData("two"))
    memory.enqueue(sessionID, sampleData("three"))
    memory.enqueue(sessionID, sampleData("four"))
    expect(
      memory.list(sessionID).map((item) => (item.data.parts[0]?.type === "text" ? item.data.parts[0].text : "")),
    ).toEqual(["one", "two", "three", "four"])
  })

  test("dequeues in fifo order and supports update/remove", () => {
    memory.clear(sessionID)
    const first = memory.enqueue(sessionID, sampleData("first"))
    memory.enqueue(sessionID, sampleData("second"))
    memory.update(sessionID, first.id, sampleData("first-edited"))
    const peekText = (item: ReturnType<MemoryPromptQueue["peek"]>) =>
      item?.data.parts[0]?.type === "text" ? item.data.parts[0].text : ""
    expect(peekText(memory.peek(sessionID))).toBe("first-edited")
    expect(peekText(memory.dequeue(sessionID))).toBe("first-edited")
    const second = memory.peek(sessionID)
    expect(peekText(second)).toBe("second")
    expect(memory.remove(sessionID, second!.id)).toBe(true)
    expect(memory.peek(sessionID)).toBeUndefined()
  })
})

describe("materializeQueuedItem", () => {
  test("assigns immediate delivery and fresh ids", () => {
    const sessionID = SessionID.make("ses_materialize")
    const item = new MemoryPromptQueue().enqueue(sessionID, sampleData("hello"))
    const message = materializeQueuedItem(item)
    expect(message.info.role).toBe("user")
    if (message.info.role === "user") expect((message.info as { delivery?: string }).delivery).toBe("immediate")
    expect(message.parts[0]?.type === "text" ? message.parts[0].text : "").toBe("hello")
    expect(message.info.id).not.toBe(item.id)
  })

  test("preserves system and format metadata", () => {
    const sessionID = SessionID.make("ses_materialize_meta")
    const item = new MemoryPromptQueue().enqueue(sessionID, {
      ...sampleData("hello"),
      system: "custom system",
      format: { type: "json_schema", schema: { type: "object" } },
    })
    const message = materializeQueuedItem(item)
    if (message.info.role !== "user") throw new Error("expected user message")
    expect(message.info.system).toBe("custom system")
    expect(message.info.format).toEqual({ type: "json_schema", schema: { type: "object" } })
  })
})
