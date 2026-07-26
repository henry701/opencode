import type {
  EventsSubscribeOutput,
  OpenCode,
  SessionsContextOutput,
  SessionsEventsOutput,
  SessionsQueueEnqueueInput,
} from "@opencode-ai/client"
import { MessageID } from "@/session/schema"
import { buildQueuePromptPayload, queueEventSessionID, queuedPromptPreviews } from "./runtime.queue-remote"
import type { SessionResizeReplayInput, SessionTransport, SessionTurnInput } from "./stream.transport"
import type { FooterApi, FooterEvent, QueuedPromptPreview, RunProvider, StreamCommit } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type CurrentClient = ReturnType<typeof OpenCode.make>
type FooterViewEvent = Extract<FooterEvent, { type: "stream.view" }>

type StreamInput = {
  client: CurrentClient
  sessionID: string
  thinking: boolean
  replay?: boolean
  replayLimit?: number
  presentHistory?: boolean
  limits: () => Record<string, number>
  providers?: () => RunProvider[]
  footer: FooterApi
  listQueue?: () => Promise<QueuedPromptPreview[]>
  trace?: Trace
  signal?: AbortSignal
}

export function currentFooterEvent(event: EventsSubscribeOutput, sessionID: string): FooterViewEvent | undefined {
  if (event.type === "permission.v2.asked" && event.data.sessionID === sessionID) {
    return { type: "stream.view", view: { type: "permission", request: event.data } }
  }
  if (event.type === "question.v2.asked" && event.data.sessionID === sessionID) {
    return { type: "stream.view", view: { type: "question", request: event.data } }
  }
  if (
    (event.type === "permission.v2.replied" ||
      event.type === "question.v2.replied" ||
      event.type === "question.v2.rejected") &&
    event.data.sessionID === sessionID
  ) {
    return { type: "stream.view", view: { type: "prompt" } }
  }
}

function fragmentCommits(
  kind: "assistant" | "reasoning",
  messageID: string,
  partID: string,
  text: string,
): StreamCommit[] {
  return [
    { kind, source: kind, messageID, partID, text: "", phase: "start" },
    { kind, source: kind, messageID, partID, text, phase: "progress" },
    { kind, source: kind, messageID, partID, text: "", phase: "final" },
  ]
}

function toolText(content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) {
  return content.flatMap((item) => (item.type === "text" && item.text ? [item.text] : [])).join("\n")
}

function currentToolCommits(
  messageID: string,
  item: Extract<Extract<SessionsContextOutput[number], { type: "assistant" }>["content"][number], { type: "tool" }>,
): StreamCommit[] {
  const start = {
    kind: "tool",
    source: "tool",
    messageID,
    partID: item.id,
    tool: item.name,
    text: `running ${item.name}`,
    phase: "start",
    toolState: "running",
  } satisfies StreamCommit
  if (item.state.status === "pending" || item.state.status === "running") return [start]
  if (item.state.status === "error") {
    return [
      start,
      {
        ...start,
        text: item.state.error.message,
        phase: "final",
        toolState: "error",
        toolError: item.state.error.message,
      },
    ]
  }
  return [
    start,
    {
      ...start,
      text: toolText(item.state.content),
      phase: "progress",
      toolState: "completed",
    },
  ]
}

export function currentMessageCommits(message: SessionsContextOutput[number], thinking: boolean): StreamCommit[] {
  if (message.type === "user") {
    return [
      {
        kind: "user",
        source: "system",
        messageID: message.id,
        text: message.text,
        phase: "start",
      },
    ]
  }
  if (message.type === "system" || message.type === "synthetic") {
    return [{ kind: "system", source: "system", messageID: message.id, text: message.text, phase: "final" }]
  }
  if (message.type === "shell") {
    return [
      {
        kind: "tool",
        source: "tool",
        messageID: message.id,
        partID: `shell:${message.callID}`,
        tool: "bash",
        shell: { callID: message.callID, command: message.command },
        text: "running shell",
        phase: "start",
        toolState: "running",
      },
      ...(message.time.completed
        ? [
            {
              kind: "tool",
              source: "tool",
              messageID: message.id,
              partID: `shell:${message.callID}`,
              tool: "bash",
              shell: { callID: message.callID, command: message.command },
              text: message.output,
              phase: "progress",
              toolState: "completed",
            } satisfies StreamCommit,
          ]
        : []),
    ]
  }
  if (message.type === "compaction") {
    return [
      {
        kind: "system",
        source: "system",
        messageID: message.id,
        text: "session compacted",
        phase: "final",
      },
    ]
  }
  if (message.type !== "assistant") return []
  const commits = message.content.flatMap((item): StreamCommit[] => {
    if (item.type === "text") return fragmentCommits("assistant", message.id, item.id, item.text)
    if (item.type === "reasoning") {
      return thinking ? fragmentCommits("reasoning", message.id, item.id, item.text) : []
    }
    return currentToolCommits(message.id, item)
  })
  if (!message.error) return commits
  return [
    ...commits,
    {
      kind: "error",
      source: "system",
      messageID: message.id,
      text: message.error.message,
      phase: "start",
    },
  ]
}

export function currentEventCommits(event: SessionsEventsOutput, thinking: boolean): StreamCommit[] {
  if (event.type === "session.next.prompted") {
    return [
      {
        kind: "user",
        source: "system",
        messageID: event.data.messageID,
        text: event.data.prompt.text,
        phase: "start",
      },
    ]
  }
  if (event.type === "session.next.context.updated" || event.type === "session.next.synthetic") {
    return [
      {
        kind: "system",
        source: "system",
        messageID: event.data.messageID,
        text: event.data.text,
        phase: "final",
      },
    ]
  }
  if (event.type === "session.next.shell.started") {
    return [
      {
        kind: "tool",
        source: "tool",
        messageID: event.data.messageID,
        partID: `shell:${event.data.callID}`,
        tool: "bash",
        shell: { callID: event.data.callID, command: event.data.command },
        text: "running shell",
        phase: "start",
        toolState: "running",
      },
    ]
  }
  if (event.type === "session.next.shell.ended") {
    return [
      {
        kind: "tool",
        source: "tool",
        partID: `shell:${event.data.callID}`,
        tool: "bash",
        text: event.data.output,
        phase: "progress",
        toolState: "completed",
      },
    ]
  }
  if (event.type === "session.next.text.started") {
    return [
      {
        kind: "assistant",
        source: "assistant",
        messageID: event.data.assistantMessageID,
        partID: event.data.textID,
        text: "",
        phase: "start",
      },
    ]
  }
  if (event.type === "session.next.text.ended") {
    return [
      {
        kind: "assistant",
        source: "assistant",
        messageID: event.data.assistantMessageID,
        partID: event.data.textID,
        text: event.data.text,
        phase: "progress",
      },
      {
        kind: "assistant",
        source: "assistant",
        messageID: event.data.assistantMessageID,
        partID: event.data.textID,
        text: "",
        phase: "final",
      },
    ]
  }
  if (event.type === "session.next.reasoning.started") {
    if (!thinking) return []
    return [
      {
        kind: "reasoning",
        source: "reasoning",
        messageID: event.data.assistantMessageID,
        partID: event.data.reasoningID,
        text: "",
        phase: "start",
      },
    ]
  }
  if (event.type === "session.next.reasoning.ended") {
    return thinking
      ? [
          {
            kind: "reasoning",
            source: "reasoning",
            messageID: event.data.assistantMessageID,
            partID: event.data.reasoningID,
            text: event.data.text,
            phase: "progress",
          },
          {
            kind: "reasoning",
            source: "reasoning",
            messageID: event.data.assistantMessageID,
            partID: event.data.reasoningID,
            text: "",
            phase: "final",
          },
        ]
      : []
  }
  if (event.type === "session.next.tool.input.started") {
    return [
      {
        kind: "tool",
        source: "tool",
        messageID: event.data.assistantMessageID,
        partID: event.data.callID,
        tool: event.data.name,
        text: `running ${event.data.name}`,
        phase: "start",
        toolState: "running",
      },
    ]
  }
  if (event.type === "session.next.tool.success") {
    return [
      {
        kind: "tool",
        source: "tool",
        messageID: event.data.assistantMessageID,
        partID: event.data.callID,
        text: toolText(event.data.content),
        phase: "progress",
        toolState: "completed",
      },
    ]
  }
  if (event.type === "session.next.tool.failed") {
    return [
      {
        kind: "tool",
        source: "tool",
        messageID: event.data.assistantMessageID,
        partID: event.data.callID,
        text: event.data.error.message,
        phase: "final",
        toolState: "error",
        toolError: event.data.error.message,
      },
    ]
  }
  if (event.type === "session.next.step.failed") {
    return [
      {
        kind: "error",
        source: "system",
        messageID: event.data.assistantMessageID,
        text: event.data.error.message,
        phase: "start",
      },
    ]
  }
  if (event.type === "session.next.compaction.ended") {
    return [
      {
        kind: "system",
        source: "system",
        messageID: event.data.messageID,
        text: "session compacted",
        phase: "final",
      },
    ]
  }
  return []
}

function currentMessageKeys(messages: SessionsContextOutput) {
  return new Set(
    messages.flatMap((message) => {
      if (message.type === "assistant") {
        return [
          `message:${message.id}`,
          ...message.content.map((item) => `${item.type}:${message.id}:${item.id}`),
        ]
      }
      if (message.type === "shell") return [`message:${message.id}`, `shell:${message.callID}`]
      return [`message:${message.id}`]
    }),
  )
}

function currentEventKey(event: SessionsEventsOutput) {
  if (
    event.type === "session.next.prompted" ||
    event.type === "session.next.context.updated" ||
    event.type === "session.next.synthetic" ||
    event.type === "session.next.compaction.ended"
  ) {
    return `message:${event.data.messageID}`
  }
  if (event.type === "session.next.shell.started" || event.type === "session.next.shell.ended") {
    return `shell:${event.data.callID}`
  }
  if (event.type === "session.next.text.started" || event.type === "session.next.text.ended") {
    return `text:${event.data.assistantMessageID}:${event.data.textID}`
  }
  if (event.type === "session.next.reasoning.started" || event.type === "session.next.reasoning.ended") {
    return `reasoning:${event.data.assistantMessageID}:${event.data.reasoningID}`
  }
  if (
    event.type === "session.next.tool.input.started" ||
    event.type === "session.next.tool.input.ended" ||
    event.type === "session.next.tool.called" ||
    event.type === "session.next.tool.progress" ||
    event.type === "session.next.tool.success" ||
    event.type === "session.next.tool.failed"
  ) {
    return `tool:${event.data.assistantMessageID}:${event.data.callID}`
  }
  if (
    event.type === "session.next.step.started" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.step.failed"
  ) {
    return `message:${event.data.assistantMessageID}`
  }
}

async function latestSequence(client: CurrentClient, sessionID: string) {
  let after: number | undefined
  while (true) {
    const page = await client.sessions.history({ sessionID, after, limit: 1000 })
    const next = page.data.at(-1)?.durable?.seq
    if (!page.hasMore || next === undefined) return next
    after = next
  }
}

function abortableDelay(signal: AbortSignal, milliseconds: number) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, milliseconds)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

export async function createCurrentSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const abort = new AbortController()
  input.signal?.addEventListener("abort", () => abort.abort(), { once: true })
  const after = await latestSequence(input.client, input.sessionID)
  const buffered: SessionsEventsOutput[] = []
  const blockerBuffer: EventsSubscribeOutput[] = []
  let ready = false
  let blockersReady = false
  let fault: unknown

  const publish = async (event: SessionsEventsOutput) => {
    for (const commit of currentEventCommits(event, input.thinking)) input.footer.append(commit)
    if (queueEventSessionID(event) === input.sessionID && input.listQueue) {
      const queued = await input.listQueue().catch(() => undefined)
      if (queued) input.footer.event({ type: "queue", queue: queued.length, queued })
    }
  }

  const watch = (async () => {
    try {
      for await (const event of input.client.sessions.events({ sessionID: input.sessionID, after }, { signal: abort.signal })) {
        if (!ready) {
          buffered.push(event)
          continue
        }
        await publish(event)
      }
    } catch (error) {
      if (!abort.signal.aborted) fault = error
    }
  })()

  const hydrateBlocker = async () => {
    const [permissions, questions] = await Promise.all([
      input.client.permissions.list({ sessionID: input.sessionID }),
      input.client.questions.list({ sessionID: input.sessionID }),
    ])
    const view = permissions[0]
      ? ({ type: "permission", request: permissions[0] } as const)
      : questions[0]
        ? ({ type: "question", request: questions[0] } as const)
        : ({ type: "prompt" } as const)
    input.footer.event({ type: "stream.view", view })
  }

  const publishBlocker = async (event: EventsSubscribeOutput) => {
    const next = currentFooterEvent(event, input.sessionID)
    if (!next) return
    if (next.view.type === "prompt") return hydrateBlocker()
    input.footer.event(next)
  }

  const watchBlockers = (async () => {
    try {
      for await (const event of input.client.events.subscribe({ signal: abort.signal })) {
        if (!blockersReady) {
          blockerBuffer.push(event)
          continue
        }
        await publishBlocker(event)
      }
    } catch (error) {
      if (!abort.signal.aborted) fault = error
    }
  })()

  const replay = async () => {
    const messages = await input.client.sessions.context({ sessionID: input.sessionID })
    if (input.presentHistory !== false) {
      for (const message of messages) {
        for (const commit of currentMessageCommits(message, input.thinking)) input.footer.append(commit)
      }
    }
    return messages
  }

  const messages = await replay()
  await hydrateBlocker()
  blockersReady = true
  for (const event of blockerBuffer.splice(0)) await publishBlocker(event)
  const projected = currentMessageKeys(messages)
  ready = true
  for (const event of buffered.splice(0)) {
    const key = currentEventKey(event)
    if (key && projected.has(key)) continue
    await publish(event)
  }
  const active = await input.client.sessions.active()
  input.footer.event({
    type: "stream.patch",
    patch: {
      phase: active[input.sessionID] ? "running" : "idle",
      first: messages.length === 0,
    },
  })

  const runPromptTurn = async (next: SessionTurnInput) => {
    if (abort.signal.aborted || next.signal?.aborted || input.footer.isClosed) return
    const before = await input.client.sessions.active()
    const payload = buildQueuePromptPayload({
      agent: next.agent,
      model: next.model,
      variant: next.variant,
      prompt: {
        ...next.prompt,
        parts: [...(next.includeFiles ? next.files : []), ...next.prompt.parts],
      },
    })
    const messageID = next.prompt.messageID ?? MessageID.ascending()
    if (next.prompt.mode === "shell") {
      input.trace?.write("send.session.next.shell", { sessionID: input.sessionID })
      await input.client.sessions.shell(
        { sessionID: input.sessionID, command: next.prompt.text },
        { signal: next.signal },
      )
    } else if (next.prompt.command) {
      input.trace?.write("send.session.next.command", {
        sessionID: input.sessionID,
        command: next.prompt.command.name,
      })
      await input.client.sessions.command(
        {
          sessionID: input.sessionID,
          id: messageID,
          name: next.prompt.command.name,
          arguments: next.prompt.command.arguments,
          payload,
          delivery: "steer",
        },
        { signal: next.signal },
      )
    } else {
      input.trace?.write("send.session.next.prompt", { sessionID: input.sessionID, delivery: "steer" })
      await input.client.sessions.prompt(
        {
          sessionID: input.sessionID,
          id: messageID,
          payload,
          delivery: "steer",
        },
        { signal: next.signal },
      )
    }
    if (before[input.sessionID]) return
    input.footer.event({ type: "turn.wait" })
    while (!abort.signal.aborted && !next.signal?.aborted && !input.footer.isClosed) {
      if (fault) throw fault
      const sessions = await input.client.sessions.active()
      if (!sessions[input.sessionID]) break
      await abortableDelay(abort.signal, 50)
    }
    const queued = await input.listQueue?.().catch(() => [])
    input.footer.event({ type: "turn.idle", queue: queued?.length ?? 0 })
  }

  return {
    runPromptTurn,
    selectSubagent() {},
    async replayOnResize(next: SessionResizeReplayInput) {
      if (abort.signal.aborted || input.footer.isClosed) return false
      await next.reset()
      await replay()
      for (const row of next.localRows()) input.footer.append(row.commit)
      return true
    },
    async close() {
      abort.abort()
      await Promise.all([watch, watchBlockers])
    },
  }
}


export function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type CurrentPromptPayload = SessionsQueueEnqueueInput["payload"]
