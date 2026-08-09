import { describe, expect, test } from "bun:test"
import { InvalidProviderOutputReason, LLMError } from "@opencode-ai/llm"
import { ProviderError } from "@/provider/error"

describe("ProviderError.parseStreamError", () => {
  test("parses OpenAI-compatible direct stream error chunks", () => {
    expect(
      ProviderError.parseStreamError({
        error: { type: "server_error", code: "server_error", message: "temporarily unavailable" },
      }),
    ).toEqual({
      type: "api_error",
      message: "temporarily unavailable",
      isRetryable: true,
      responseBody: JSON.stringify({
        error: { type: "server_error", code: "server_error", message: "temporarily unavailable" },
      }),
    })
  })

  test("continues parsing wrapped stream error chunks", () => {
    expect(
      ProviderError.parseStreamError({
        type: "error",
        error: { code: "server_error", message: "temporarily unavailable" },
      })?.type,
    ).toBe("api_error")
  })

  test("parses raw chunks carried by an LLM stream error", () => {
    const error = new LLMError({
      module: "ProviderShared",
      method: "stream",
      reason: new InvalidProviderOutputReason({
        route: "openai-compatible-chat",
        message: "Invalid openai-compatible-chat stream event",
        raw: JSON.stringify({ error: { code: "server_error", message: "temporarily unavailable" } }),
      }),
    })

    expect(ProviderError.parseStreamError(error)).toEqual({
      type: "api_error",
      message: "temporarily unavailable",
      isRetryable: true,
      responseBody: JSON.stringify({ error: { code: "server_error", message: "temporarily unavailable" } }),
    })
  })
})
