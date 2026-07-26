import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260718215959_add_session_input_lifecycle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`payload\` text;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`updated_seq\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_input\` ADD \`discarded_seq\` integer;`)
    })
  },
} satisfies DatabaseMigration.Migration
