import type { SessionMessage } from "@opencode-ai/schema/session-message"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: SessionMessage.Assistant
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  total: number
  usage: number | null
}

const tokenTotal = (message: SessionMessage.Assistant) => {
  const tokens = message.tokens
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

const lastAssistantWithTokens = (messages: readonly SessionMessage.Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.type !== "assistant") continue
    if (tokenTotal(message) <= 0) continue
    return message
  }
}

const build = (messages: readonly SessionMessage.Message[] = [], providers: Provider[] = []): Context | undefined => {
  const message = lastAssistantWithTokens(messages)
  if (!message?.tokens) return

  const provider = providers.find((item) => item.id === message.model.providerID)
  const model = provider?.models[message.model.id]
  const limit = model?.limit.context
  const total = tokenTotal(message)

  return {
    message,
    provider,
    model,
    providerLabel: provider?.name ?? message.model.providerID,
    modelLabel: model?.name ?? message.model.id,
    limit,
    input: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
    total,
    usage: limit ? Math.round((total / limit) * 100) : null,
  }
}

export function getSessionContext(messages: readonly SessionMessage.Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
