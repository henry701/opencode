import type { SessionMessage } from "@opencode-ai/schema/session-message"

export type SessionContextBreakdownKey = "system" | "user" | "assistant" | "tool" | "toolDefs" | "other"

export type SessionContextBreakdownSegment = {
  key: SessionContextBreakdownKey
  tokens: number
  width: number
  percent: number
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4)
const toPercent = (tokens: number, input: number) => (tokens / input) * 100
const toPercentLabel = (tokens: number, input: number) => Math.round(toPercent(tokens, input) * 10) / 10

const userChars = (message: SessionMessage.User) => {
  if (!message.payload) {
    return (
      message.text.length +
      (message.files ?? []).reduce((sum, file) => sum + (file.name?.length ?? 0) + file.uri.length, 0) +
      (message.agents ?? []).reduce((sum, agent) => sum + agent.name.length + (agent.source?.text.length ?? 0), 0)
    )
  }
  return message.payload.parts.reduce((sum, part) => {
    if (part.type === "text") return sum + part.text.length
    if (part.type === "file") return sum + (part.source?.text.value.length ?? part.url.length)
    if (part.type === "agent") return sum + (part.source?.value.length ?? part.name.length)
    return sum + part.prompt.length
  }, 0)
}

const contentChars = (content: SessionMessage.AssistantContent) => {
  if (content.type === "text" || content.type === "reasoning") return { assistant: content.text.length, tool: 0 }
  const input =
    typeof content.state.input === "string" ? content.state.input.length : JSON.stringify(content.state.input).length
  if (content.state.status === "pending") return { assistant: 0, tool: input }
  const output = content.state.content.reduce(
    (sum, item) => sum + (item.type === "text" ? item.text.length : item.uri.length + (item.name?.length ?? 0)),
    0,
  )
  if (content.state.status === "error") return { assistant: 0, tool: input + output + content.state.error.message.length }
  return { assistant: 0, tool: input + output }
}

const build = (
  tokens: { system: number; user: number; assistant: number; tool: number; toolDefs: number; other: number },
  input: number,
) => {
  return [
    { key: "system", tokens: tokens.system },
    { key: "toolDefs", tokens: tokens.toolDefs },
    { key: "user", tokens: tokens.user },
    { key: "assistant", tokens: tokens.assistant },
    { key: "tool", tokens: tokens.tool },
    { key: "other", tokens: tokens.other },
  ]
    .filter((item) => item.tokens > 0)
    .map((item) => ({
      key: item.key,
      tokens: item.tokens,
      width: toPercent(item.tokens, input),
      percent: toPercentLabel(item.tokens, input),
    })) as SessionContextBreakdownSegment[]
}

export function estimateSessionContextBreakdown(args: {
  messages: readonly SessionMessage.Message[]
  input: number
  systemPrompt?: string
  toolDefinitions?: string
}) {
  if (!args.input) return []

  const counts = args.messages.reduce(
    (acc, message) => {
      if (message.type === "user") return { ...acc, user: acc.user + userChars(message) }
      if (message.type === "shell")
        return {
          ...acc,
          user: acc.user + message.command.length,
          tool: acc.tool + message.output.length,
        }
      if (message.type !== "assistant") return acc
      const content = message.content.reduce(
        (sum, item) => {
          const next = contentChars(item)
          return {
            assistant: sum.assistant + next.assistant,
            tool: sum.tool + next.tool,
          }
        },
        { assistant: 0, tool: 0 },
      )
      return {
        ...acc,
        assistant: acc.assistant + content.assistant,
        tool: acc.tool + content.tool,
      }
    },
    {
      system: args.systemPrompt?.length ?? 0,
      user: 0,
      assistant: 0,
      tool: 0,
      toolDefs: args.toolDefinitions?.length ?? 0,
    },
  )

  const tokens = {
    system: estimateTokens(counts.system),
    user: estimateTokens(counts.user),
    assistant: estimateTokens(counts.assistant),
    tool: estimateTokens(counts.tool),
    toolDefs: estimateTokens(counts.toolDefs),
  }
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool + tokens.toolDefs

  if (estimated <= args.input) return build({ ...tokens, other: args.input - estimated }, args.input)

  const scale = args.input / estimated
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
    toolDefs: Math.floor(tokens.toolDefs * scale),
  }
  const total = scaled.system + scaled.user + scaled.assistant + scaled.tool + scaled.toolDefs
  return build({ ...scaled, other: Math.max(0, args.input - total) }, args.input)
}
