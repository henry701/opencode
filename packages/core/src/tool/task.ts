export * as TaskTool from "./task"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "task"

export const Input = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Set only to continue a previous task. The prior task ID resumes the same child session instead of creating a fresh one.",
  }),
  command: Schema.String.pipe(Schema.optional).annotate({ description: "The command that triggered this task" }),
})

export const Output = Schema.Struct({
  sessionID: Schema.String,
  result: Schema.String,
})

export const renderOutput = (output: typeof Output.Type) =>
  [
    `<task id="${output.sessionID}" state="completed">`,
    "<task_result>",
    output.result,
    "</task_result>",
    "</task>",
  ].join("\n")

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Launch a configured subagent in a durable child session and wait for its result. Use task_id only to continue a child task returned by an earlier call.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: renderOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const available = (yield* agents.all()).filter(
                (agent) => !agent.hidden && (agent.mode === "subagent" || agent.mode === "all"),
              )
              if (!available.some((agent) => agent.id === input.subagent_type))
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `Unknown subagent type: ${input.subagent_type}. Available: ${available.map((agent) => agent.id).join(", ") || "none"}`,
                  }),
                )
              yield* permission
                .assert({
                  action: name,
                  resources: [input.subagent_type],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
                .pipe(
                  Effect.mapError(() => new ToolFailure({ message: `Permission denied: task ${input.subagent_type}` })),
                )
              if (!context.task)
                return yield* Effect.fail(new ToolFailure({ message: "Task execution is unavailable in this runtime" }))
              return yield* context.task({
                description: input.description,
                prompt: input.prompt,
                subagentType: input.subagent_type,
                taskID: input.task_id,
                command: input.command,
              })
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/task",
  layer,
  deps: [AgentV2.node, PermissionV2.node, ToolRegistry.node],
})
