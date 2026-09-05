import { expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

for (const promoted of [true, false]) {
  it.effect(
    `replacement removes its ${promoted ? "promoted" : "pending"} boundary but preserves queues and new admission`,
    () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const events = yield* EventV2.Service
        const sessionID = SessionV2.ID.make("ses_replacement")
        const id = SessionMessage.ID.make("msg_original")
        yield* database.db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        yield* database.db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "test",
            directory: "/project",
            title: "test",
            version: "test",
          })
          .run()
        const otherSessionID = SessionV2.ID.make("ses_unrelated")
        yield* database.db
          .insert(SessionTable)
          .values({
            id: otherSessionID,
            project_id: Project.ID.global,
            slug: "unrelated",
            directory: "/project",
            title: "unrelated",
            version: "test",
          })
          .run()
        yield* database.db
          .insert(SessionInputTable)
          .values([
            {
              id,
              session_id: sessionID,
              prompt: { text: "original" },
              delivery: "steer",
              admitted_seq: 1,
              promoted_seq: promoted ? 2 : null,
            },
            {
              id: SessionMessage.ID.make("msg_later"),
              session_id: sessionID,
              prompt: { text: "later steer" },
              delivery: "steer",
              admitted_seq: 3,
            },
            {
              id: SessionMessage.ID.make("msg_queue"),
              session_id: sessionID,
              prompt: { text: "queue" },
              delivery: "queue",
              admitted_seq: 4,
            },
            {
              id: SessionMessage.ID.make("msg_at_cutoff"),
              session_id: sessionID,
              prompt: { text: "last pre-stage steer" },
              delivery: "steer",
              admitted_seq: 5,
            },
            {
              id: SessionMessage.ID.make("msg_unrelated"),
              session_id: otherSessionID,
              prompt: { text: "other session" },
              delivery: "steer",
              admitted_seq: 3,
            },
            {
              id: SessionMessage.ID.make("msg_replacement"),
              session_id: sessionID,
              prompt: { text: "replacement" },
              delivery: "steer",
              admitted_seq: 6,
            },
          ])
          .run()
        if (promoted)
          yield* database.db
            .insert(SessionMessageTable)
            .values({
              id,
              session_id: sessionID,
              seq: 2,
              type: "user",
              time_created: 1,
              data: Schema.encodeSync(SessionMessage.User)(
                SessionMessage.User.make({
                  id,
                  type: "user",
                  text: "original",
                  time: { created: DateTime.makeUnsafe(1) },
                }),
              ),
            })
            .run()
        const revert = { messageID: id, inclusive: true, inputThroughSeq: 5 }
        yield* events.publish(SessionEvent.RevertEvent.Staged, { sessionID, timestamp: DateTime.makeUnsafe(1), revert })
        expect((yield* database.db.select().from(SessionInputTable).all()).length).toBe(6)
        yield* events.publish(SessionEvent.RevertEvent.Committed, {
          sessionID,
          messageID: id,
          timestamp: DateTime.makeUnsafe(2),
        })
        expect(yield* database.db.select().from(SessionMessageTable).all()).toEqual([])
        expect((yield* database.db.select().from(SessionInputTable).all()).map((row) => String(row.id)).sort()).toEqual(
          ["msg_queue", "msg_replacement", "msg_unrelated"],
        )
      }),
  )
}
