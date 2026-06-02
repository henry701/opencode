import { expect, describe, test } from "bun:test"
import { Effect } from "effect"
import {
  MemoryPromptQueue,
  materializeQueuedItem,
  PromptQueue,
  type PromptQueueData,
} from "@/queue/prompt-queue"
import { ProjectTable } from "@/project/project.sql"
import { SessionTable } from "@/session/session.sql"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

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

describe("PromptQueue sqlite", () => {
  const sessionID = SessionID.make("ses_queue_sql")
  const projectID = ProjectID.make("project_queue")

  function seedSession() {
    const now = Date.now()
    Database.use((db) => {
      db.insert(ProjectTable)
        .values({
          id: projectID,
          worktree: "/tmp/project",
          vcs: "git",
          name: "project",
          time_created: now,
          time_updated: now,
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
      db.insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "queue",
          directory: "/tmp/project",
          title: "queue",
          version: "1",
          time_created: now,
          time_updated: now,
        })
        .run()
    })
  }

  test("persists fifo queue and cascades on session delete", () =>
    Effect.gen(function* () {
      seedSession()
      yield* PromptQueue.sqliteEnqueue(sessionID, sampleData("one"))
      yield* PromptQueue.sqliteEnqueue(sessionID, sampleData("two"))
      const listed = yield* PromptQueue.sqliteList(sessionID)
      expect(
        listed.map((item) => (item.data.parts[0]?.type === "text" ? item.data.parts[0].text : "")),
      ).toEqual(["one", "two"])
      const head = yield* PromptQueue.sqliteDequeue(sessionID)
      expect(head?.data.parts[0]?.type === "text" ? head.data.parts[0].text : "").toBe("one")
      yield* Effect.sync(() =>
        Database.use((db) => db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()),
      )
      const remaining = yield* PromptQueue.sqliteList(sessionID)
      expect(remaining).toEqual([])
    }).pipe(Effect.runPromise))
})

describe("PromptQueue sqlite durability", () => {
  test("survives a fresh list after enqueue", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.make("ses_queue_restart")
      const projectID = ProjectID.make("project_queue_restart")
      const now = Date.now()
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({
            id: projectID,
            worktree: "/tmp/project",
            vcs: "git",
            name: "project",
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
        db.insert(SessionTable)
          .values({
            id: sessionID,
            project_id: projectID,
            slug: "queue-restart",
            directory: "/tmp/project",
            title: "queue-restart",
            version: "1",
            time_created: now,
            time_updated: now,
          })
          .run()
      })

      yield* PromptQueue.sqliteEnqueue(sessionID, sampleData("persisted"))
      const listed = yield* PromptQueue.sqliteList(sessionID)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.data.parts[0]?.type === "text" ? listed[0].data.parts[0].text : "").toBe("persisted")
    }).pipe(Effect.runPromise))
})

describe("materializeQueuedItem", () => {
  test("assigns immediate delivery and fresh ids", () => {
    const sessionID = SessionID.make("ses_materialize")
    const item = new MemoryPromptQueue().enqueue(sessionID, sampleData("hello"))
    const message = materializeQueuedItem(item)
    expect(message.info.role).toBe("user")
    if (message.info.role === "user") expect(message.info.delivery).toBe("immediate")
    expect(message.parts[0]?.type === "text" ? message.parts[0].text : "").toBe("hello")
    expect(message.info.id).not.toBe(item.id)
  })
})
