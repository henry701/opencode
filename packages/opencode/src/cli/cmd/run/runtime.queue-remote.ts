import type { RunInput, RunPrompt } from "./types"

export function buildQueueSendPayload(input: {
  agent: string | undefined
  model: RunInput["model"]
  variant?: string
  prompt?: RunPrompt
}) {
  if (!input.prompt) return null
  return {
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    parts: [{ type: "text" as const, text: input.prompt.text }, ...input.prompt.parts],
  }
}
