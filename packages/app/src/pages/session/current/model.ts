import type { CurrentClient } from "@/utils/current-client"
import { useServerSDK } from "@/context/server-sdk"
import { Session } from "@opencode-ai/schema/session"
import { SessionEvent } from "@opencode-ai/schema/session-event"
import { SessionInput } from "@opencode-ai/schema/session-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import {
  currentSessionInitialState,
  reduceCurrentSession,
  type CurrentSessionAction,
  type CurrentSessionState,
} from "./reducer"

const pageSize = 100
const decodeSession = Schema.decodeUnknownSync(Session.Info)
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))
const decodeQueue = Schema.decodeUnknownSync(Schema.Array(SessionInput.Queued))
const decodeEvent = Schema.decodeUnknownSync(SessionEvent.All)

export type CurrentSessionPort = {
  readonly sessions: Pick<CurrentClient["sessions"], "get" | "active" | "events" | "queueList">
  readonly messages: Pick<CurrentClient["messages"], "list">
}

export type CurrentSessionModel = ReturnType<typeof createCurrentSessionModel>

export function createCurrentSessionModel(input: {
  readonly sessionID: Accessor<string | undefined>
  readonly client: Accessor<CurrentSessionPort>
  readonly autoStart?: boolean
  readonly reconnectDelayMs?: number
}) {
  const [state, setState] = createSignal(currentSessionInitialState(), { equals: false })
  let generation = 0
  let abort: AbortController | undefined
  let sessionRefresh = 0
  let queueRefresh = 0
  let activeRefresh = 0

  const dispatch = (action: CurrentSessionAction) => setState((current) => reduceCurrentSession(current, action))

  const refreshSession = async (client: CurrentSessionPort, sessionID: string, signal?: AbortSignal) => {
    const request = ++sessionRefresh
    const session = decodeSession(await client.sessions.get({ sessionID }, { signal }))
    if (request !== sessionRefresh) return
    dispatch({
      type: "session-updated",
      session,
    })
  }

  const refreshQueue = async (client: CurrentSessionPort, sessionID: string, signal?: AbortSignal) => {
    const request = ++queueRefresh
    const queue = decodeQueue(await client.sessions.queueList({ sessionID }, { signal }))
    if (request !== queueRefresh) return
    dispatch({
      type: "queue-updated",
      queue,
    })
  }

  const refreshActive = async (client: CurrentSessionPort, sessionID: string, signal?: AbortSignal) => {
    const request = ++activeRefresh
    const active = (await client.sessions.active({ signal }))[sessionID] !== undefined
    if (request !== activeRefresh) return
    dispatch({
      type: "active-updated",
      active,
    })
  }

  const newest = async (client: CurrentSessionPort, sessionID: string, signal?: AbortSignal) => {
    const page = await client.messages.list({ sessionID, order: "desc", limit: pageSize }, { signal })
    return {
      messages: decodeMessages(page.data).toReversed(),
      cursor: page.cursor.next ?? undefined,
      throughSeq: page.throughSeq,
    }
  }

  const refreshForEvents = async (
    client: CurrentSessionPort,
    sessionID: string,
    events: SessionEvent.Event[],
    signal?: AbortSignal,
  ) => {
    const queue = events.some(eventRefreshesQueue)
    const session = events.some(eventRefreshesSession)
    const active = events.some(eventRefreshesActive)
    await Promise.all([
      queue ? refreshQueue(client, sessionID, signal) : undefined,
      session ? refreshSession(client, sessionID, signal) : undefined,
      active ? refreshActive(client, sessionID, signal) : undefined,
    ])
  }

  const applyLive = (client: CurrentSessionPort, sessionID: string, event: SessionEvent.Event, signal: AbortSignal) => {
    dispatch({ type: "event", event })
    if (event.type === "session.next.step.started") dispatch({ type: "active-updated", active: true })
    if (event.type === "session.next.step.failed") dispatch({ type: "active-updated", active: false })
    void refreshForEvents(client, sessionID, [event], signal).catch((error) => {
      if (!isAbort(error, signal)) console.error("Failed to refresh current session after event", error)
    })
  }

  const consume = async (
    client: CurrentSessionPort,
    sessionID: string,
    controller: AbortController,
    initialSequence: number | undefined,
    accept: (event: SessionEvent.Event) => void,
    activeGeneration: number,
  ) => {
    let sequence = initialSequence
    let reconnecting = false
    while (!controller.signal.aborted && generation === activeGeneration) {
      dispatch({ type: "connection-updated", connection: reconnecting ? "reconnecting" : "connecting" })
      try {
        const stream = client.sessions.events(
          {
            sessionID,
            ...(sequence === undefined ? {} : { after: sequence }),
          },
          { signal: controller.signal },
        )
        for await (const raw of stream) {
          if (controller.signal.aborted || generation !== activeGeneration) return
          dispatch({ type: "connection-updated", connection: "open" })
          const event = decodeEvent(raw)
          sequence = event.durable?.seq ?? sequence
          accept(event)
        }
      } catch (error) {
        if (isAbort(error, controller.signal)) return
      }
      if (controller.signal.aborted || generation !== activeGeneration) return
      reconnecting = true
      dispatch({ type: "connection-updated", connection: "reconnecting" })
      await wait(input.reconnectDelayMs ?? 250, controller.signal)
    }
  }

  const start = async () => {
    abort?.abort()
    const controller = new AbortController()
    abort = controller
    const activeGeneration = ++generation
    const client = input.client()
    const sessionID = input.sessionID()
    if (!sessionID) {
      dispatch({ type: "hydrated", messages: [] })
      return
    }
    const buffered: SessionEvent.Event[] = []
    let buffering = true
    sessionRefresh++
    queueRefresh++
    activeRefresh++
    dispatch({ type: "loading" })

    return newest(client, sessionID, controller.signal)
      .then(async (page) => {
        void consume(
          client,
          sessionID,
          controller,
          page.throughSeq,
          (event) => {
            if (buffering) {
              buffered.push(event)
              return
            }
            applyLive(client, sessionID, event, controller.signal)
          },
          activeGeneration,
        )
        await Promise.resolve()
        const [session, queue, active] = await Promise.all([
          client.sessions.get({ sessionID }, { signal: controller.signal }).then(decodeSession),
          client.sessions.queueList({ sessionID }, { signal: controller.signal }).then(decodeQueue),
          client.sessions.active({ signal: controller.signal }).then((sessions) => sessions[sessionID] !== undefined),
        ])
        if (controller.signal.aborted || generation !== activeGeneration) return
        dispatch({ type: "session-updated", session })
        dispatch({ type: "queue-updated", queue })
        dispatch({ type: "active-updated", active })
        dispatch({
          type: "hydrated",
          messages: page.messages,
          cursor: page.cursor ?? undefined,
          sequence: page.throughSeq,
        })
        dispatch({ type: "connection-updated", connection: "open" })

        while (buffered.length > 0) {
          const events = buffered.splice(0)
          events.forEach((event) => dispatch({ type: "event-observed", sequence: event.durable?.seq }))
          const page = await newest(client, sessionID, controller.signal)
          if (controller.signal.aborted || generation !== activeGeneration) return
          dispatch({ type: "newest-merged", messages: page.messages, hasOlder: page.cursor !== undefined })
          await refreshForEvents(client, sessionID, events, controller.signal)
        }
        buffering = false
      })
      .catch((error) => {
        if (isAbort(error, controller.signal)) return
        dispatch({ type: "failed", error })
        controller.abort()
        throw error
      })
  }

  const loadOlder = async () => {
    const cursor = state().cursor
    const sessionID = input.sessionID()
    if (!sessionID || !cursor || state().loadingOlder) return
    dispatch({ type: "older-loading", loading: true })
    const controller = abort
    if (!controller) {
      dispatch({ type: "older-loading", loading: false })
      return
    }
    return input
      .client()
      .messages.list({ sessionID, cursor, limit: pageSize }, { signal: controller.signal })
      .then((page) => {
        dispatch({
          type: "older-loaded",
          messages: decodeMessages(page.data).toReversed(),
          cursor: page.cursor.next ?? undefined,
        })
      })
      .finally(() => dispatch({ type: "older-loading", loading: false }))
  }

  const refresh = async () => {
    const controller = abort
    if (!controller) return start()
    const client = input.client()
    const sessionID = input.sessionID()
    if (!sessionID) return
    const [, page] = await Promise.all([
      refreshSession(client, sessionID, controller.signal),
      newest(client, sessionID, controller.signal),
      refreshQueue(client, sessionID, controller.signal),
      refreshActive(client, sessionID, controller.signal),
    ])
    dispatch({ type: "newest-merged", messages: page.messages, hasOlder: page.cursor !== undefined })
  }

  const dispose = () => {
    generation++
    abort?.abort()
    abort = undefined
    dispatch({ type: "connection-updated", connection: "disconnected" })
  }

  if (input.autoStart !== false)
    createEffect(
      on(
        () => [input.sessionID(), input.client()] as const,
        () => {
          void start().catch(() => {})
        },
      ),
    )
  onCleanup(dispose)

  return {
    state,
    messages: () => state().messages,
    queue: () => state().queue,
    session: () => state().session,
    active: () => state().active,
    busy: () =>
      state().active ||
      state().messages.some((message) => message.type === "assistant" && message.time.completed === undefined),
    readiness: () => state().readiness,
    connection: () => state().connection,
    error: () => state().error,
    hasOlder: () => state().hasOlder,
    loadingOlder: () => state().loadingOlder,
    lastEventSequence: () => state().lastEventSequence,
    retry: () => state().retry,
    start,
    refresh,
    refreshQueue: () => {
      const sessionID = input.sessionID()
      if (!sessionID) return Promise.resolve()
      return refreshQueue(input.client(), sessionID, abort?.signal)
    },
    setRevert: (sessionID: string, revert: Session.Info["revert"]) => {
      const session = state().session
      if (!session || session.id !== sessionID) return
      dispatch({ type: "session-updated", session: { ...session, revert } })
    },
    loadOlder,
    dispose,
  }
}

export function useCurrentSession(sessionID: Accessor<string | undefined>) {
  const serverSDK = useServerSDK()
  return createCurrentSessionModel({
    sessionID,
    client: () => serverSDK().currentClient,
  })
}

function eventRefreshesQueue(event: SessionEvent.Event) {
  return (
    event.type === "session.next.prompt.admitted" ||
    event.type === "session.next.prompt.revised" ||
    event.type === "session.next.prompt.discarded" ||
    event.type === "session.next.prompt.expedited" ||
    event.type === "session.next.prompted"
  )
}

function eventRefreshesSession(event: SessionEvent.Event) {
  return (
    event.type === "session.next.agent.switched" ||
    event.type === "session.next.model.switched" ||
    event.type === "session.next.moved" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.step.failed" ||
    event.type.startsWith("session.next.revert.")
  )
}

function eventRefreshesActive(event: SessionEvent.Event) {
  return (
    event.type === "session.next.prompted" ||
    event.type === "session.next.step.started" ||
    event.type === "session.next.step.ended" ||
    event.type === "session.next.step.failed"
  )
}

function isAbort(error: unknown, signal: AbortSignal) {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError")
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

export type { CurrentSessionState }
