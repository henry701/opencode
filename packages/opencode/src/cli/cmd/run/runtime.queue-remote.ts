import type { RunInput, RunPrompt } from "./types"

type QueueDetailPart = RunPrompt["parts"][number] & {
  type: string
  text?: string
  synthetic?: boolean
}

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

export function runPromptFromQueueDetail(input: { id: string; parts?: readonly QueueDetailPart[] }): RunPrompt {
  const parts = input.parts ?? []
  return {
    text: parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text ?? ""] : []))
      .join("\n"),
    parts: parts.filter((part): part is RunPrompt["parts"][number] => part.type !== "text"),
    queueID: input.id,
    queued: true,
  }
}
