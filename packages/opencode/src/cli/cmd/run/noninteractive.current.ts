import type { OpenCode, SessionsQueueEnqueueInput } from "@opencode-ai/client"
import { EOL } from "os"
import { UI } from "../../ui"
import { FormatError, FormatUnknownError } from "../../error"
import type { FooterApi, RunFilePart, StreamCommit } from "./types"
import { createCurrentSessionTransport } from "./stream.current"

type CurrentClient = ReturnType<typeof OpenCode.make>

export async function resolveCurrentCommandSession(input: {
  client: CurrentClient
  directory: string
  sessionID?: string
  continue?: boolean
  fork?: boolean
  title?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}) {
  const base =
    input.continue && !input.sessionID
      ? await input.client.sessions
          .list({
            directory: input.directory,
            order: "desc",
          })
          .then((result) => result.data.find((item) => !item.parentID))
      : undefined
  const session = input.sessionID
    ? input.fork
      ? await input.client.sessions.fork({ sessionID: input.sessionID })
      : await input.client.sessions.get({ sessionID: input.sessionID })
    : input.fork && base
      ? await input.client.sessions.fork({ sessionID: base.id })
      : (base ??
        (await input.client.sessions.create({
          agent: input.agent,
          model: input.model,
          location: { directory: input.directory },
        })))
  if (input.title === undefined) return session
  return input.client.sessions.update({ sessionID: session.id, title: input.title })
}

export function createCurrentCommandFooter(input: {
  client: CurrentClient
  sessionID: string
  auto: boolean
  json: boolean
}) {
  let failed = false
  const tools = new Map<string, string>()
  const emit = (type: string, data: Record<string, unknown>) => {
    if (!input.json) return false
    process.stdout.write(
      JSON.stringify({
        type,
        timestamp: Date.now(),
        sessionID: input.sessionID,
        ...data,
      }) + EOL,
    )
    return true
  }
  const fail = (error: unknown) => {
    failed = true
    UI.error(FormatError(error) ?? FormatUnknownError(error))
  }
  const footer: FooterApi = {
    isClosed: false,
    onPrompt: () => () => {},
    onClose: () => () => {},
    event(event) {
      if (event.type !== "stream.view") return
      if (event.view.type === "permission") {
        const permission = event.view.request
        if (!input.auto) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL +
              `permission requested: ${permission.action} (${permission.resources.join(", ")}); auto-rejecting`,
          )
        }
        void input.client.permissions
          .reply({
            sessionID: input.sessionID,
            requestID: permission.id,
            reply: input.auto ? "once" : "reject",
          })
          .catch(fail)
        return
      }
      if (event.view.type !== "question") return
      UI.println(UI.Style.TEXT_WARNING_BOLD + "!", UI.Style.TEXT_NORMAL + "question requested; auto-rejecting")
      void input.client.questions
        .reject({ sessionID: input.sessionID, requestID: event.view.request.id })
        .catch(fail)
    },
    append(commit: StreamCommit) {
      if (commit.kind === "assistant" && commit.phase === "progress" && commit.text.trim()) {
        const part = {
          id: commit.partID,
          messageID: commit.messageID,
          sessionID: input.sessionID,
          type: "text",
          text: commit.text,
        }
        if (emit("text", { part })) return
        if (!process.stdout.isTTY) {
          process.stdout.write(commit.text.trim() + EOL)
          return
        }
        UI.empty()
        UI.println(commit.text.trim())
        UI.empty()
        return
      }
      if (commit.kind === "reasoning" && commit.phase === "progress" && commit.text.trim()) {
        const part = {
          id: commit.partID,
          messageID: commit.messageID,
          sessionID: input.sessionID,
          type: "reasoning",
          text: commit.text,
        }
        if (emit("reasoning", { part })) return
        const line = `Thinking: ${commit.text.trim()}`
        if (!process.stdout.isTTY) {
          process.stdout.write(line + EOL)
          return
        }
        UI.empty()
        UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
        UI.empty()
        return
      }
      if (commit.kind === "tool") {
        if (commit.phase === "start" && commit.partID && commit.tool) tools.set(commit.partID, commit.tool)
        if (commit.phase !== "progress" && commit.toolState !== "error") return
        const part = {
          id: commit.partID,
          messageID: commit.messageID,
          sessionID: input.sessionID,
          type: "tool",
          tool: commit.tool ?? (commit.partID ? tools.get(commit.partID) : undefined) ?? "tool",
          state:
            commit.toolState === "error"
              ? { status: "error", error: commit.toolError ?? commit.text }
              : { status: "completed", output: commit.text },
        }
        if (emit("tool_use", { part })) return
        if (commit.toolState === "error") {
          fail(commit.toolError ?? commit.text)
          return
        }
        UI.println(UI.Style.TEXT_NORMAL + "⚙", UI.Style.TEXT_NORMAL + part.tool)
        return
      }
      if (commit.kind !== "error") return
      failed = true
      const error = { name: "UnknownError", data: { message: commit.text } }
      if (!emit("error", { error })) UI.error(commit.text)
    },
    idle: () => Promise.resolve(),
    close() {},
    destroy() {},
  }
  return {
    footer,
    failed: () => failed,
  }
}

export async function runCurrentCommandTurn(input: {
  client: CurrentClient
  footer: FooterApi
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  command: string
  arguments: string
  parts: RunFilePart[]
  permissions: SessionsQueueEnqueueInput["payload"]["permissions"]
  thinking: boolean
}) {
  const transport = await createCurrentSessionTransport({
    client: input.client,
    sessionID: input.sessionID,
    thinking: input.thinking,
    limits: () => ({}),
    footer: input.footer,
    presentHistory: false,
  })
  try {
    await transport.runPromptTurn({
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      prompt: {
        text: input.arguments,
        parts: [],
        command: { name: input.command, arguments: input.arguments },
        queuePayload: {
          version: 1,
          agent: input.agent,
          model: {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
            ...(input.variant === undefined ? {} : { variant: input.variant }),
          },
          permissions: input.permissions,
          parts: [{ type: "text", text: input.arguments }, ...input.parts],
        },
      },
      files: [],
      includeFiles: false,
    })
  } finally {
    await transport.close()
  }
}
