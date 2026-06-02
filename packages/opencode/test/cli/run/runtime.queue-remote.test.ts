import { describe, expect, test } from "bun:test"
import { buildQueuePromptPayload, buildQueueSendPayload } from "@/cli/cmd/run/runtime.queue-remote"
import { ModelID, ProviderID } from "@/provider/schema"

describe("run remote queue payloads", () => {
  test("enqueue and update payloads preserve the active variant", () => {
    expect(
      buildQueuePromptPayload({
        agent: "build",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "minimal",
        prompt: {
          text: "queued",
          parts: [{ type: "text", text: "context" }],
        },
      }),
    ).toEqual({
      agent: "build",
      model: { providerID: "test", modelID: "test-model" },
      variant: "minimal",
      parts: [
        { type: "text", text: "queued" },
        { type: "text", text: "context" },
      ],
    })
  })

  test("edited send-now uses PromptPayload top-level fields", () => {
    expect(
      buildQueueSendPayload({
        agent: "plan",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "fast",
        prompt: {
          text: "edited",
          parts: [{ type: "text", text: "extra" }],
          queueID: "pqu_test",
        },
      }),
    ).toEqual({
      agent: "plan",
      model: { providerID: "test", modelID: "test-model" },
      variant: "fast",
      parts: [
        { type: "text", text: "edited" },
        { type: "text", text: "extra" },
      ],
    })
  })

  test("uses null body for unedited send-now so server uses stored queue data", () => {
    expect(
      buildQueueSendPayload({
        agent: "plan",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        variant: "fast",
      }),
    ).toBeNull()
  })
})
