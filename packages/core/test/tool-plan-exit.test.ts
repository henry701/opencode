import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { PlanExitTool } from "@opencode-ai/core/tool/plan-exit"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_plan_exit_tool_test")
let answer = "Yes"
let transitioned: Tool.TransitionInput | undefined
const capturedTransition = () => transitioned

const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: () => Effect.succeed([[answer]]),
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, PlanExitTool.node]), [
    [QuestionV2.node, question],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

describe("PlanExitTool", () => {
  it.effect("asks for approval and queues the build-agent transition through the runner", () =>
    Effect.gen(function* () {
      answer = "Yes"
      transitioned = undefined
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      expect(definitions.map((definition) => definition.name)).toEqual(["plan_exit"])

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-plan", name: "plan_exit", input: {} },
        transition: (input) =>
          Effect.sync(() => {
            transitioned = input
          }),
      })

      expect(settled.result).toEqual({
        type: "text",
        value: "User approved switching to the build agent. Continue with the approved plan.",
      })
      expect(capturedTransition()).toEqual({
        agent: AgentV2.defaultID,
        text: "The plan has been approved. You can now edit files and execute it.",
      })
    }),
  )

  it.effect("does not transition when the user declines", () =>
    Effect.gen(function* () {
      answer = "No"
      transitioned = undefined
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-plan-no", name: "plan_exit", input: {} },
        transition: () => Effect.die("must not transition"),
      })
      expect(settled.result.type).toBe("error")
      expect(transitioned).toBeUndefined()
    }),
  )
})
