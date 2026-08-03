import { describe, expect, test } from "bun:test"
import { projectPreparedContext } from "../../src/session/prepared-context"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type Assistant = Extract<SessionV1.Info, { role: "assistant" }>

const assistant = (id: string, prepared = false): SessionV1.WithParts => ({
  info: {
    id: id as Assistant["id"],
    sessionID: "ses_test" as Assistant["sessionID"],
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_parent" as SessionV1.MessageID,
    modelID: "model" as Assistant["modelID"],
    providerID: "provider" as Assistant["providerID"],
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(prepared ? { system_prompt: "system", tool_defs: "tools" } : {}),
  },
  parts: [],
})

describe("projectPreparedContext", () => {
  test("keeps prepared metadata only on the first assistant", () => {
    const messages = [assistant("msg_1", true), assistant("msg_2", true)]
    const projected = projectPreparedContext(messages)

    expect(projected[0]?.info).toMatchObject({ system_prompt: "system", tool_defs: "tools" })
    expect(projected[1]?.info).not.toHaveProperty("system_prompt")
    expect(projected[1]?.info).not.toHaveProperty("tool_defs")
    expect(messages[1]?.info).toHaveProperty("system_prompt")
  })
})
