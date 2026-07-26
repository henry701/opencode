export * as PlanExitTool from "./plan-exit"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { QuestionV2 } from "../question"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "plan_exit"
export const Input = Schema.Struct({})
export const Output = Schema.Struct({ transitioned: Schema.Boolean })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const question = yield* QuestionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Ask the user to approve the completed plan. On approval, switch to the build agent and continue from the plan.",
            input: Input,
            output: Output,
            toModelOutput: () => [
              {
                type: "text",
                text: "User approved switching to the build agent. Continue with the approved plan.",
              },
            ],
            execute: (_, context) =>
              Effect.gen(function* () {
                const transition = context.transition
                if (!transition) return yield* new ToolFailure({ message: "Agent transition is unavailable" })
                const answers = yield* question
                  .ask({
                    sessionID: context.sessionID,
                    questions: [
                      {
                        question: "The plan is complete. Switch to the build agent and start implementing it?",
                        header: "Build Agent",
                        custom: false,
                        options: [
                          { label: "Yes", description: "Switch to build and execute the plan" },
                          { label: "No", description: "Stay in plan mode and continue refining it" },
                        ],
                      },
                    ],
                    tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.mapError(() => new ToolFailure({ message: "Plan approval was dismissed" })))
                if (answers[0]?.[0] !== "Yes")
                  return yield* new ToolFailure({ message: "The user chose to remain in plan mode" })
                yield* transition({
                  agent: AgentV2.defaultID,
                  text: "The plan has been approved. You can now edit files and execute it.",
                })
                return { transitioned: true }
              }),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/plan-exit",
  layer,
  deps: [ToolRegistry.node, QuestionV2.node],
})
