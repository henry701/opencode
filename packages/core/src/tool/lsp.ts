export * as LSPTool from "./lsp"

import { pathToFileURL } from "node:url"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FeatureFlag } from "../feature-flag"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { LSP } from "../lsp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "lsp"
const Operation = Schema.Literals([
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
])
export const Input = Schema.Struct({
  operation: Operation,
  path: Schema.String,
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  query: Schema.optional(Schema.String),
})
export const Output = Schema.Struct({ result: Schema.Array(Schema.Unknown) })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!(yield* FeatureFlag.Service).lspTool) return
    const tools = yield* Tools.Service
    const lsp = yield* LSP.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Use a configured Language Server Protocol server for definitions, references, hover, symbols, implementations, and call hierarchy queries.",
            input: Input,
            output: Output,
            toModelOutput: ({ input, output }) => [
              {
                type: "text",
                text:
                  output.result.length === 0
                    ? `No results found for ${input.operation}`
                    : JSON.stringify(output.result, null, 2),
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                if (target.externalDirectory)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(target.externalDirectory),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                yield* permission.assert({
                  action: name,
                  resources: ["*"],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                if ((yield* fs.stat(target.canonical)).type !== "File")
                  return yield* new ToolFailure({ message: `File not found: ${input.path}` })
                if (!(yield* lsp.hasClients(target.canonical)))
                  return yield* new ToolFailure({ message: "No LSP server available for this file type." })
                yield* lsp.touchFile(target.canonical, "document")
                const position = { file: target.canonical, line: input.line - 1, character: input.character - 1 }
                const result = yield* (() => {
                  switch (input.operation) {
                    case "goToDefinition": return lsp.definition(position)
                    case "findReferences": return lsp.references(position)
                    case "hover": return lsp.hover(position)
                    case "documentSymbol": return lsp.documentSymbol(pathToFileURL(target.canonical).href)
                    case "workspaceSymbol": return lsp.workspaceSymbol(input.query ?? "")
                    case "goToImplementation": return lsp.implementation(position)
                    case "prepareCallHierarchy": return lsp.prepareCallHierarchy(position)
                    case "incomingCalls": return lsp.incomingCalls(position)
                    case "outgoingCalls": return lsp.outgoingCalls(position)
                  }
                })()
                return { result }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure
                    ? error
                    : new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
                ),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/lsp",
  layer,
  deps: [FeatureFlag.node, LSP.node, LocationMutation.node, FSUtil.node, PermissionV2.node, ToolRegistry.node],
})
