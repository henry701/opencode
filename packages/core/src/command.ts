export * as CommandV2 from "./command"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema, Scope, Types } from "effect"
import { Command } from "@opencode-ai/schema/command"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { State } from "./state"
import { AppProcess } from "./process"
import { Config } from "./config"
import { Location } from "./location"
import { Shell } from "./shell"
import { ChildProcess } from "effect/unstable/process"

export const Info = Command.Info
export type Info = Command.Info

export type Data = {
  commands: Map<string, Types.DeepMutable<Info>>
  resolvers: Map<string, Resolver>
}

export type Resolver = (arguments_: readonly string[]) => Effect.Effect<string, EvaluationError>

export type BeforeInput = {
  readonly command: string
  readonly sessionID: string
  readonly arguments: string
}

export type BeforeOutput = {
  parts: SessionInputPayload.Part[]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Command.NotFoundError", {
  command: Schema.String,
  available: Schema.Array(Schema.String),
}) {}

export class EvaluationError extends Schema.TaggedErrorClass<EvaluationError>()("Command.EvaluationError", {
  command: Schema.String,
  message: Schema.String,
}) {}

export type Draft = {
  list: () => readonly Info[]
  get: (name: string) => Info | undefined
  update: (name: string, update: (command: Types.DeepMutable<Info>) => void) => void
  resolve: (name: string, resolver: Resolver) => void
  remove: (name: string) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly evaluate: (input: {
    readonly name: string
    readonly arguments?: string
  }) => Effect.Effect<{ readonly text: string }, NotFoundError | EvaluationError>
  readonly execute: {
    readonly before: (
      callback: (input: BeforeInput, output: BeforeOutput) => Effect.Effect<void> | void,
    ) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly trigger: (input: BeforeInput, output: BeforeOutput) => Effect.Effect<BeforeOutput>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    let beforeHooks: ((input: BeforeInput, output: BeforeOutput) => Effect.Effect<void> | void)[] = []
    const state = State.create<Data, Draft>({
      initial: () => ({ commands: new Map(), resolvers: new Map() }),
      draft: (draft) => ({
        list: () => Array.from(draft.commands.values()) as Info[],
        get: (name) => draft.commands.get(name),
        update: (name, update) => {
          const current =
            draft.commands.get(name) ?? ({ name, template: "", hints: [] } as Types.DeepMutable<Info>)
          if (!draft.commands.has(name)) draft.commands.set(name, current)
          update(current)
          current.name = name
        },
        resolve: (name, resolver) => {
          draft.resolvers.set(name, resolver)
        },
        remove: (name) => {
          draft.commands.delete(name)
          draft.resolvers.delete(name)
        },
      }),
    })

    const service = Service.of({
      reload: state.reload,
      transform: state.transform,
      get: Effect.fn("CommandV2.get")(function* (name) {
        return state.get().commands.get(name)
      }),
      list: Effect.fn("CommandV2.list")(function* () {
        return Array.from(state.get().commands.values())
      }),
      evaluate: Effect.fn("CommandV2.evaluate")(function* (input) {
        const command = state.get().commands.get(input.name)
        if (!command)
          return yield* new NotFoundError({
            command: input.name,
            available: Array.from(state.get().commands.keys()).toSorted(),
          })
        const arguments_ = parseArguments(input.arguments ?? "")
        const resolver = state.get().resolvers.get(input.name)
        if (resolver) return { text: (yield* resolver(arguments_)).trim() }
        return {
          text: yield* evaluateShell(
            input.name,
            evaluateArguments(command.template ?? "", input.arguments ?? ""),
            config,
            location,
            processes,
          ),
        }
      }),
      execute: {
        before: Effect.fn("CommandV2.execute.before")(function* (callback) {
          const scope = yield* Scope.Scope
          let active = true
          beforeHooks = [...beforeHooks, callback]
          const dispose = Effect.sync(() => {
            if (!active) return
            active = false
            beforeHooks = beforeHooks.filter((item) => item !== callback)
          })
          yield* Scope.addFinalizer(scope, dispose)
          return { dispose }
        }),
        trigger: Effect.fn("CommandV2.execute.trigger")(function* (input, output) {
          for (const hook of beforeHooks) {
            const result = hook(input, output)
            if (Effect.isEffect(result)) yield* result
          }
          return output
        }),
      },
    })
    return service
  }),
)

export function hints(template: string) {
  return [
    ...new Set(template.match(placeholderRegex) ?? []),
    ...(template.includes("$ARGUMENTS") ? ["$ARGUMENTS"] : []),
  ].toSorted()
}

function evaluateArguments(template: string, input: string) {
  const args = parseArguments(input)
  const placeholders = template.match(placeholderRegex) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  const expanded = template.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const argIndex = position - 1
    if (argIndex >= args.length) return ""
    if (position === last) return args.slice(argIndex).join(" ")
    return args[argIndex] ?? ""
  })
  const withArguments = expanded.replaceAll("$ARGUMENTS", input)
  if (placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim())
    return `${withArguments}\n\n${input}`.trim()
  return withArguments.trim()
}

const evaluateShell = Effect.fnUntraced(function* (
  command: string,
  text: string,
  config: Config.Interface,
  location: Location.Info,
  processes: AppProcess.Interface,
) {
  const matches = Array.from(text.matchAll(shellRegex))
  if (matches.length === 0) return text
  const shell = Shell.preferred(Config.latest(yield* config.entries(), "shell"))
  if (!shell) return yield* new EvaluationError({ command, message: "No shell is available" })
  const outputs = yield* Effect.forEach(
    matches,
    (match) =>
      processes
        .run(ChildProcess.make(shell, Shell.args(shell, match[1] ?? "", location.directory), { stdin: "ignore" }))
        .pipe(
          Effect.map((result) => result.stdout.toString("utf8").trim()),
          Effect.mapError(
            (error) =>
              new EvaluationError({
                command,
                message: `Shell interpolation failed for ${JSON.stringify(match[1] ?? "")}: ${error.message}`,
              }),
          ),
        ),
    { concurrency: 2 },
  )
  const iterator = outputs[Symbol.iterator]()
  return text.replace(shellRegex, () => iterator.next().value ?? "")
})

function parseArguments(input: string) {
  return (input.match(argsRegex) ?? []).map((arg) => arg.replace(quoteTrimRegex, ""))
}

const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
const shellRegex = /!`([^`]+)`/g

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AppProcess.node, Config.node, Location.node],
})
