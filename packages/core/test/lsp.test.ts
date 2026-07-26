import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { ConfigLSP } from "@opencode-ai/core/config/lsp"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FeatureFlag } from "@opencode-ai/core/feature-flag"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { LSP } from "@opencode-ai/core/lsp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { LSPTool } from "@opencode-ai/core/tool/lsp"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { Effect, Layer } from "effect"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { executeTool, toolDefinitions } from "./lib/tool"

const fixture = path.join(import.meta.dir, "fixture", "lsp-stdio.ts")

const run = (directory: string, entries: Config.Entry[]) =>
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const file = path.join(directory, "index.ts")
    yield* Effect.promise(() => fs.writeFile(file, "const value = true\n"))
    yield* lsp.touchFile(file, "document")
    return {
      status: yield* lsp.status(),
      diagnostics: yield* lsp.diagnostics(),
      definition: yield* lsp.definition({ file, line: 0, character: 1 }),
    }
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([LSP.node]), [
        [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) })))],
        [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(entries) }))],
      ]),
    ),
  )

test("LSP is inert without explicit configuration", async () => {
  await using tmp = await tmpdir()
  const result = await Effect.runPromise(Effect.scoped(run(tmp.path, [])))
  expect(result).toEqual({ status: [], diagnostics: {}, definition: [] })
})

test("configured stdio LSP initializes, receives a touch, and returns diagnostics and definitions", async () => {
  await using tmp = await tmpdir()
  const result = await Effect.runPromise(
    Effect.scoped(
      run(tmp.path, [
        new Config.Document({
          type: "document",
          info: {
            lsp: {
              fixture: new ConfigLSP.Server({ command: [process.execPath, fixture], extensions: [".ts"] }),
            },
          },
        }),
      ]),
    ),
  )
  expect(result.status).toEqual([{ id: "fixture", root: ".", status: "connected" }])
  expect(result.diagnostics[path.join(tmp.path, "index.ts")]).toMatchObject([
    { severity: 1, source: "fixture", message: "fixture diagnostic" },
  ])
  expect(result.definition).toHaveLength(1)
})

test("experimental LSP tool resolves files and delegates one-based positions", async () => {
  await using tmp = await tmpdir()
  const file = path.join(tmp.path, "tool.ts")
  await fs.writeFile(file, "const value = true\n")
  const canonical = await fs.realpath(file)
  const positions: LSP.Position[] = []
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
  )
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        expect((yield* toolDefinitions(registry)).map((item) => item.name)).toEqual(["lsp"])
        return yield* executeTool(registry, {
          sessionID: SessionV2.ID.make("ses_lsp_tool_test"),
          agent: AgentV2.defaultID,
          assistantMessageID: SessionMessage.ID.make("msg_lsp_tool_test"),
          call: {
            type: "tool-call",
            id: "call-lsp",
            name: "lsp",
            input: { operation: "goToDefinition", path: "tool.ts", line: 2, character: 3 },
          },
        })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              ToolRegistry.node,
              ToolRegistry.toolsNode,
              LocationMutation.node,
              FileMutation.node,
              LSPTool.node,
            ]),
            [
              [Location.node, activeLocation],
              [FeatureFlag.node, Layer.succeed(FeatureFlag.Service, FeatureFlag.Service.of({ codeMode: false, lspTool: true }))],
              [LSP.node, Layer.succeed(LSP.Service, LSP.Service.of({
                ...LSP.inert,
                hasClients: () => Effect.succeed(true),
                touchFile: () => Effect.void,
                definition: (position) => Effect.sync(() => positions.push(position)).pipe(Effect.as([{ uri: "fixture" }])),
              }))],
              [PermissionV2.node, Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
                assert: () => Effect.void,
                ask: () => Effect.die("unused"), reply: () => Effect.die("unused"), get: () => Effect.die("unused"),
                forSession: () => Effect.die("unused"), list: () => Effect.die("unused"),
              }))],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          ),
        ),
      ),
    ),
  )
  expect(result).toEqual({ type: "text", value: '[\n  {\n    "uri": "fixture"\n  }\n]' })
  expect(positions).toEqual([{ file: canonical, line: 1, character: 2 }])
})
