import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageShell,
  SessionMessageUser,
} from "@opencode-ai/client/promise"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  SnapshotFileDiff,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"

type PreparedAssistant = SessionMessageAssistant & {
  system_prompt?: string
  tool_defs?: string
  systemPrompt?: string
  toolDefinitions?: string
  snapshot?: { diffs?: SnapshotFileDiff[] }
}

const emptyTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const emptyModel: { id: string; providerID: string; variant?: string } = { id: "", providerID: "" }
const decodeToolInput = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const encodeCurrentMessage = Schema.encodeSync(SessionMessage.Message)

type CurrentEncodedMessage = (typeof SessionMessage.Message)["Encoded"]

/**
 * The v2 client and the compatibility renderer use the same persisted messages
 * with a small wire-shape difference. Keep the conversion at this boundary so
 * the timeline can continue to use its stable legacy projection while current
 * events remain the source of truth for live sessions.
 */
export function normalizeCurrentSessionMessages(sessionID: string, source: readonly SessionMessage.Message[]) {
  const encoded = source.map((message) => encodeCurrentMessage(message)).map(toLegacyMessage)
  return { source: encoded, ...normalizeSessionMessages(sessionID, encoded) }
}

function toLegacyMessage(message: CurrentEncodedMessage): SessionMessageInfo {
  if (message.type === "user") {
    return {
      ...message,
      files: message.files?.map((file) => ({
        ...file,
        data: "",
        source: { type: "uri" as const, uri: file.uri },
        mention: file.source,
      })),
      agents: message.agents?.map((agent) => ({ ...agent, mention: agent.source })),
    } as SessionMessageInfo
  }
  if (message.type === "shell") {
    return {
      ...message,
      shellID: message.callID,
      status: message.time.completed === undefined ? "running" : "exited",
      output:
        message.time.completed === undefined
          ? undefined
          : {
              output: message.output,
              cursor: message.output.length,
              size: message.output.length,
              truncated: false,
            },
    } as SessionMessageInfo
  }
  if (message.type === "synthetic") return { ...message, description: message.text } as SessionMessageInfo
  if (message.type !== "assistant") return message as SessionMessageInfo
  return {
    ...message,
    content: message.content.map((content) => {
      if (content.type === "text") return { type: "text" as const, text: content.text }
      if (content.type === "reasoning")
        return {
          type: "reasoning" as const,
          text: content.text,
          state: content.providerMetadata,
          time: content.time,
        }
      return {
        type: "tool" as const,
        id: content.id,
        name: content.name,
        executed: content.provider?.executed,
        providerState: content.provider?.metadata,
        providerResultState: content.provider?.resultMetadata,
        state:
          content.state.status === "pending"
            ? { status: "streaming" as const, input: content.state.input }
            : "structured" in content.state
              ? { ...content.state, metadata: content.state.structured }
              : content.state,
        time: content.time,
      }
    }),
  } as SessionMessageInfo
}

export function compareMessages(a: Pick<Message, "id" | "time">, b: Pick<Message, "id" | "time">) {
  const left = messageKey(a)
  const right = messageKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

export const messageKey = (message: Pick<Message, "id" | "time">) => message.time.created + message.id

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeToolInput(name: string, input: Record<string, unknown>) {
  if (!["edit", "write"].includes(name) || typeof input.path !== "string" || typeof input.filePath === "string")
    return input
  return { ...input, filePath: input.path }
}

function normalizeToolMetadata(name: string, metadata: Record<string, unknown>) {
  if (name === "task" && typeof metadata.sessionID === "string" && metadata.sessionId === undefined)
    return { ...metadata, sessionId: metadata.sessionID }
  if (name !== "edit" || !Array.isArray(metadata.files)) return metadata
  const file = metadata.files.find(record)
  if (!file || typeof file.file !== "string") return metadata
  return {
    ...metadata,
    filediff: {
      file: file.file,
      patch: typeof file.patch === "string" ? file.patch : undefined,
      additions: typeof file.additions === "number" ? file.additions : 0,
      deletions: typeof file.deletions === "number" ? file.deletions : 0,
    },
  }
}

export function normalizeSessionMessages(sessionID: string, source: readonly SessionMessageInfo[]) {
  const messages: Message[] = []
  const parts = new Map<string, Part[]>()
  let agent = ""
  let model = emptyModel
  let parentID: string | undefined

  source.forEach((message) => {
    if (message.type === "agent-switched") {
      agent = message.agent
      return
    }
    if (message.type === "model-switched") {
      model = message.model
      return
    }
    if (message.type === "user") {
      parentID = message.id
      messages.push(userMessage(sessionID, message, agent, model))
      parts.set(message.id, userParts(sessionID, message))
      return
    }
    if (message.type === "synthetic" && message.description?.trim()) {
      parentID = message.id
      messages.push({
        id: message.id,
        sessionID,
        role: "user",
        time: message.time,
        agent,
        model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
      })
      parts.set(message.id, [textPart(sessionID, message.id, 0, message.description, true)])
      return
    }
    if (message.type === "shell") {
      messages.push(...shellMessages(sessionID, message, agent, model))
      parts.set(message.id, [textPart(sessionID, message.id, 0, message.command)])
      parts.set(`${message.id}:assistant`, [shellPart(sessionID, message)])
      parentID = undefined
      return
    }
    if (message.type === "assistant") {
      agent = message.agent
      model = message.model
      if (!parentID) return
      const parent = messages.findLast((item) => item.id === parentID)
      if (parent?.role === "user") {
        parent.agent = message.agent
        parent.model = {
          providerID: message.model.providerID,
          modelID: message.model.id,
          variant: message.model.variant,
        }
        const diffs = (message as PreparedAssistant).snapshot?.diffs
        if (diffs) parent.summary = { diffs }
      }
      messages.push(assistantMessage(sessionID, parentID, message))
      parts.set(message.id, assistantParts(sessionID, message))
      return
    }
    if (message.type !== "compaction" || !parentID) return
    parts.set(parentID, [
      ...(parts.get(parentID) ?? []),
      {
        id: `${message.id}:compaction`,
        sessionID,
        messageID: parentID,
        type: "compaction",
        auto: message.reason === "auto",
      },
    ])
  })

  return { messages, parts }
}

function shellMessages(
  sessionID: string,
  message: SessionMessageShell,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): [UserMessage, AssistantMessage] {
  return [
    {
      id: message.id,
      sessionID,
      role: "user",
      time: { created: message.time.created },
      agent,
      model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
    },
    {
      id: `${message.id}:assistant`,
      sessionID,
      role: "assistant",
      time: message.time,
      parentID: message.id,
      modelID: model.id,
      providerID: model.providerID,
      variant: model.variant,
      mode: agent,
      agent,
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: emptyTokens,
    },
  ]
}

function shellPart(sessionID: string, message: SessionMessageShell): ToolPart {
  const input = { command: message.command }
  const start = message.time.created
  const state: ToolPart["state"] =
    message.status === "running"
      ? { status: "running", input, time: { start } }
      : {
          status: "completed",
          input,
          output: message.output?.output ?? "",
          title: "Shell",
          metadata: {
            status: message.status,
            exit: message.exit,
            truncated: message.output?.truncated,
          },
          time: { start, end: message.time.completed ?? start },
        }
  return {
    id: `${message.id}:tool`,
    sessionID,
    messageID: `${message.id}:assistant`,
    type: "tool",
    callID: message.shellID,
    tool: "bash",
    state,
  }
}

export function sessionMessagePartID(messageID: string, type: "text" | "reasoning", ordinal: number) {
  return `${messageID}:${type}:${ordinal}`
}

function userMessage(
  sessionID: string,
  message: SessionMessageUser,
  agent: string,
  model: { id: string; providerID: string; variant?: string },
): UserMessage {
  return {
    id: message.id,
    sessionID,
    role: "user",
    time: message.time,
    agent,
    model: { providerID: model.providerID, modelID: model.id, variant: model.variant },
  }
}

function userParts(
  sessionID: string,
  message: SessionMessageUser & { payload?: Extract<CurrentEncodedMessage, { type: "user" }>["payload"] },
): Part[] {
  if (message.payload) {
    const ordinals = { text: 0, file: 0, agent: 0, subtask: 0 }
    return message.payload.parts.map((part) => ({
      ...part,
      id: `${message.id}:${part.type}:${ordinals[part.type]++}`,
      sessionID,
      messageID: message.id,
    }))
  }
  return [
    textPart(sessionID, message.id, 0, message.text),
    ...(message.files ?? []).map(
      (file, index): FilePart => ({
        id: `${message.id}:file:${index}`,
        sessionID,
        messageID: message.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
        source: file.mention
          ? {
              type: "file",
              text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
              path: file.mention.text.startsWith("@") ? file.mention.text.slice(1) : (file.name ?? file.mention.text),
            }
          : undefined,
      }),
    ),
    ...(message.agents ?? []).map(
      (item, index): Part => ({
        id: `${message.id}:agent:${index}`,
        sessionID,
        messageID: message.id,
        type: "agent",
        name: item.name,
        source: item.mention
          ? { value: item.mention.text, start: item.mention.start, end: item.mention.end }
          : undefined,
      }),
    ),
  ]
}

function assistantMessage(sessionID: string, parentID: string, message: SessionMessageAssistant): AssistantMessage {
  const prepared = message as PreparedAssistant
  const error = message.error
    ? message.error.type.toLowerCase().includes("abort") || message.error.type.toLowerCase().includes("interrupt")
      ? { name: "MessageAbortedError" as const, data: { message: message.error.message } }
      : { name: "UnknownError" as const, data: { message: message.error.message } }
    : undefined
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    time: message.time,
    error,
    parentID,
    modelID: message.model.id,
    providerID: message.model.providerID,
    variant: message.model.variant,
    mode: message.agent,
    agent: message.agent,
    path: { cwd: "", root: "" },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens,
    ...(prepared.system_prompt === undefined && prepared.systemPrompt === undefined
      ? {}
      : { systemPrompt: prepared.system_prompt ?? prepared.systemPrompt }),
    ...(prepared.tool_defs === undefined && prepared.toolDefinitions === undefined
      ? {}
      : { toolDefinitions: prepared.tool_defs ?? prepared.toolDefinitions }),
    finish: message.finish,
  }
}

function assistantParts(sessionID: string, message: SessionMessageAssistant): Part[] {
  const ordinals = { text: 0, reasoning: 0 }
  return message.content.flatMap((content): Part[] => {
    if (content.type === "text") {
      const part = textPart(sessionID, message.id, ordinals.text++, content.text)
      return content.text.trim() ? [part] : []
    }
    if (content.type === "reasoning") {
      const part: Part = {
        id: sessionMessagePartID(message.id, "reasoning", ordinals.reasoning++),
        sessionID,
        messageID: message.id,
        type: "reasoning",
        text: content.text,
        metadata: content.state,
        time: {
          start: content.time?.created ?? message.time.created,
          end: content.time?.completed,
        },
      }
      return content.text.trim() ? [part] : []
    }
    return [toolPart(sessionID, message.id, content)]
  })
}

function textPart(sessionID: string, messageID: string, ordinal: number, text: string, synthetic?: boolean): Part {
  return {
    id: sessionMessagePartID(messageID, "text", ordinal),
    sessionID,
    messageID,
    type: "text",
    text,
    synthetic,
  }
}

function toolPart(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): ToolPart {
  const start = tool.time.ran ?? tool.time.created
  const metadata =
    "structured" in tool.state && record(tool.state.structured)
      ? tool.state.structured
      : "metadata" in tool.state
        ? (tool.state.metadata ?? {})
        : {}
  const state = (() => {
    if (tool.state.status === "streaming") {
      const value = Option.getOrUndefined(decodeToolInput(tool.state.input))
      const input = normalizeToolInput(tool.name, record(value) ? value : {})
      return { status: "pending" as const, input, raw: tool.state.input }
    }
    if (tool.state.status === "running") {
      return {
        status: "running" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        metadata: normalizeToolMetadata(tool.name, metadata),
        time: { start },
      }
    }
    if (tool.state.status === "error") {
      return {
        status: "error" as const,
        input: normalizeToolInput(tool.name, tool.state.input),
        error: tool.state.error.message,
        metadata: normalizeToolMetadata(tool.name, metadata),
        time: { start, end: tool.time.completed ?? start },
      }
    }
    const attachments = tool.state.content.flatMap((item, index): FilePart[] =>
      item.type === "file"
        ? [
            {
              id: `${tool.id}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              mime: item.mime,
              filename: item.name,
              url: item.uri,
            },
          ]
        : [],
    )
    return {
      status: "completed" as const,
      input: normalizeToolInput(tool.name, tool.state.input),
      output: tool.state.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n"),
      title: tool.name,
      metadata: normalizeToolMetadata(tool.name, metadata),
      time: { start, end: tool.time.completed ?? start },
      attachments: attachments.length ? attachments : undefined,
    }
  })()
  return {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool",
    callID: tool.id,
    tool: tool.name,
    state,
    metadata: { providerState: tool.providerState, providerResultState: tool.providerResultState },
  }
}
