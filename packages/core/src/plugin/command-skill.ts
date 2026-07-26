export * as CommandSkillPlugin from "./command-skill"

import path from "path"
import { Effect } from "effect"
import { CommandV2 } from "../command"
import { SkillV2 } from "../skill"
import { define } from "./internal"

export const Plugin = define({
  id: "command-skill",
  effect: Effect.fn(function* (ctx) {
    const skill = yield* SkillV2.Service
    yield* ctx.command.transform(
      Effect.fn(function* (draft) {
        for (const item of yield* skill.list()) {
          if (item.slash === false || draft.get(item.name)) continue
          const directory = path.dirname(item.location)
          const template = [
            item.content,
            "",
            `Base directory for this skill: ${directory}`,
            "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
          ].join("\n")
          draft.update(item.name, (command) => {
            command.template = template
            command.description = item.description
            command.source = "skill"
            command.hints = CommandV2.hints(template)
          })
        }
      }),
    )
  }),
})
