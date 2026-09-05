import { and, eq, gte, isNull, lte, or } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"

// Replacement is opt-in; the upstream revert contract retains its boundary.
export const commitReplacement = Effect.fn("SessionRevert.commitReplacement")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  revert: NonNullable<SessionSchema.Info["revert"]>,
) {
  const message = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, revert.messageID)))
    .get()
    .pipe(Effect.orDie)
  const input = yield* db
    .select()
    .from(SessionInputTable)
    .where(and(eq(SessionInputTable.session_id, sessionID), eq(SessionInputTable.id, revert.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!message && (!input || input.delivery !== "steer" || input.promoted_seq !== null || input.discarded_seq !== null))
    return yield* Effect.die(`Replacement boundary not found: ${revert.messageID}`)
  if (message)
    yield* db
      .delete(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), gte(SessionMessageTable.seq, message.seq)))
      .run()
      .pipe(Effect.orDie)
  yield* db
    .delete(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        or(
          message ? gte(SessionInputTable.promoted_seq, message.seq) : undefined,
          and(
            eq(SessionInputTable.delivery, "steer"),
            isNull(SessionInputTable.promoted_seq),
            gte(SessionInputTable.admitted_seq, input?.admitted_seq ?? message!.seq),
            // Do not discard the replacement admitted after staging, or explicit queues.
            lte(SessionInputTable.admitted_seq, revert.inputThroughSeq ?? 0),
          ),
        ),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})
