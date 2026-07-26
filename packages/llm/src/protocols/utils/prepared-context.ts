import type { JsonSchema } from "../../schema"
import type { PreparedContext as Context } from "../../route/protocol"

type Tool = {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

export const make = (system: ReadonlyArray<string>, tools: ReadonlyArray<Tool>): Context => {
  const systemPrompt = system
    .filter((part) => part.length > 0)
    .join("\n")
    .trim()
  const toolDefinitions =
    tools.length === 0
      ? undefined
      : JSON.stringify(
          Object.fromEntries(
            tools
              .toSorted((a, b) => a.name.localeCompare(b.name))
              .map((tool) => [
                tool.name,
                {
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                },
              ]),
          ),
        )
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(toolDefinitions ? { toolDefinitions } : {}),
  }
}

export * as PreparedContext from "./prepared-context"
