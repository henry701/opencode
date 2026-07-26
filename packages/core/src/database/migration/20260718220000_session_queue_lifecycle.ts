import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { Prompt } from "@opencode-ai/schema/prompt"
import type { DatabaseMigration } from "../migration"

const QUEUE_PAYLOAD = "__opencodeQueue"
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const decodePayload = Schema.decodeUnknownSync(SessionInputPayload.Payload)
const encodePayload = Schema.encodeSync(SessionInputPayload.Payload)
const encodePrompt = Schema.encodeSync(Prompt)

export default {
  id: "20260718220000_session_queue_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX \`session_input_session_pending_delivery_seq_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`discarded_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      const rows = yield* tx.all<{ id: string; prompt: string }>(
        sql`SELECT id, prompt FROM session_input WHERE delivery = 'queue' AND promoted_seq IS NULL`,
      )
      yield* Effect.forEach(
        rows,
        (row) => {
          const stored = decodeJson(row.prompt)
          if (typeof stored !== "object" || stored === null || !(QUEUE_PAYLOAD in stored)) return Effect.void
          const payload = decodePayload((stored as Record<string, unknown>)[QUEUE_PAYLOAD])
          return tx.run(sql`
            UPDATE session_input
            SET
              payload = ${JSON.stringify(encodePayload(payload))},
              prompt = ${JSON.stringify(encodePrompt(SessionInputPayload.toPrompt(payload)))}
            WHERE id = ${row.id}
          `)
        },
        { discard: true },
      )
    })
  },
} satisfies DatabaseMigration.Migration
