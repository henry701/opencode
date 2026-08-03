export * as SessionInput from "./input"

import { and, asc, desc, eq, isNull, lte } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Admitted, Delivery, Queued } from "@opencode-ai/schema/session-input"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export { Admitted, Delivery, Queued }

const decodePrompt = Schema.decodeUnknownSync(Prompt)
const encodePrompt = Schema.encodeSync(Prompt)
const decodePayload = Schema.decodeUnknownSync(SessionInputPayload.Payload)
const encodePayload = Schema.encodeSync(SessionInputPayload.Payload)

const fromRow = (row: typeof SessionInputTable.$inferSelect): Admitted =>
  Admitted.make({
    admittedSeq: row.admitted_seq,
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    prompt: decodePrompt(row.prompt),
    ...(row.payload === null ? {} : { payload: decodePayload(row.payload) }),
    delivery: row.delivery,
    timeCreated: DateTime.makeUnsafe(row.time_created),
    ...(row.promoted_seq === null ? {} : { promotedSeq: row.promoted_seq }),
    ...(row.updated_seq === null ? {} : { updatedSeq: row.updated_seq }),
    ...(row.discarded_seq === null ? {} : { discardedSeq: row.discarded_seq }),
  })

export const find = Effect.fn("SessionInput.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export class LifecycleConflict extends Schema.TaggedErrorClass<LifecycleConflict>()("SessionInput.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

export const admit = Effect.fn("SessionInput.admit")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload?: SessionInputPayload.Payload
    readonly delivery: Delivery
  },
) {
  const existing = yield* find(db, input.id)
  if (existing !== undefined) return existing
  const timestamp = yield* DateTime.now
  return yield* events
    .publish(SessionEvent.PromptAdmitted, {
      messageID: input.id,
      sessionID: input.sessionID,
      timestamp,
      prompt: input.prompt,
      payload: input.payload,
      delivery: input.delivery,
    })
    .pipe(
      Effect.flatMap((event) =>
        event.durable === undefined
          ? Effect.die("Prompt admission event is missing aggregate sequence")
          : Effect.succeed(
              Admitted.make({
                admittedSeq: event.durable.seq,
                id: input.id,
                sessionID: input.sessionID,
                prompt: input.prompt,
                payload: input.payload,
                delivery: input.delivery,
                timeCreated: timestamp,
              }),
            ),
      ),
      Effect.catchDefect((defect) =>
        find(db, input.id).pipe(Effect.flatMap((stored) => (stored ? Effect.succeed(stored) : Effect.die(defect)))),
      ),
    )
})

export const projectAdmitted = Effect.fn("SessionInput.projectAdmitted")(function* (
  db: DatabaseService,
  input: {
    readonly admittedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload?: SessionInputPayload.Payload
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, input.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const stored = yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      admitted_seq: input.admittedSeq,
      prompt: encodePrompt(input.prompt),
      payload: input.payload === undefined ? null : encodePayload(input.payload),
      delivery: input.delivery,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectPrompted = Effect.fn("SessionInput.projectPrompted")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload?: SessionInputPayload.Payload
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ promoted_seq: input.promotedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (updated) {
    const stored = fromRow(updated)
    if (!matchesProjection(stored, input)) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  const stored = yield* find(db, input.id)
  if (stored) {
    if (!matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
      return yield* Effect.die(new LifecycleConflict({ id: input.id }))
    return
  }

  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      payload: input.payload === undefined ? null : encodePayload(input.payload),
      delivery: input.delivery,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .run()
    .pipe(Effect.orDie)
})

export const synthesizeProjected = Effect.fn("SessionInput.synthesizeProjected")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload: SessionInputPayload.Payload
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
    readonly promotedSeq: number
  },
) {
  yield* db
    .insert(SessionInputTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      prompt: encodePrompt(input.prompt),
      payload: encodePayload(input.payload),
      delivery: input.delivery,
      admitted_seq: input.promotedSeq,
      promoted_seq: input.promotedSeq,
      time_created: DateTime.toEpochMillis(input.timeCreated),
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const stored = yield* find(db, input.id)
  if (!stored || !matchesProjection(stored, input) || stored.promotedSeq !== input.promotedSeq)
    return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return stored
})

export const hasPending = Effect.fn("SessionInput.hasPending")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
        eq(SessionInputTable.delivery, delivery),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row !== undefined
})

export const nextForPromotion = Effect.fn("SessionInput.nextForPromotion")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  delivery: Delivery,
  cutoff: number,
) {
  const steer = yield* db
    .select({ payload: SessionInputTable.payload })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(desc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (steer) return { payload: steer.payload === null ? undefined : decodePayload(steer.payload) }
  if (delivery !== "queue") return
  const queued = yield* db
    .select({ payload: SessionInputTable.payload })
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
        eq(SessionInputTable.delivery, "queue"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return queued ? { payload: queued.payload === null ? undefined : decodePayload(queued.payload) } : undefined
})

export const equivalent = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload?: SessionInputPayload.Payload
    readonly delivery: Delivery
  },
) => input.delivery === expected.delivery && matchesPrompt(input, expected) && matchesPayload(input, expected)

const matchesPrompt = (input: Admitted, expected: { readonly sessionID: SessionSchema.ID; readonly prompt: Prompt }) =>
  input.sessionID === expected.sessionID &&
  JSON.stringify(encodePrompt(input.prompt)) === JSON.stringify(encodePrompt(expected.prompt))

const matchesPayload = (input: Admitted, expected: { readonly payload?: SessionInputPayload.Payload }) =>
  JSON.stringify(input.payload === undefined ? undefined : encodePayload(input.payload)) ===
  JSON.stringify(expected.payload === undefined ? undefined : encodePayload(expected.payload))

const matchesProjection = (
  input: Admitted,
  expected: {
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly delivery: Delivery
    readonly timeCreated: DateTime.Utc
  },
) => equivalent(input, expected) && DateTime.toEpochMillis(input.timeCreated) === DateTime.toEpochMillis(expected.timeCreated)

const publish = Effect.fn("SessionInput.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  rows: ReadonlyArray<typeof SessionInputTable.$inferSelect>,
) {
  for (const row of rows) {
    const id = SessionMessage.ID.make(row.id)
    yield* events
      .publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: DateTime.makeUnsafe(row.time_created),
        messageID: id,
        prompt: decodePrompt(row.prompt),
        ...(row.payload === null ? {} : { payload: decodePayload(row.payload) }),
        delivery: row.delivery,
      })
      .pipe(
        Effect.catchDefect((defect) =>
          defect instanceof LifecycleConflict
            ? find(db, id).pipe(
                Effect.flatMap((stored) => (stored?.promotedSeq === undefined ? Effect.die(defect) : Effect.void)),
              )
            : Effect.die(defect),
        ),
      )
  }
  return rows.length
})

export const promoteSteers = Effect.fn("SessionInput.promoteSteers")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
        eq(SessionInputTable.delivery, "steer"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  return yield* publish(db, events, sessionID, rows)
})

export const promoteNextQueued = Effect.fn("SessionInput.promoteNextQueued")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  cutoff: number,
) {
  const row = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
        eq(SessionInputTable.delivery, "queue"),
        lte(SessionInputTable.admitted_seq, cutoff),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? false : yield* publish(db, events, sessionID, [row]).pipe(Effect.as(true))
})

export const listQueued = Effect.fn("SessionInput.listQueued")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const rows = yield* db
    .select()
    .from(SessionInputTable)
    .where(
      and(
        eq(SessionInputTable.session_id, sessionID),
        eq(SessionInputTable.delivery, "queue"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
      ),
    )
    .orderBy(asc(SessionInputTable.admitted_seq))
    .all()
    .pipe(Effect.orDie)
  // Prompt-only queue records predate typed queue payloads. They remain
  // drainable by the runner but cannot be edited through the typed queue API.
  return rows
    .filter((row) => row.payload !== null)
    .map((row, position) =>
      Queued.make({
        id: SessionMessage.ID.make(row.id),
        sessionID,
        position,
        timeCreated: DateTime.makeUnsafe(row.time_created),
        payload: decodePayload(row.payload!),
      }),
    )
})

export const getQueued = Effect.fn("SessionInput.getQueued")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
) {
  const rows = yield* listQueued(db, sessionID)
  return rows.find((row) => row.id === id)
})

export const projectRevised = Effect.fn("SessionInput.projectRevised")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload: SessionInputPayload.Payload
    readonly updatedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({
      prompt: encodePrompt(input.prompt),
      payload: encodePayload(input.payload),
      updated_seq: input.updatedSeq,
    })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.delivery, "queue"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
      ),
    )
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDiscarded = Effect.fn("SessionInput.projectDiscarded")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly discardedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({ discarded_seq: input.discardedSeq })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.delivery, "queue"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
      ),
    )
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectExpedited = Effect.fn("SessionInput.projectExpedited")(function* (
  db: DatabaseService,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly prompt: Prompt
    readonly payload: SessionInputPayload.Payload
    readonly updatedSeq: number
  },
) {
  const updated = yield* db
    .update(SessionInputTable)
    .set({
      prompt: encodePrompt(input.prompt),
      payload: encodePayload(input.payload),
      delivery: "steer",
      updated_seq: input.updatedSeq,
    })
    .where(
      and(
        eq(SessionInputTable.id, input.id),
        eq(SessionInputTable.session_id, input.sessionID),
        eq(SessionInputTable.delivery, "queue"),
        isNull(SessionInputTable.promoted_seq),
        isNull(SessionInputTable.discarded_seq),
      ),
    )
    .returning({ id: SessionInputTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const revise = Effect.fn("SessionInput.revise")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly payload: SessionInputPayload.Payload
  },
) {
  yield* events.publish(SessionEvent.PromptRevised, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    messageID: input.id,
    prompt: SessionInputPayload.toPrompt(input.payload),
    payload: input.payload,
  })
})

export const discard = Effect.fn("SessionInput.discard")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID },
) {
  yield* events.publish(SessionEvent.PromptDiscarded, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    messageID: input.id,
  })
})

export const expedite = Effect.fn("SessionInput.expedite")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly payload?: SessionInputPayload.Payload
  },
) {
  const queued = yield* getQueued(db, input.sessionID, input.id)
  if (!queued) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  const payload = input.payload ?? queued.payload
  yield* events.publish(SessionEvent.PromptExpedited, {
    sessionID: input.sessionID,
    timestamp: yield* DateTime.now,
    messageID: input.id,
    prompt: SessionInputPayload.toPrompt(payload),
    payload,
  })
  const stored = yield* find(db, input.id)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return stored
})
