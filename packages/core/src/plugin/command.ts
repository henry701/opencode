export * as CommandPlugin from "./command"

import { define } from "./internal"
import { Effect } from "effect"
import { CommandV2 } from "../command"
import { Location } from "../location"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: "command",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    yield* ctx.command.transform((draft) => {
      draft.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
        command.source = "command"
        command.hints = CommandV2.hints(command.template)
      })
      draft.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
        command.source = "command"
        command.hints = CommandV2.hints(command.template)
      })
    })
  }),
})
