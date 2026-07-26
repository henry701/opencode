import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FeatureFlag } from "@opencode-ai/core/feature-flag"
import { MCP } from "@opencode-ai/core/mcp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { CodeModeTool } from "@opencode-ai/core/tool/code-mode"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { executeTool, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_code_mode_tool_test")
const calls: unknown[] = []
const assertions: PermissionV2.AssertInput[] = []

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({ demo: { status: "connected" } }),
    add: () => Effect.die("unused"),
    connect: () => Effect.die("unused"),
    disconnect: () => Effect.die("unused"),
    auth: { start: () => Effect.die("unused"), finish: () => Effect.die("unused"), remove: () => Effect.die("unused") },
    instructions: () => Effect.succeed([]),
    tool: {
      changes: () => Stream.empty,
      list: () =>
        Effect.succeed([
          {
            server: "demo",
            name: "lookup",
            description: "Look up a value",
            inputSchema: {
              type: "object" as const,
              properties: { query: { type: "string" as const } },
              required: ["query"],
            },
          },
        ]),
      call: (input) =>
        Effect.sync(() => calls.push(input)).pipe(
          Effect.as({ content: [{ type: "text" as const, text: `found:${String(input.arguments.query)}` }] }),
        ),
    },
    prompt: { changes: () => Stream.empty, list: () => Effect.succeed([]), get: () => Effect.succeed(undefined) },
    resource: {
      changes: () => Stream.empty,
      available: () => Effect.succeed(false),
      list: () => Effect.succeed([]),
      templates: () => Effect.succeed([]),
      read: () => Effect.die("unused"),
    },
  }),
)

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, CodeModeTool.node]), [
    [MCP.node, mcp],
    [FeatureFlag.node, Layer.succeed(FeatureFlag.Service, FeatureFlag.Service.of({ codeMode: true, lspTool: false }))],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

describe("CodeModeTool", () => {
  it.effect("runs confined code against authorized native MCP tools", () =>
    Effect.gen(function* () {
      calls.length = 0
      assertions.length = 0
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((definition) => definition.name)).toEqual(["execute"])
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-code",
          name: "execute",
          input: { code: 'return await tools.demo.lookup({ query: "queue" })' },
        },
      })
      expect(result).toEqual({ type: "text", value: "found:queue" })
      expect(calls).toMatchObject([{ server: "demo", name: "lookup", arguments: { query: "queue" } }])
      expect(assertions).toMatchObject([{ action: "demo_lookup", resources: ["*"] }])
    }),
  )
})
