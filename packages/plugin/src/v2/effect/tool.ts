import type { Effect, Schema, Scope } from "effect"

type ToolSchema = Schema.Codec<any, any, never, never>

export interface ToolContext {
  readonly sessionID: string
  readonly agent: string
  readonly assistantMessageID: string
  readonly toolCallID: string
}

export interface ToolDefinition<Input extends ToolSchema = ToolSchema, Output extends ToolSchema = ToolSchema> {
  readonly description: string
  readonly input: Input
  readonly output: Output
  readonly execute: (
    input: Schema.Schema.Type<Input>,
    context: ToolContext,
  ) => Effect.Effect<Schema.Schema.Type<Output>, never>
  readonly toModelOutput?: (input: {
    readonly input: Schema.Schema.Type<Input>
    readonly output: Output["Encoded"]
  }) => ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "file"; readonly data: string; readonly mime: string; readonly name?: string }
  >
}

export interface ToolDomain {
  readonly register: (tools: Readonly<Record<string, ToolDefinition>>) => Effect.Effect<void, never, Scope.Scope>
}
