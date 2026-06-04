import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { deferredUserMessagesToPromptQueue } from "@/data-migration"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { MessageTable, PartTable, PromptQueueTable, SessionTable } from "@/session/session.sql"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Database } from "@/storage/db"
import type { MessageV2 } from "@/session/message-v2"

function seedSession(sessionID: SessionID) {
  const now = Date.now()
  const projectID = ProjectID.make(`project_${sessionID}`)
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
        slug: sessionID,
        directory: "/tmp/project",
        title: sessionID,
        version: "1",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
}

function insertMessage(input: {
  id: MessageID
  sessionID: SessionID
  time: number
  data: typeof MessageTable.$inferInsert.data
}) {
  Database.use((db) =>
    db
      .insert(MessageTable)
      .values({
        id: input.id,
        session_id: input.sessionID,
        time_created: input.time,
        time_updated: input.time,
        data: input.data,
      })
      .run(),
  )
}

describe("data migrations", () => {
  test("deferred user migration uses the latest assistant row for processed detection", async () => {
    const sessionID = SessionID.make("ses_data_migration_deferred_latest")
    const userID = MessageID.ascending()
    const firstAssistantID = MessageID.ascending()
    const latestAssistantID = MessageID.ascending()
    const textPartID = PartID.ascending()
    const now = Date.now()

    seedSession(sessionID)
    insertMessage({
      id: userID,
      sessionID,
      time: now,
      data: {
        role: "user",
        time: { created: now },
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        delivery: "deferred",
      } satisfies Omit<MessageV2.User, "id" | "sessionID">,
    })
    const partRow = {
      id: textPartID,
      message_id: userID,
      session_id: sessionID,
      time_created: now,
      time_updated: now,
      data: { type: "text", text: "already handled" } as typeof PartTable.$inferInsert.data,
    } satisfies typeof PartTable.$inferInsert
    Database.use((db) =>
      db
        .insert(PartTable)
        .values(partRow)
        .run(),
    )
    insertMessage({
      id: firstAssistantID,
      sessionID,
      time: now + 1,
      data: {
        role: "assistant",
        time: { created: now + 1 },
        parentID: userID,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/project", root: "/tmp/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "tool-calls",
      } satisfies Omit<MessageV2.Assistant, "id" | "sessionID">,
    })
    insertMessage({
      id: latestAssistantID,
      sessionID,
      time: now + 2,
      data: {
        role: "assistant",
        time: { created: now + 2, completed: now + 2 },
        parentID: userID,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp/project", root: "/tmp/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      } satisfies Omit<MessageV2.Assistant, "id" | "sessionID">,
    })

    await Effect.runPromise(deferredUserMessagesToPromptQueue)

    const user = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, userID)).get())
    expect(user?.data).toEqual(
      expect.objectContaining({
        role: "user",
        delivery: "immediate",
      }),
    )
    expect(Database.use((db) => db.select().from(PromptQueueTable).where(eq(PromptQueueTable.session_id, sessionID)).all()))
      .toEqual([])
    expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.message_id, userID)).all())).toHaveLength(1)
  })
})
