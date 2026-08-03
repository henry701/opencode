import type { SessionEvent } from "@opencode-ai/schema/session-event"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { DateTime, Effect } from "effect"

export type CurrentSessionState = {
  readonly messages: ReadonlyArray<SessionMessage.Message>
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
        }
      const messages = [...state.messages]
      messages[index] = action.message
      return { ...state, messages }
    }
    case "event": {
      const sequence = action.event.durable?.seq
      if (sequence !== undefined && sequence <= (state.lastEventSequence ?? -1)) return state
      const messages = [...state.messages]
      Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory({ messages }), action.event))
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
        active: action.event.type === "session.next.retried" ? true : state.active,
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

function order(message: SessionMessage.Message) {
  return `${String(DateTime.toEpochMillis(message.time.created)).padStart(16, "0")}:${message.id}`
}
