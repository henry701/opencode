import type { AssistantMessage, Part, Provider, SessionMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "./locale"
import * as Model from "./model"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  providers?: Provider[]
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const providers = Model.index(options.providers)
  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${session.id}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages.toSorted(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  )) {
    transcript += formatMessage(msg.info, msg.parts, options, providers)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatCurrentTranscript(
  session: SessionInfo,
  messages: readonly SessionMessage[],
  options: TranscriptOptions,
) {
  const providers = Model.index(options.providers)
  const body = messages
    .flatMap((message) => {
      if (message.type === "user") {
        const text = message.payload?.parts
          .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
          .join("\n\n")
        return [`## User\n\n${text || message.text}\n\n---\n\n`]
      }
      if (message.type !== "assistant") return []
      const duration = message.time.completed
        ? ((Number(message.time.completed) - Number(message.time.created)) / 1000).toFixed(1) + "s"
        : ""
      const header = options.assistantMetadata
        ? `## Assistant (${Locale.titlecase(message.agent)} · ${Model.name(providers, message.model.providerID, message.model.id)}${duration ? ` · ${duration}` : ""})\n\n`
        : "## Assistant\n\n"
      const content = message.content
        .map((part) => {
          if (part.type === "text") return `${part.text}\n\n`
          if (part.type === "reasoning") return options.thinking ? `_Thinking:_\n\n${part.text}\n\n` : ""
          let result = `**Tool: ${part.name}**\n`
          if (options.toolDetails && part.state.status !== "pending")
            result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
          if (options.toolDetails && part.state.status === "completed") {
            const output = part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
            if (output) result += `\n**Output:**\n\`\`\`\n${output}\n\`\`\`\n`
          }
          if (options.toolDetails && part.state.status === "error")
            result += `\n**Error:**\n\`\`\`\n${part.state.error.message}\n\`\`\`\n`
          return result + "\n"
        })
        .join("")
      return [header + content + "---\n\n"]
    })
    .join("")
  return `# ${session.title}\n\n**Session ID:** ${session.id}\n**Created:** ${new Date(session.time.created).toLocaleString()}\n**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n---\n\n${body}`
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata, providers ?? options.providers)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean,
  providers?: Provider[] | ReadonlyMap<string, Provider>,
): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  const modelName = Model.name(providers, msg.providerID, msg.modelID)

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${modelName}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${part.tool}**\n`
    if (options.toolDetails && part.state.input) {
      result += `\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      result += `\n**Output:**\n\`\`\`\n${part.state.output}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      result += `\n**Error:**\n\`\`\`\n${part.state.error}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
