import { base64Encode } from "@opencode-ai/core/util/encode"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { expect, type Page } from "@playwright/test"
import { Schema } from "effect"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { installSseTransport } from "../../utils/sse-transport"
import { expectSessionTitle } from "../../utils/waits"

export const directory = "C:/OpenCode/TimelineStability"
export const projectID = "proj_timeline_stability"
export const sessionID = "ses_timeline_stability"
export const userID = "msg_1000_timeline_user"
export const assistantID = "msg_1001_timeline_assistant"
export const title = "Timeline visual stability"
export const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }

type DeepReadonly<Value> = Value extends readonly unknown[]
  ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
  : Value extends object
    ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
    : Value

export type TimelineEvent = DeepReadonly<typeof SessionEvent.All.Encoded>
export type TimelineMutation = TimelineEvent | readonly TimelineEvent[]
export type EventPayload = TimelineEvent
export type ToolStatus = SessionMessage.ToolState["status"]
export type TimelineMessage = typeof SessionMessage.Message.Encoded
export type PartSeed<Owner extends "user" | "assistant"> = Owner extends "user"
  ? typeof SessionInputPayload.Part.Encoded
  : typeof SessionMessage.AssistantContent.Encoded

type ToolOptions<State extends ToolStatus> = State extends "pending"
  ? { output?: never; title?: never; metadata?: never; error?: never }
  : State extends "running"
    ? { title?: string; metadata?: Record<string, unknown>; output?: never; error?: never }
    : State extends "error"
      ? { error?: string; metadata?: Record<string, unknown>; output?: never; title?: never }
      : { output?: string; title?: string; metadata?: Record<string, unknown>; error?: never }

const decodeOptions = { errors: "all", onExcessProperty: "error" } as const
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const decodePart = Schema.decodeUnknownSync(SessionMessage.AssistantContent)
const decodeEvent = Schema.decodeUnknownSync(SessionEvent.All)
let eventSequence = 0
let durableSequence = 0
const toolStates = new Map<string, ToolStatus>()
const contentIDs = new Set<string>()

export async function setupTimeline(
  page: Page,
  input: {
    messages?: TimelineMessage[]
    settings?: Record<string, boolean>
    sessions?: Session[]
    cpuRate?: number
    viewport?: { width: number; height: number }
    eventRetry?: number
    reducedMotion?: boolean
    locale?: string
    deviceScaleFactor?: number
    seedHistory?: boolean
    protocol?: "v1" | "v2"
  } = {},
) {
  const sessions = input.sessions ?? [session()]
  const messages = validateTimelineMessages([
    ...(input.seedHistory ? historyMessages(18) : []),
    ...(input.messages ?? [userMessage(), assistantMessage()]),
  ])
  toolStates.clear()
  contentIDs.clear()
  messages.forEach((message) => {
    if (message.type !== "assistant") return
    message.content.forEach((content) => {
      contentIDs.add(content.id)
      if (content.type === "tool") toolStates.set(content.id, content.state.status)
    })
  })
  const active = messages.findLast((message) => message.type === "assistant")
  const initialStatus =
    active?.type === "assistant" && active.time.completed === undefined ? { type: "busy" } : { type: "idle" }
  const sessionStatus = { [sessionID]: initialStatus }
  const transport = await installSseTransport<EventPayload>(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    path: `/api/session/${sessionID}/event`,
    retry: input.eventRetry ?? 20,
  })
  await mockOpenCodeServer(page, {
    protocol: input.protocol,
    directory,
    project: project(),
    provider: provider(),
    sessions,
    status: sessionStatus,
    sessionStatus,
    currentPageMessages: () => ({
      items: messages.toReversed(),
      throughSeq: durableSequence,
    }),
  })
  await page.addInitScript((settings) => {
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        general: {
          editToolPartsExpanded: false,
          shellToolPartsExpanded: false,
          showReasoningSummaries: false,
          showSessionProgressBar: true,
          ...settings,
        },
      }),
    )
    if (settings.newLayoutDesigns === false) {
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
    }
  }, input.settings ?? {})
  if (input.locale) {
    await page.addInitScript((locale) => {
      localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale }))
    }, input.locale)
  }
  if (input.reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize(input.viewport ?? { width: 1400, height: 900 })
  if (input.deviceScaleFactor) {
    const devtools = await page.context().newCDPSession(page)
    const viewport = input.viewport ?? { width: 1400, height: 900 }
    await devtools.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: input.deviceScaleFactor,
      mobile: false,
    })
  }
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await transport.waitForConnection()
  await expectSessionTitle(page, title)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  if (input.cpuRate && input.cpuRate > 1) {
    const devtools = await page.context().newCDPSession(page)
    await devtools.send("Emulation.setCPUThrottlingRate", { rate: input.cpuRate })
  }

  const send = async (mutation: TimelineMutation, delay = 0) => {
    const events = (Array.isArray(mutation) ? mutation : [mutation]).map(validateTimelineEvent)
    if (events.length === 1) await transport.send(events[0]!, { marker: describeEvent(events[0]!) })
    else
      await transport.burst(
        events,
        events.map((event) => ({ marker: describeEvent(event) })),
      )
    if (delay) await page.waitForTimeout(delay)
  }

  const setActive = (active: boolean) => {
    sessionStatus[sessionID] = { type: active ? "busy" : "idle" }
  }

  return {
    transport,
    send,
    setActive,
    async sendStatus(type: "busy" | "idle" | "retry", delay = 0, attempt = 1) {
      setActive(type !== "idle")
      await send(status(type, { attempt }), delay)
    },
    async sendAll(sequence: { event: TimelineMutation; delay: number }[]) {
      for (const item of sequence) {
        const events = (Array.isArray(item.event) ? item.event : [item.event]).map(validateTimelineEvent)
        if (events.length === 1) await transport.send(events[0]!, { marker: describeEvent(events[0]!) })
        else
          await transport.burst(
            events,
            events.map((event) => ({ marker: describeEvent(event) })),
          )
        await page.waitForTimeout(item.delay)
      }
    },
    async settle(frames = 3) {
      await page.evaluate(
        (frames) =>
          new Promise<void>((resolve) => {
            let remaining = frames
            const tick = () => {
              remaining--
              if (remaining <= 0) return resolve()
              requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          }),
        frames,
      )
    },
    async waitForPart(partID: string) {
      await expect(page.locator(`[data-timeline-part-id="${partID}"]`).first()).toBeVisible()
    },
  }
}

function describeEvent(event: EventPayload) {
  return [event.type, "callID" in event.data ? event.data.callID : undefined].filter(Boolean).join(":")
}

type EventType = TimelineEvent["type"]
type EventByType<Type extends EventType> = Extract<TimelineEvent, { type: Type }>

export function event<const Type extends EventType>(type: Type, data: EventByType<Type>["data"]): TimelineEvent
export function event(type: EventType, data: TimelineEvent["data"]): TimelineEvent {
  const durable = !type.endsWith(".delta")
  return validateTimelineEvent({
    id: `evt_timeline_${String(++eventSequence).padStart(4, "0")}`,
    type,
    data,
    ...(durable
      ? {
          durable: {
            aggregateID: sessionID,
            seq: ++durableSequence,
            version: type === "session.next.step.ended" || type === "session.next.step.failed" ? 2 : 1,
          },
        }
      : {}),
  })
}

export function validateTimelineEvent(input: unknown): TimelineEvent {
  decodeEvent(input, decodeOptions)
  return input as TimelineEvent
}

export function timelineEvents(mutation: TimelineMutation): TimelineEvent[] {
  return (Array.isArray(mutation) ? mutation : [mutation]) as TimelineEvent[]
}

export function validateTimelineMessages(input: readonly TimelineMessage[]): TimelineMessage[] {
  input.forEach((message) => decodeMessage(message, decodeOptions))
  const messages = [...input]
  const messageIDs = new Set<string>()
  const partIDs = new Set<string>()

  messages.forEach((message) => {
    if (messageIDs.has(message.id)) throw new Error(`Timeline fixture has duplicate message ID: ${message.id}`)
    messageIDs.add(message.id)
    if (message.type !== "assistant") return
    message.content.forEach((part) => {
      if (partIDs.has(part.id)) throw new Error(`Timeline fixture has duplicate content ID: ${part.id}`)
      partIDs.add(part.id)
    })
  })
  return messages
}

export async function waitForVisualSettle(page: Page, selectors: string[], stableFrames = 3) {
  await page.waitForFunction(
    ({ selectors, stableFrames }) => {
      const elements = selectors.map((selector) => document.querySelector<HTMLElement>(selector))
      if (elements.some((element) => !element)) return false
      return new Promise<boolean>((resolve) => {
        let stable = 0
        let previous = ""
        const sample = () => {
          const signature = JSON.stringify(
            elements.map((element) => {
              const rect = element!.getBoundingClientRect()
              return [Math.round(rect.top * 10), Math.round(rect.bottom * 10), Math.round(rect.height * 10)]
            }),
          )
          stable = signature === previous ? stable + 1 : 0
          previous = signature
          const ordered = elements
            .slice(1)
            .every(
              (element, index) =>
                elements[index]!.getBoundingClientRect().bottom <= element!.getBoundingClientRect().top + 0.5,
            )
          if (stable >= stableFrames && ordered) return resolve(true)
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
    },
    { selectors, stableFrames },
  )
}

export function historyMessages(count: number): TimelineMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const value = String(index).padStart(4, "0")
    const historyUserID = `msg_0${value}_history_a_user`
    return [
      userMessage(undefined, { id: historyUserID, created: 1690000000000 + index * 10_000 }),
      assistantMessage(
        [
          {
            id: `prt_0${value}_history_text`,
            type: "text",
            text: `Historical response ${index}. ${"Existing session content keeps the virtual timeline realistic. ".repeat(5)}`,
          },
        ],
        {
          id: `msg_0${value}_history_b_assistant`,
          created: 1690000001000 + index * 10_000,
        },
      ),
    ]
  }).flat()
}

export function partUpdated(part: PartSeed<"assistant">, messageID = assistantID): TimelineMutation {
  decodePart(part, decodeOptions)
  if (part.type === "text") {
    const first = !contentIDs.has(part.id)
    contentIDs.add(part.id)
    return [
      ...(first
        ? [
            event("session.next.text.started", {
              timestamp: 1700000002000,
              sessionID,
              assistantMessageID: messageID,
              textID: part.id,
            }),
          ]
        : []),
      event("session.next.text.ended", {
        timestamp: 1700000002001,
        sessionID,
        assistantMessageID: messageID,
        textID: part.id,
        text: part.text,
      }),
    ]
  }
  if (part.type === "reasoning") {
    const first = !contentIDs.has(part.id)
    contentIDs.add(part.id)
    return [
      ...(first
        ? [
            event("session.next.reasoning.started", {
              timestamp: 1700000002000,
              sessionID,
              assistantMessageID: messageID,
              reasoningID: part.id,
              ...(part.providerMetadata === undefined ? {} : { providerMetadata: part.providerMetadata }),
            }),
          ]
        : []),
      event("session.next.reasoning.ended", {
        timestamp: 1700000002001,
        sessionID,
        assistantMessageID: messageID,
        reasoningID: part.id,
        text: part.text,
        ...(part.providerMetadata === undefined ? {} : { providerMetadata: part.providerMetadata }),
      }),
    ]
  }
  return toolEvents(part, messageID)
}

export function partDelta(partID: string, delta: string, messageID = assistantID) {
  return event("session.next.text.delta", {
    timestamp: 1700000002000,
    sessionID,
    assistantMessageID: messageID,
    textID: partID,
    delta,
  })
}

export function messageUpdated(message: Extract<TimelineMessage, { type: "assistant" }>) {
  if (message.error)
    return event("session.next.step.failed", {
      timestamp: message.time.completed ?? 1700000003000,
      sessionID,
      assistantMessageID: message.id,
      error: message.error,
    })
  return event("session.next.step.ended", {
    timestamp: message.time.completed ?? 1700000003000,
    sessionID,
    assistantMessageID: message.id,
    finish: message.finish ?? "stop",
    cost: message.cost ?? 0.01,
    tokens: message.tokens ?? { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(message.snapshot?.end === undefined ? {} : { snapshot: message.snapshot.end }),
    ...(message.snapshot?.files === undefined ? {} : { files: message.snapshot.files }),
    ...(message.snapshot?.diffs === undefined ? {} : { diffs: message.snapshot.diffs }),
  })
}

export function status(
  type: "busy" | "idle" | "retry",
  options: { attempt?: number; assistantMessageID?: string } = {},
): TimelineEvent {
  const attempt = options.attempt ?? 1
  const assistantMessageID = options.assistantMessageID ?? (type === "idle" ? "msg_status_idle_sentinel" : assistantID)
  if (type === "retry")
    return event("session.next.retried", {
      timestamp: 1700000002000,
      sessionID,
      attempt,
      error: { message: "Rate limited", isRetryable: true },
    })
  if (type === "busy")
    return event("session.next.step.started", {
      timestamp: 1700000002000,
      sessionID,
      assistantMessageID,
      agent: "build",
      model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
    })
  return event("session.next.step.ended", {
    timestamp: 1700000003000,
    sessionID,
    assistantMessageID,
    finish: "stop",
    cost: 0.01,
    tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
  })
}

export function userMessage(
  parts?: PartSeed<"user">[],
  input: { id?: string; created?: number } = {},
): Extract<TimelineMessage, { type: "user" }> {
  const id = input.id ?? userID
  const seeds = parts ?? [userText("Build the timeline stability matrix.", { id: `prt_${id}_text` })]
  const message = {
    id,
    type: "user" as const,
    text: seeds
      .flatMap((part) => (part.type === "text" ? [part.text] : part.type === "subtask" ? [part.prompt] : []))
      .join("\n"),
    files: seeds.flatMap((part) =>
      part.type === "file" ? [{ uri: part.url, mime: part.mime, name: part.filename }] : [],
    ),
    agents: seeds.flatMap((part) => (part.type === "agent" ? [{ name: part.name }] : [])),
    payload: {
      version: 1 as const,
      agent: "build",
      model,
      parts: seeds,
    },
    time: { created: input.created ?? 1700000000000 },
  } satisfies Extract<TimelineMessage, { type: "user" }>
  decodeMessage(message, decodeOptions)
  return message
}

export function assistantMessage(
  parts: PartSeed<"assistant">[] = [],
  input: {
    id?: string
    completed?: boolean
    error?: Extract<TimelineMessage, { type: "assistant" }>["error"]
    created?: number
    snapshot?: Extract<TimelineMessage, { type: "assistant" }>["snapshot"]
  } = {},
): Extract<TimelineMessage, { type: "assistant" }> {
  const id = input.id ?? assistantID
  const message = {
    id,
    type: "assistant" as const,
    time: {
      created: input.created ?? 1700000001000,
      ...(input.completed === false ? {} : { completed: (input.created ?? 1700000001000) + 1_000 }),
    },
    agent: "build",
    model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
    cost: 0.01,
    tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(input.error ? { error: input.error } : {}),
    ...(input.snapshot ? { snapshot: input.snapshot } : {}),
    content: parts,
  } satisfies Extract<TimelineMessage, { type: "assistant" }>
  decodeMessage(message, decodeOptions)
  return message
}

export function compactionMessage(
  input: { id?: string; created?: number } = {},
): Extract<TimelineMessage, { type: "compaction" }> {
  const message = {
    id: input.id ?? "msg_timeline_compaction",
    type: "compaction" as const,
    reason: "auto" as const,
    summary: "Earlier session context",
    recent: "Recent session context",
    time: { created: input.created ?? 1700000002500 },
  } satisfies Extract<TimelineMessage, { type: "compaction" }>
  decodeMessage(message, decodeOptions)
  return message
}

export function userText(
  text: string,
  input: Partial<Omit<Extract<PartSeed<"user">, { type: "text" }>, "type" | "text">> = {},
): Extract<PartSeed<"user">, { type: "text" }> {
  return { id: "prt_user_text", type: "text", text, ...input }
}

export function textPart(id: string, text: string): Extract<PartSeed<"assistant">, { type: "text" }> {
  return { id, type: "text", text }
}

export function reasoningPart(id: string, text: string): Extract<PartSeed<"assistant">, { type: "reasoning" }> {
  return { id, type: "reasoning", text, time: { created: 1700000001000 } }
}

export function toolPart(
  id: string,
  tool: string,
  state: "pending",
  input: Record<string, unknown>,
  options?: ToolOptions<"pending">,
): Extract<PartSeed<"assistant">, { type: "tool" }>
export function toolPart(
  id: string,
  tool: string,
  state: "running",
  input: Record<string, unknown>,
  options?: ToolOptions<"running">,
): Extract<PartSeed<"assistant">, { type: "tool" }>
export function toolPart(
  id: string,
  tool: string,
  state: "completed",
  input: Record<string, unknown>,
  options?: ToolOptions<"completed">,
): Extract<PartSeed<"assistant">, { type: "tool" }>
export function toolPart(
  id: string,
  tool: string,
  state: "error",
  input: Record<string, unknown>,
  options?: ToolOptions<"error">,
): Extract<PartSeed<"assistant">, { type: "tool" }>
export function toolPart(
  id: string,
  tool: string,
  state: ToolStatus,
  input: Record<string, unknown>,
  options: ToolOptions<ToolStatus> = {},
): Extract<PartSeed<"assistant">, { type: "tool" }> {
  const base = { id, type: "tool" as const, name: tool, time: { created: 1700000001000 } }
  if (state === "pending") return { ...base, state: { status: state, input: JSON.stringify(input) } }
  const structured = {
    ...(options.metadata ?? {}),
    ...(options.title === undefined ? {} : { title: options.title }),
  }
  const content = options.output === undefined ? [] : [{ type: "text" as const, text: options.output }]
  if (state === "running")
    return {
      ...base,
      state: {
        status: state,
        input,
        structured,
        content,
      },
    }
  if (state === "error")
    return {
      ...base,
      time: { ...base.time, completed: 1700000002000 },
      state: {
        status: state,
        input,
        error: { type: "unknown", message: options.error ?? "Tool failed" },
        structured,
        content,
      },
    }
  return {
    ...base,
    time: { ...base.time, completed: 1700000002000 },
    state: {
      status: state,
      input,
      content: options.output === undefined ? [{ type: "text", text: "Completed" }] : content,
      structured: { ...structured, title: options.title ?? tool },
      result: options.output ?? "Completed",
    },
  }
}

export function shell(
  id: string,
  state: ToolStatus,
  output = "",
  command = `echo ${id}`,
): Extract<PartSeed<"assistant">, { type: "tool" }> {
  if (state === "pending") return toolPart(id, "bash", state, { command })
  if (state === "running")
    return toolPart(id, "bash", state, { command }, { title: command, metadata: { command, output } })
  if (state === "error")
    return toolPart(id, "bash", state, { command }, { error: output || undefined, metadata: { command, output } })
  return toolPart(id, "bash", state, { command }, { title: command, output, metadata: { command, output } })
}

export function completedAssistantInfo(message: Extract<TimelineMessage, { type: "assistant" }>) {
  return { ...message, time: { ...message.time, completed: 1700000003000 } }
}

function toolEvents(part: Extract<PartSeed<"assistant">, { type: "tool" }>, messageID: string): TimelineEvent[] {
  const previous = toolStates.get(part.id)
  const input = typeof part.state.input === "string" ? parseInput(part.state.input) : part.state.input
  const started = previous
    ? []
    : [
        event("session.next.tool.input.started", {
          timestamp: 1700000002000,
          sessionID,
          assistantMessageID: messageID,
          callID: part.id,
          name: part.name,
        }),
        event("session.next.tool.input.ended", {
          timestamp: 1700000002001,
          sessionID,
          assistantMessageID: messageID,
          callID: part.id,
          text: JSON.stringify(input),
        }),
      ]
  if (part.state.status === "pending") {
    toolStates.set(part.id, "pending")
    return started
  }
  const called =
    previous === "running" || previous === "completed" || previous === "error"
      ? []
      : [
          event("session.next.tool.called", {
            timestamp: 1700000002002,
            sessionID,
            assistantMessageID: messageID,
            callID: part.id,
            tool: part.name,
            input,
            provider: { executed: true },
          }),
        ]
  toolStates.set(part.id, part.state.status)
  if (part.state.status === "running")
    return [
      ...started,
      ...called,
      event("session.next.tool.progress", {
        timestamp: 1700000002003,
        sessionID,
        assistantMessageID: messageID,
        callID: part.id,
        structured: part.state.structured,
        content: part.state.content,
      }),
    ]
  if (part.state.status === "error")
    return [
      ...started,
      ...called,
      event("session.next.tool.failed", {
        timestamp: 1700000002004,
        sessionID,
        assistantMessageID: messageID,
        callID: part.id,
        error: part.state.error,
        ...(part.state.result === undefined ? {} : { result: part.state.result }),
        provider: { executed: true },
      }),
    ]
  return [
    ...started,
    ...called,
    event("session.next.tool.success", {
      timestamp: 1700000002004,
      sessionID,
      assistantMessageID: messageID,
      callID: part.id,
      structured: part.state.structured,
      content: part.state.content,
      ...(part.state.outputPaths === undefined ? {} : { outputPaths: part.state.outputPaths }),
      ...(part.state.result === undefined ? {} : { result: part.state.result }),
      provider: { executed: true },
    }),
  ]
}

function parseInput(value: string) {
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "timeline-stability",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

export function session(input: Partial<Session> = {}): Session {
  return {
    id: sessionID,
    slug: "timeline-stability",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
    ...input,
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}
