import type { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { DateTime, Effect } from "effect"

export type CurrentSessionState = {
  readonly messages: ReadonlyArray<SessionMessage.Message>
  readonly pending: ReadonlyArray<SessionMessage.User>
  readonly context: ReadonlyArray<SessionMessage.Message>
  readonly queue: ReadonlyArray<SessionInput.Queued>
  readonly session?: Session.Info
  readonly active: boolean
  readonly readiness: "loading" | "ready" | "error"
  readonly connection: "disconnected" | "connecting" | "open" | "reconnecting"
  readonly loadingOlder: boolean
  readonly cursor?: string
  readonly hasOlder: boolean
  readonly lastEventSequence?: number
  readonly retry?: SessionEvent.Retried
  readonly error?: unknown
}

export type CurrentSessionAction =
  | { readonly type: "loading" }
  | {
      readonly type: "hydrated"
      readonly messages: ReadonlyArray<SessionMessage.Message>
      readonly pending?: ReadonlyArray<SessionMessage.User>
      readonly sequence?: number
      readonly cursor?: string
    }
  | { readonly type: "context-updated"; readonly context: ReadonlyArray<SessionMessage.Message> }
  | {
      readonly type: "older-loaded"
      readonly messages: ReadonlyArray<SessionMessage.Message>
      readonly cursor?: string
    }
  | {
      readonly type: "newest-merged"
      readonly messages: ReadonlyArray<SessionMessage.Message>
      readonly pending?: ReadonlyArray<SessionMessage.User>
      readonly sequence?: number
      readonly hasOlder: boolean
    }
  | { readonly type: "event"; readonly event: SessionEvent.Event }
  | { readonly type: "event-observed"; readonly sequence?: number }
  | { readonly type: "message-replaced"; readonly message: SessionMessage.Message }
  | { readonly type: "session-updated"; readonly session: Session.Info }
  | { readonly type: "queue-updated"; readonly queue: ReadonlyArray<SessionInput.Queued> }
  | { readonly type: "active-updated"; readonly active: boolean }
  | { readonly type: "connection-updated"; readonly connection: CurrentSessionState["connection"] }
  | { readonly type: "older-loading"; readonly loading: boolean }
  | { readonly type: "failed"; readonly error: unknown }

export function currentSessionInitialState(): CurrentSessionState {
  return {
    messages: [],
    pending: [],
    context: [],
    queue: [],
    active: false,
    readiness: "loading",
    connection: "disconnected",
    loadingOlder: false,
    hasOlder: false,
  }
}

export function reduceCurrentSession(state: CurrentSessionState, action: CurrentSessionAction): CurrentSessionState {
  switch (action.type) {
    case "loading":
      return currentSessionInitialState()
    case "hydrated":
      return {
        ...state,
        messages: [...action.messages],
        pending: reconcilePending(action.pending ?? state.pending, action.messages),
        readiness: "ready" as const,
        cursor: action.cursor,
        hasOlder: action.cursor !== undefined,
        lastEventSequence: action.sequence,
      }
    case "context-updated":
      return { ...state, context: [...action.context] }
    case "older-loaded": {
      const loaded = new Set(state.messages.map((message) => message.id))
      return {
        ...state,
        messages: [...action.messages.filter((message) => !loaded.has(message.id)), ...state.messages],
        pending: reconcilePending(state.pending, action.messages),
        cursor: action.cursor,
        hasOlder: action.cursor !== undefined,
      }
    }
    case "newest-merged": {
      const first = action.messages[0]
      const boundary = first && order(first)
      const messages = new Map(
        (action.hasOlder && boundary
          ? state.messages.filter((message) => order(message).localeCompare(boundary) < 0)
          : []
        ).map((message) => [message.id, message]),
      )
      action.messages.forEach((message) => messages.set(message.id, message))
      return {
        ...state,
        messages: Array.from(messages.values()).toSorted((left, right) => order(left).localeCompare(order(right))),
        pending: reconcilePending(
          action.sequence !== undefined && action.sequence >= (state.lastEventSequence ?? -1)
            ? (action.pending ?? state.pending)
            : state.pending,
          action.messages,
        ),
      }
    }
    case "message-replaced": {
      const index = state.messages.findIndex((message) => message.id === action.message.id)
      if (index < 0)
        return {
          ...state,
          messages: [...state.messages, action.message].toSorted(
            (left, right) =>
              DateTime.toEpochMillis(left.time.created) - DateTime.toEpochMillis(right.time.created) ||
              String(left.id).localeCompare(String(right.id)),
          ),
          pending: reconcilePending(state.pending, [action.message]),
        }
      const messages = [...state.messages]
      messages[index] = action.message
      return { ...state, messages, pending: reconcilePending(state.pending, [action.message]) }
    }
    case "event": {
      const sequence = action.event.durable?.seq
      if (sequence !== undefined && sequence <= (state.lastEventSequence ?? -1)) return state
      const messages = [...state.messages]
      Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory({ messages }), action.event))
      const pending = reducePending(state.pending, action.event, messages)
      const retry =
        action.event.type === "session.next.retried"
          ? action.event
          : action.event.type === "session.next.step.started" ||
              action.event.type === "session.next.step.ended" ||
              action.event.type === "session.next.step.failed"
            ? undefined
            : state.retry
      return {
        ...state,
        messages,
        pending,
        active: activeForEvent(state.active, action.event),
        retry,
        lastEventSequence: sequence ?? state.lastEventSequence,
      }
    }
    case "event-observed":
      if (action.sequence === undefined || action.sequence <= (state.lastEventSequence ?? -1)) return state
      return { ...state, lastEventSequence: action.sequence }
    case "session-updated":
      return { ...state, session: action.session }
    case "queue-updated":
      return { ...state, queue: [...action.queue] }
    case "active-updated":
      return { ...state, active: action.active, retry: action.active ? state.retry : undefined }
    case "connection-updated":
      return { ...state, connection: action.connection }
    case "older-loading":
      return { ...state, loadingOlder: action.loading }
    case "failed":
      return { ...state, readiness: "error", error: action.error }
  }
}

function activeForEvent(active: boolean, event: SessionEvent.Event) {
  if (event.type === "session.next.retried") return true
  if (event.type === "session.next.prompt.admitted" && event.data.delivery === "steer") return true
  if (event.type === "session.next.prompt.expedited") return true
  if (event.type === "session.next.step.started") return true
  if (event.type === "session.next.step.ended" || event.type === "session.next.step.failed") return false
  return active
}

export function currentSessionMessages(state: CurrentSessionState) {
  if (state.pending.length === 0) return state.messages
  return [...state.messages, ...state.pending].toSorted((left, right) => order(left).localeCompare(order(right)))
}

function reconcilePending(pending: readonly SessionMessage.User[], messages: readonly SessionMessage.Message[]) {
  if (pending.length === 0) return pending
  const promoted = new Set(messages.map((message) => message.id))
  return pending.filter((message) => !promoted.has(message.id))
}

function reducePending(
  pending: readonly SessionMessage.User[],
  event: SessionEvent.Event,
  messages: readonly SessionMessage.Message[],
) {
  const reconciled = reconcilePending(pending, messages)
  if (event.type === "session.next.prompt.admitted" && event.data.delivery === "steer")
    return upsertPending(reconciled, pendingUser(event.data, event.metadata))
  if (event.type === "session.next.prompt.expedited")
    return upsertPending(reconciled, pendingUser(event.data, event.metadata))
  if (event.type === "session.next.prompt.revised") {
    const current = reconciled.find((message) => message.id === event.data.messageID)
    if (!current) return reconciled
    return upsertPending(
      reconciled,
      pendingUser(
        {
          messageID: event.data.messageID,
          prompt: event.data.prompt,
          payload: event.data.payload,
          timestamp: event.data.timestamp,
        },
        current.metadata,
      ),
    )
  }
  if (event.type === "session.next.prompt.discarded")
    return reconciled.filter((message) => message.id !== event.data.messageID)
  if (event.type === "session.next.prompted") return reconciled.filter((message) => message.id !== event.data.messageID)
  return reconciled
}

function upsertPending(pending: readonly SessionMessage.User[], message: SessionMessage.User) {
  const next = pending.filter((current) => current.id !== message.id)
  return [...next, message].toSorted((left, right) => order(left).localeCompare(order(right)))
}

function pendingUser(
  data: {
    messageID: SessionMessage.ID
    prompt: SessionEvent.PromptAdmitted["data"]["prompt"]
    payload?: SessionEvent.PromptAdmitted["data"]["payload"]
    timestamp: SessionEvent.PromptAdmitted["data"]["timestamp"]
  },
  metadata?: Record<string, unknown>,
) {
  return SessionMessage.User.make({
    id: data.messageID,
    type: "user",
    metadata,
    text: data.prompt.text,
    files: data.prompt.files,
    agents: data.prompt.agents,
    payload: data.payload,
    time: { created: data.timestamp },
  })
}

function order(message: SessionMessage.Message) {
  return `${String(DateTime.toEpochMillis(message.time.created)).padStart(16, "0")}:${message.id}`
}
