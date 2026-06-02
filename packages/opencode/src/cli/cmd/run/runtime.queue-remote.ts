import type { RunInput, RunPrompt } from "./types"

export function buildQueuePromptPayload(input: {
  agent: string | undefined
  model: RunInput["model"]
  variant?: string
  prompt: RunPrompt
}) {
  return {
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    parts: [{ type: "text" as const, text: input.prompt.text }, ...input.prompt.parts],
  }
}

export function buildQueueSendPayload(input: {
  agent: string | undefined
  model: RunInput["model"]
  variant?: string
  prompt?: RunPrompt
}) {
  if (!input.prompt) return null
  return buildQueuePromptPayload({
    agent: input.agent,
    model: input.model,
    variant: input.variant,
    prompt: input.prompt,
  })
}
