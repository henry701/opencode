export * as MCPTools from "./mcp"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Exit, JsonSchema, Layer, Schema, Scope, Stream } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { MCP } from "../mcp"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

const ResourceListInput = Schema.Struct({
  server: Schema.optional(Schema.String).annotate({
    description: "MCP server name. Omit to list resources from every connected server.",
  }),
})
const ResourceReadInput = Schema.Struct({
  server: Schema.String.annotate({ description: "MCP server name" }),
  uri: Schema.String.annotate({ description: "Exact MCP resource URI" }),
})
const JsonOutput = Schema.Unknown

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const owner = yield* Scope.Scope
    let current: Scope.Closeable | undefined

    const authorize = (context: Tool.Context, action: string, resources: readonly string[]) =>
      permission
        .assert({
          action,
          resources: [...resources],
          save: ["*"],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        .pipe(Effect.mapError(() => new ToolFailure({ message: `Permission denied: ${action}` })))

    const refresh = Effect.fn("MCPTools.refresh")(function* () {
      const next = yield* Scope.fork(owner)
      const definitions = Object.fromEntries(
        (yield* mcp.tool.list()).map((item) => {
          const name = MCP.toolName(item.server, item.name)
          return [
            name,
            Tool.withPermission(
              Tool.make({
                description: item.description ?? `Run ${item.name} on the ${item.server} MCP server.`,
                input: Schema.Unknown,
                inputJsonSchema: normalizeInputSchema(item.inputSchema),
                output: JsonOutput,
                execute: (input, context) =>
                  Effect.gen(function* () {
                    yield* authorize(context, name, ["*"])
                    return yield* mcp.tool.call({
                      server: item.server,
                      name: item.name,
                      arguments: isRecord(input) ? input : {},
                    })
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }),
                    ),
                  ),
                toModelOutput: ({ output }) => mcpContent(output),
              }),
              name,
            ),
          ]
        }),
      )
      const resources = yield* mcp.resource.available()
      yield* tools
        .register({
          ...definitions,
          ...(resources
            ? {
                list_mcp_resources: Tool.withPermission(
                  Tool.make({
                    description:
                      "List resources provided by connected MCP servers. Resources provide application-specific context.",
                    input: ResourceListInput,
                    output: JsonOutput,
                    execute: (input, context) =>
                      authorize(context, "read", [input.server ? `mcp:${input.server}:*` : "mcp:*"]).pipe(
                        Effect.andThen(mcp.resource.list(input.server)),
                      ),
                    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
                  }),
                  "read",
                ),
                list_mcp_resource_templates: Tool.withPermission(
                  Tool.make({
                    description: "List parameterized resource templates provided by connected MCP servers.",
                    input: ResourceListInput,
                    output: JsonOutput,
                    execute: (input, context) =>
                      authorize(context, "read", [input.server ? `mcp:${input.server}:*` : "mcp:*"]).pipe(
                        Effect.andThen(mcp.resource.templates(input.server)),
                      ),
                    toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output, null, 2) }],
                  }),
                  "read",
                ),
                read_mcp_resource: Tool.withPermission(
                  Tool.make({
                    description: "Read a resource from an MCP server using its exact server name and URI.",
                    input: ResourceReadInput,
                    output: JsonOutput,
                    execute: (input, context) =>
                      authorize(context, "read", [`mcp:${input.server}:${input.uri}`]).pipe(
                        Effect.andThen(mcp.resource.read(input)),
                        Effect.mapError((error) =>
                          error instanceof ToolFailure ? error : new ToolFailure({ message: error.message }),
                        ),
                      ),
                    toModelOutput: ({ output }) => resourceContent(output),
                  }),
                  "read",
                ),
              }
            : {}),
        })
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
  name: "tool/mcp",
  layer,
  deps: [MCP.node, ToolRegistry.toolsNode, PermissionV2.node],
})

function normalizeInputSchema(input: MCP.Tool["inputSchema"]): JsonSchema.JsonSchema {
  return {
    ...input,
    type: "object",
    properties: input.properties ?? {},
    additionalProperties: false,
  } as JsonSchema.JsonSchema
}

function mcpContent(value: unknown): Tool.Content[] {
  if (!isRecord(value)) return [{ type: "text", text: JSON.stringify(value) }]
  const content = Array.isArray(value.content) ? value.content : []
  const projected = content.flatMap((item): Tool.Content[] => {
    if (!isRecord(item) || typeof item.type !== "string") return []
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }]
    if (
      (item.type === "image" || item.type === "audio") &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    )
      return [{ type: "file", data: item.data, mime: item.mimeType }]
    if (item.type !== "resource" || !isRecord(item.resource)) return []
    if (typeof item.resource.text === "string") return [{ type: "text", text: item.resource.text }]
    if (typeof item.resource.blob !== "string") return []
    return [
      {
        type: "file",
        data: item.resource.blob,
        mime: typeof item.resource.mimeType === "string" ? item.resource.mimeType : "application/octet-stream",
        name: typeof item.resource.uri === "string" ? item.resource.uri : undefined,
      },
    ]
  })
  if (projected.length > 0) return projected
  if (value.structuredContent !== undefined)
    return [{ type: "text", text: JSON.stringify(value.structuredContent, null, 2) }]
  return [{ type: "text", text: "MCP tool returned no content." }]
}

function resourceContent(value: unknown): Tool.Content[] {
  if (!isRecord(value) || !Array.isArray(value.contents))
    return [{ type: "text", text: JSON.stringify(value, null, 2) }]
  const projected = value.contents.flatMap((item): Tool.Content[] => {
    if (!isRecord(item)) return []
    if (typeof item.text === "string") return [{ type: "text", text: item.text }]
    if (typeof item.blob !== "string") return []
    return [
      {
        type: "file",
        data: item.blob,
        mime: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
        name: typeof item.uri === "string" ? item.uri : undefined,
      },
    ]
  })
  return projected.length > 0 ? projected : [{ type: "text", text: "MCP resource returned no content." }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
