import { Context, Effect, Layer } from "effect"
import { Database } from "./storage/db"
import { DataMigrationTable } from "./data-migration.sql"
import * as Log from "@opencode-ai/core/util/log"
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm"
import { queueDataFromMessage, PromptQueue } from "./queue/prompt-queue"
import { MessageV2 } from "./session/message-v2"
import { MessageTable, PartTable, SessionTable } from "./session/session.sql"
import type { SessionID } from "./session/schema"

export type Migration<R = never> = {
  name: string
  run: Effect.Effect<void, unknown, R>
}

const log = Log.create({ service: "data-migration" })

export interface Interface {}

export class Service extends Context.Service<Service, Interface>()("@opencode/DataMigration") {}

export const deferredUserMessagesToPromptQueue = Effect.gen(function* () {
  const rows = yield* Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          and(
            sql`json_extract(${MessageTable.data}, '$.role') = 'user'`,
            sql`json_extract(${MessageTable.data}, '$.delivery') = 'deferred'`,
          ),
        )
        .orderBy(asc(MessageTable.session_id), asc(MessageTable.time_created), asc(MessageTable.id))
        .all(),
    ),
  )
  if (rows.length === 0) return

  const touched = new Set<SessionID>()

  for (const row of rows) {
    const sessionID = row.session_id
    const messageID = row.id
    const info = {
      ...row.data,
      id: messageID,
      sessionID,
    } as MessageV2.Info
    if (info.role !== "user" || info.delivery !== "deferred") continue

    const partRows = Database.use((db) =>
      db.select().from(PartTable).where(eq(PartTable.message_id, messageID)).all(),
    )
    const parts = partRows.map(
      (partRow) =>
        ({
          ...partRow.data,
          id: partRow.id,
          sessionID: partRow.session_id,
          messageID: partRow.message_id,
        }) as MessageV2.Part,
    )
    const message = { info, parts } as MessageV2.WithParts

    const assistant = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          and(
            eq(MessageTable.session_id, sessionID),
            sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            sql`json_extract(${MessageTable.data}, '$.parentID') = ${messageID}`,
          ),
        )
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .get(),
    )
    const assistantMsg =
      assistant && typeof assistant.data === "object" && assistant.data !== null
        ? ({
            info: { ...assistant.data, id: assistant.id, sessionID: assistant.session_id },
            parts: Database.use((db) =>
              db
                .select()
                .from(PartTable)
                .where(eq(PartTable.message_id, assistant.id))
                .all()
                .map(
                  (partRow) =>
                    ({
                      ...partRow.data,
                      id: partRow.id,
                      sessionID: partRow.session_id,
                      messageID: partRow.message_id,
                    }) as MessageV2.Part,
                ),
            ),
          } as MessageV2.WithParts)
        : undefined
    const processed =
      assistantMsg?.info.role === "assistant" &&
      !!assistantMsg.info.finish &&
      !["tool-calls", "unknown"].includes(assistantMsg.info.finish) &&
      !MessageV2.assistantNeedsToolFollowup([message, assistantMsg], info, assistantMsg.info, assistantMsg)

    if (assistantMsg && !processed) {
      const migrated = { ...(row.data as Record<string, unknown>), delivery: "immediate" }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(MessageTable)
            .set({
              data: migrated as typeof row.data,
              time_updated: sql`${MessageTable.time_updated}`,
            })
            .where(eq(MessageTable.id, messageID))
            .run(),
        ),
      )
      continue
    }

    if (!processed) {
      const data = queueDataFromMessage(message)
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          PromptQueue.sqliteEnqueueWithDb(db, sessionID, data)
          db.delete(PartTable).where(eq(PartTable.message_id, messageID)).run()
          db.delete(MessageTable).where(eq(MessageTable.id, messageID)).run()
        }),
      )
      touched.add(sessionID)
      continue
    }

    const migrated = { ...(row.data as Record<string, unknown>), delivery: "immediate" }
    yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .update(MessageTable)
          .set({
            data: migrated as typeof row.data,
            time_updated: sql`${MessageTable.time_updated}`,
          })
          .where(eq(MessageTable.id, messageID))
          .run(),
      ),
    )
  }

  if (touched.size === 0) return
  log.info("migrated deferred user messages to prompt queue", { sessions: touched.size })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const migrations: Migration[] = [
      {
        name: "session_usage_from_messages",
        run: Effect.gen(function* () {
          type Usage = {
            cost: number
            tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
          }

          for (let cursor: SessionID | undefined, page = 1; ; page++) {
            const next = yield* Effect.gen(function* () {
              const sessions = yield* Effect.sync(() =>
                Database.use((db) =>
                  db
                    .select({ id: SessionTable.id })
                    .from(SessionTable)
                    .where(cursor ? gt(SessionTable.id, cursor) : undefined)
                    .orderBy(asc(SessionTable.id))
                    .limit(100)
                    .all(),
                ),
              )
              if (sessions.length === 0) return

              yield* Effect.sync(() =>
                Database.transaction((db) => {
                  const usageBySession = new Map<SessionID, Usage>(
                    sessions.map((session) => [
                      session.id,
                      { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                    ]),
                  )

                  for (const row of db
                    .select({
                      session_id: MessageTable.session_id,
                      cost: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.cost'), 0)), 0)`,
                      tokens_input: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.input'), 0)), 0)`,
                      tokens_output: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.output'), 0)), 0)`,
                      tokens_reasoning: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.reasoning'), 0)), 0)`,
                      tokens_cache_read: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.read'), 0)), 0)`,
                      tokens_cache_write: sql<number>`coalesce(sum(coalesce(json_extract(${MessageTable.data}, '$.tokens.cache.write'), 0)), 0)`,
                    })
                    .from(MessageTable)
                    .where(
                      and(
                        inArray(
                          MessageTable.session_id,
                          sessions.map((session) => session.id),
                        ),
                        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
                      ),
                    )
                    .groupBy(MessageTable.session_id)
                    .all()) {
                    const current = usageBySession.get(row.session_id)
                    if (!current) continue
                    current.cost = row.cost
                    current.tokens.input = row.tokens_input
                    current.tokens.output = row.tokens_output
                    current.tokens.reasoning = row.tokens_reasoning
                    current.tokens.cache.read = row.tokens_cache_read
                    current.tokens.cache.write = row.tokens_cache_write
                  }

                  for (const [sessionID, value] of usageBySession) {
                    db.update(SessionTable)
                      .set({
                        cost: value.cost,
                        tokens_input: value.tokens.input,
                        tokens_output: value.tokens.output,
                        tokens_reasoning: value.tokens.reasoning,
                        tokens_cache_read: value.tokens.cache.read,
                        tokens_cache_write: value.tokens.cache.write,
                        time_updated: sql`${SessionTable.time_updated}`,
                      })
                      .where(eq(SessionTable.id, sessionID))
                      .run()
                  }
                }),
              )

              return sessions.at(-1)?.id
            }).pipe(
              Effect.withSpan("DataMigration.sessionUsage.page", {
                attributes: {
                  "data_migration.name": "session_usage_from_messages",
                  "data_migration.page": page,
                  "data_migration.cursor": cursor ?? "",
                },
              }),
            )
            if (!next) return
            cursor = next
            yield* Effect.sleep("10 millis")
          }
        }),
      },
      {
        name: "deferred_user_messages_to_prompt_queue",
        run: deferredUserMessagesToPromptQueue,
      },
    ]

    yield* Effect.gen(function* () {
      if (migrations.length === 0) return

      for (const migration of migrations) {
        const completed = Database.use((db) =>
          db
            .select({ name: DataMigrationTable.name })
            .from(DataMigrationTable)
            .where(eq(DataMigrationTable.name, migration.name))
            .get(),
        )
        if (completed) continue

        log.info("running data migration", { name: migration.name })
        yield* migration.run.pipe(Effect.withSpan("DataMigration", { attributes: { name: migration.name } }))
        Database.use((db) =>
          db
            .insert(DataMigrationTable)
            .values({ name: migration.name, time_completed: Date.now() })
            .onConflictDoNothing()
            .run(),
        )
      }
    }).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("failed to run data migrations").pipe(Effect.annotateLogs("cause", cause)),
      ),
      Effect.ignore,
    )
    return Service.of({})
  }),
)

export const defaultLayer = layer

export * as DataMigration from "./data-migration"
