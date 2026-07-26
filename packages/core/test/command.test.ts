import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const directory = AbsolutePath.make(process.cwd())
const it = testEffect(
  AppNodeBuilder.build(CommandV2.node, [
    [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
    [
      Location.node,
      Layer.succeed(
        Location.Service,
        Location.Service.of(location(Location.Ref.make({ directory }))),
      ),
    ],
  ]),
)

describe("CommandV2", () => {
  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
          command.source = "command"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          source: "command",
          hints: [],
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        CommandV2.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          source: "command",
          hints: [],
          model: {
            id: ModelV2.ID.make("claude"),
            providerID: ProviderV2.ID.make("anthropic"),
            variant: ModelV2.VariantID.make("high"),
          },
        }),
      ])
    }),
  )

  it.effect("evaluates arguments, stdout-only shell blocks, and trims substitutions", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      yield* command.transform((editor) => {
        editor.update("review", (item) => {
          item.template = "First=$1 Rest=$2 Shell=!`printf ' value '; printf 'ignored' >&2`"
          item.source = "command"
        })
      })

      expect(yield* command.evaluate({ name: "review", arguments: '"one item" two three' })).toEqual({
        text: "First=one item Rest=two three Shell=value",
      })
    }),
  )

  it.effect("supports lazy command resolution without exposing an eager placeholder", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      let resolutions = 0
      yield* command.transform((editor) => {
        editor.update("server:prompt", (item) => {
          item.template = ""
          item.description = "MCP prompt"
          item.source = "mcp"
          item.hints = ["$1"]
        })
        editor.resolve("server:prompt", (arguments_) =>
          Effect.sync(() => {
            resolutions++
            return `Resolved ${arguments_[0] ?? ""}`
          }),
        )
      })

      expect(yield* command.get("server:prompt")).toMatchObject({
        name: "server:prompt",
        source: "mcp",
        hints: ["$1"],
      })
      expect(resolutions).toBe(0)
      expect(yield* command.evaluate({ name: "server:prompt", arguments: "value" })).toEqual({
        text: "Resolved value",
      })
      expect(resolutions).toBe(1)
    }),
  )
})
