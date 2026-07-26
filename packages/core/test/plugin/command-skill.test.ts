import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CommandV2 } from "@opencode-ai/core/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { CommandSkillPlugin } from "@opencode-ai/core/plugin/command-skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { location } from "../fixture/location"
import { host } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([CommandV2.node, SkillV2.node]), [[Location.node, locationLayer]]),
)

describe("CommandSkillPlugin.Plugin", () => {
  it.effect("adds slash-enabled skills without overriding existing commands", () =>
    Effect.gen(function* () {
      const command = yield* CommandV2.Service
      const skill = yield* SkillV2.Service
      yield* skill.transform((draft) => {
        draft.source({
          type: "embedded",
          skill: {
            name: "deploy",
            description: "Deploy production",
            location: AbsolutePath.make("/repo/.opencode/skills/deploy/SKILL.md"),
            content: "Deploy safely.",
          },
        })
        draft.source({
          type: "embedded",
          skill: {
            name: "hidden",
            slash: false,
            location: AbsolutePath.make("/repo/.opencode/skills/hidden/SKILL.md"),
            content: "Hidden.",
          },
        })
        draft.source({
          type: "embedded",
          skill: {
            name: "review",
            location: AbsolutePath.make("/repo/.opencode/skills/review/SKILL.md"),
            content: "Skill review.",
          },
        })
      })
      yield* command.transform((draft) =>
        draft.update("review", (item) => {
          item.template = "Built-in review."
          item.source = "command"
        }),
      )

      yield* CommandSkillPlugin.Plugin.effect(
        host({
          command: { transform: command.transform, reload: command.reload, execute: command.execute },
        }),
      ).pipe(Effect.provideService(SkillV2.Service, skill))

      expect(yield* command.get("deploy")).toMatchObject({
        name: "deploy",
        description: "Deploy production",
        source: "skill",
        hints: [],
      })
      expect((yield* command.get("deploy"))?.template).toContain(
        "Base directory for this skill: /repo/.opencode/skills/deploy",
      )
      expect(yield* command.get("hidden")).toBeUndefined()
      expect(yield* command.get("review")).toMatchObject({
        template: "Built-in review.",
        source: "command",
      })
    }),
  )
})
