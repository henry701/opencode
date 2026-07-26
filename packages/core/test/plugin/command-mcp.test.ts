import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MCP } from "@opencode-ai/core/mcp"
import { CommandMCPPlugin } from "@opencode-ai/core/plugin/command-mcp"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
)
const it = testEffect(LayerNode.compile(CommandV2.node, [[Location.node, locationLayer]]))

describe("CommandMCPPlugin.Plugin", () => {
  it.effect("projects prompts lazily and fully replaces colliding command metadata", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      const calls: Array<{ server: string; name: string; arguments: Record<string, string> }> = []
      const mcp = MCP.Service.of({
        status: () => Effect.succeed({}),
        add: () => Effect.succeed({}),
        connect: () => Effect.void,
        disconnect: () => Effect.void,
        auth: {
          start: () => Effect.die("unused MCP auth.start"),
          finish: () => Effect.die("unused MCP auth.finish"),
          remove: () => Effect.die("unused MCP auth.remove"),
        },
        instructions: () => Effect.succeed([]),
        tool: {
          changes: () => Stream.never,
          list: () => Effect.succeed([]),
          call: () => Effect.die("unused MCP tool.call"),
        },
        prompt: {
          changes: () => Stream.never,
          list: () =>
            Effect.succeed([
              {
                server: "docs server",
                name: "review.code",
                description: "Review with MCP",
                arguments: [{ name: "target", required: true }, { name: "focus" }],
              },
            ]),
          get: (input) =>
            Effect.sync(() => {
              calls.push(input)
              return `Review ${input.arguments.target} for ${input.arguments.focus}`
            }),
        },
        resource: {
          available: () => Effect.succeed(false),
          changes: () => Stream.never,
          list: () => Effect.succeed([]),
          templates: () => Effect.succeed([]),
          read: () => Effect.die("unused MCP resource.read"),
        },
      })

      yield* command.transform((draft) => {
        draft.update("docs_server:review_code", (item) => {
          item.template = "stale"
          item.description = "stale"
          item.agent = "reviewer"
          item.model = {
            providerID: ProviderV2.ID.make("anthropic"),
            id: ModelV2.ID.make("claude"),
          }
          item.subtask = true
        })
      })

      yield* CommandMCPPlugin.Plugin.effect(
        host({ command: { transform: command.transform, reload: command.reload, execute: command.execute } }),
      ).pipe(Effect.provideService(MCP.Service, mcp))

      expect(calls).toEqual([])
      expect(yield* command.get("docs_server:review_code")).toEqual({
        name: "docs_server:review_code",
        template: "",
        description: "Review with MCP",
        source: "mcp",
        hints: ["$1", "$2"],
      })
      expect(yield* command.evaluate({ name: "docs_server:review_code", arguments: '"src app" security' })).toEqual({
        text: "Review src app for security",
      })
      expect(calls).toEqual([
        {
          server: "docs server",
          name: "review.code",
          arguments: { target: "src app", focus: "security" },
        },
      ])
    }),
  )
})
