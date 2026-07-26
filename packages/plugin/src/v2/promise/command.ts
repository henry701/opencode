import type {
  CommandDraft,
  CommandExecuteBeforeInput,
  CommandExecuteBeforeOutput,
} from "../effect/command.js"
import type { Hooks } from "./registration.js"

export type { CommandDraft }

export type CommandHooks = Hooks<{ transform: CommandDraft }> & {
  readonly execute: {
    readonly before: (
      callback: (input: CommandExecuteBeforeInput, output: CommandExecuteBeforeOutput) => Promise<void> | void,
    ) => Promise<{ readonly dispose: () => Promise<void> }>
  }
}
