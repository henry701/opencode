export * as CommandMCPPlugin from "./command-mcp"

import { Effect, Stream } from "effect"
import { CommandV2 } from "../command"
import { MCP } from "../mcp"
import { define } from "./internal"

export const Plugin = define({
  id: "command-mcp",
  effect: Effect.fn(function* () {
    const command = yield* CommandV2.Service
    const mcp = yield* MCP.Service
    yield* command.transform(
      Effect.fn(function* (draft) {
        for (const prompt of yield* mcp.prompt.list()) {
          const name = MCP.sanitize(prompt.server) + ":" + MCP.sanitize(prompt.name)
          draft.update(name, (command) => {
            command.template = ""
            command.source = "mcp"
            command.hints = prompt.arguments.map((_, index) => `$${index + 1}`)
            delete command.agent
            delete command.model
            delete command.subtask
            if (prompt.description === undefined) delete command.description
            else command.description = prompt.description
          })
          draft.resolve(name, (arguments_) =>
            mcp.prompt
              .get({
                server: prompt.server,
                name: prompt.name,
                arguments: Object.fromEntries(
                  prompt.arguments.map((argument, index) => [argument.name, arguments_[index] ?? ""]),
                ),
              })
              .pipe(
                Effect.flatMap((text) =>
                  text === undefined
                    ? Effect.fail(
                        new CommandV2.EvaluationError({
                          command: name,
                          message: `Failed to load MCP prompt "${prompt.name}" from "${prompt.server}"`,
                        }),
                      )
                    : Effect.succeed(text),
                ),
              ),
          )
        }
      }),
    )
    yield* mcp.prompt.changes().pipe(
      Stream.runForEach(() => command.reload()),
      Effect.forkScoped,
    )
  }),
})
