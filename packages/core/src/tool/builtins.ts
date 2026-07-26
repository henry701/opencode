export * as BuiltInTools from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { Layer } from "effect"
import { BashTool } from "./bash"
import { CodeModeTool } from "./code-mode"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { LSPTool } from "./lsp"
import { QuestionTool } from "./question"
import { PlanExitTool } from "./plan-exit"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WriteTool } from "./write"

/**
 * Composes only the shipped Location-scoped built-in tool transforms.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools use separate scoped canonical registrations. The caller
 * intentionally supplies shared Location services once to this merged set.
 *
 */
export const node = makeLocationNode({
  name: "built-in-tools",
  layer: Layer.empty,
  deps: [
    ApplyPatchTool.node,
    BashTool.node,
    CodeModeTool.node,
    EditTool.node,
    GlobTool.node,
    GrepTool.node,
    LSPTool.node,
    PlanExitTool.node,
    QuestionTool.node,
    ReadTool.node,
    SkillTool.node,
    TaskTool.node,
    TodoWriteTool.node,
    WebFetchTool.node,
    WebSearchTool.node,
    WriteTool.node,
  ],
})
