import type { CommandV2Info, SessionInputPayloadPart } from "@opencode-ai/sdk/v2/types"
import type { Effect, Scope } from "effect"
import type { Hooks } from "./registration.js"

export interface CommandInfo extends Omit<CommandV2Info, "hints"> {
  hints?: ReadonlyArray<string>
}

export interface CommandDraft {
  list(): readonly CommandInfo[]
  get(name: string): CommandInfo | undefined
  update(name: string, update: (command: CommandInfo) => void): void
  remove(name: string): void
}

export interface CommandExecuteBeforeInput {
  readonly command: string
  readonly sessionID: string
  readonly arguments: string
}

export interface CommandExecuteBeforeOutput {
  parts: Array<SessionInputPayloadPart>
}

export type CommandHooks = Hooks<{ transform: CommandDraft }> & {
  readonly execute: {
    readonly before: (
      callback: (
        input: CommandExecuteBeforeInput,
        output: CommandExecuteBeforeOutput,
      ) => Effect.Effect<void> | void,
    ) => Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope.Scope>
  }
}
