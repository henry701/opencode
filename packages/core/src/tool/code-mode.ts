export * as CodeModeTool from "./code-mode"

import { CodeMode, Tool, toolError } from "@opencode-ai/codemode"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FeatureFlag } from "../feature-flag"
import { MCP } from "../mcp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { make, withPermission, type Content } from "./tool"
import { Tools } from "./tools"

export const name = "execute"
export const Input = CodeMode.Input
const File = Schema.Struct({ data: Schema.String, mime: Schema.String, name: Schema.optional(Schema.String) })
export const Output = Schema.Struct({
  value: Schema.Unknown,
  logs: Schema.optional(Schema.Array(Schema.String)),
  files: Schema.Array(File),
})
export type Output = typeof Output.Type

type Entry = MCP.Tool & { readonly path: string }

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const flags = yield* FeatureFlag.Service
    if (!flags.codeMode) return
    const mcp = yield* MCP.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const owner = yield* Scope.Scope
    let current: Scope.Closeable | undefined

    const refresh = Effect.fn("CodeModeTool.refresh")(function* () {
      const entries = (yield* mcp.tool.list()).map((item) => ({
        ...item,
        path: `${MCP.sanitize(item.server)}.${MCP.sanitize(item.name)}`,
      }))
      const next = yield* Scope.fork(owner)
      yield* tools
        .register(
          entries.length === 0
            ? {}
            : {
                [name]: withPermission(
                  make({
                    description: [
                      "Run a confined orchestration script with access to connected MCP tools.",
                      CodeMode.make({ tools: tree(entries, () => () => Effect.die("preview")) }).instructions(),
                    ].join("\n\n"),
                    input: Input,
                    output: Output,
                    toModelOutput: ({ output }) => content(output),
                    execute: (input, context) => {
                      const files: Output["files"][number][] = []
                      const runtime = CodeMode.make({
                        tools: tree(entries, (entry) => (arguments_) =>
                          permission
                            .assert({
                              action: MCP.toolName(entry.server, entry.name),
                              resources: ["*"],
                              save: ["*"],
                              sessionID: context.sessionID,
                              agent: context.agent,
                              source: {
                                type: "tool",
                                messageID: context.assistantMessageID,
                                callID: context.toolCallID,
                              },
                            })
                            .pipe(
                              Effect.mapError(() => toolError(`Permission denied: ${entry.path}`)),
                              Effect.andThen(
                                mcp.tool.call({
                                  server: entry.server,
                                  name: entry.name,
                                  arguments: isRecord(arguments_) ? arguments_ : {},
                                }),
                              ),
                              Effect.map((result) => project(result, files)),
                              Effect.mapError((error) =>
                                error instanceof Error && error.name === "ToolError"
                                  ? error
                                  : toolError(error instanceof Error ? error.message : String(error)),
                              ),
                            ),
                        ),
                      })
                      return runtime.execute(input.code).pipe(
                        Effect.flatMap((result) => {
                          if (!result.ok) {
                            const hints = (result.error.suggestions ?? []).filter(
                              (hint) => !result.error.message.includes(hint),
                            )
                            const logs = result.logs?.length ? `\n\nLogs:\n${result.logs.join("\n")}` : ""
                            return Effect.fail(
                              new ToolFailure({ message: `${[result.error.message, ...hints].join("\n")}${logs}` }),
                            )
                          }
                          return Effect.succeed({ value: result.value, logs: result.logs, files })
                        }),
                      )
                    },
                  }),
                  name,
                ),
              },
        )
        .pipe(Scope.provide(next), Effect.orDie)
      const previous = current
      current = next
      if (previous) yield* Scope.close(previous, Exit.void)
    })

    yield* refresh()
    yield* mcp.tool.changes().pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const node = makeLocationNode({
  name: "tool/code-mode",
  layer,
  deps: [FeatureFlag.node, MCP.node, ToolRegistry.toolsNode, PermissionV2.node],
})

function tree(entries: readonly Entry[], run: (entry: Entry) => (input: unknown) => Effect.Effect<unknown, unknown>) {
  const result: Record<string, Record<string, Tool.Definition>> = {}
  for (const entry of entries) {
    const server = MCP.sanitize(entry.server)
    const namespace = (result[server] ??= {})
    namespace[MCP.sanitize(entry.name)] = Tool.make({
      description: entry.description ?? "",
      input: entry.inputSchema as Tool.JsonSchema,
      output: entry.outputSchema as Tool.JsonSchema | undefined,
      run: run(entry),
    })
  }
  return result
}

function project(value: unknown, files: Output["files"][number][]) {
  if (!isRecord(value)) return value
  if (value.structuredContent !== undefined) return value.structuredContent
  const text: string[] = []
  for (const item of Array.isArray(value.content) ? value.content : []) {
    if (!isRecord(item)) continue
    if (item.type === "text" && typeof item.text === "string") text.push(item.text)
    if ((item.type === "image" || item.type === "audio") && typeof item.data === "string" && typeof item.mimeType === "string")
      files.push({ data: item.data, mime: item.mimeType })
    if (item.type !== "resource" || !isRecord(item.resource)) continue
    if (typeof item.resource.text === "string") text.push(item.resource.text)
    if (typeof item.resource.blob === "string")
      files.push({
        data: item.resource.blob,
        mime: typeof item.resource.mimeType === "string" ? item.resource.mimeType : "application/octet-stream",
        name: typeof item.resource.uri === "string" ? item.resource.uri : undefined,
      })
  }
  if (text.length > 0) return text.join("\n")
  return files.length > 0 ? `[${files.length} file${files.length === 1 ? "" : "s"} attached to the result]` : null
}

function content(output: Output): Content[] {
  const text = typeof output.value === "string" ? output.value : JSON.stringify(output.value, null, 2)
  return [
    ...(text === undefined ? [] : [{ type: "text" as const, text }]),
    ...(output.logs?.length ? [{ type: "text" as const, text: `Logs:\n${output.logs.join("\n")}` }] : []),
    ...output.files.map((file) => ({ type: "file" as const, ...file })),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
