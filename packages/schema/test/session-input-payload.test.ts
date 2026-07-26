import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionInputPayload } from "../src/session-input-payload"

const payload = {
  version: 1,
  agent: "build",
  model: {
    providerID: "anthropic",
    modelID: "claude-sonnet",
    variant: "thinking",
  },
  tools: { bash: true, write: false },
  system: "Keep the response concise.",
  format: {
    type: "json_schema",
    schema: { type: "object", properties: { answer: { type: "string" } } },
    retryCount: 4,
  },
  permissions: [{ permission: "bash", pattern: "git *", action: "allow" }],
  parts: [
    {
      id: "prt_text",
      type: "text",
      text: "Inspect this",
      synthetic: true,
      ignored: false,
      time: { start: 1, end: 2 },
      metadata: { source: "queue" },
    },
    {
      id: "prt_file",
      type: "file",
      mime: "text/plain",
      filename: "notes.txt",
      url: "file:///notes.txt",
      source: { type: "file", path: "notes.txt", text: { value: "notes", start: 0, end: 7 } },
    },
    {
      id: "prt_agent",
      type: "agent",
      name: "review",
      source: { value: "@review", start: 8, end: 15 },
    },
    {
      id: "prt_subtask",
      type: "subtask",
      prompt: "Check the parser",
      description: "Parser review",
      agent: "review",
      model: { providerID: "openai", modelID: "gpt-5" },
      command: "review",
    },
  ],
} as const

describe("SessionInputPayload", () => {
  test("round-trips every queued prompt field", () => {
    const decoded = Schema.decodeUnknownSync(SessionInputPayload.Payload)(payload)
    expect(Schema.encodeSync(SessionInputPayload.Payload)(decoded)).toEqual(payload)
  })
})
