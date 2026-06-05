// Serial prompt queue for direct interactive mode.
//
// Prompts arrive from the footer (user types and hits enter) and queue up
// here. The queue drains one turn at a time: it appends the user row to
// scrollback, calls input.run() to execute the turn through the stream
// transport, and waits for completion before starting the next prompt.
//
// The queue also handles /exit, /quit, and /new commands, empty-prompt rejection,
// and tracks per-turn wall-clock duration for the footer status line.
//
// Resolves when the footer closes and all in-flight work finishes.
import * as Locale from "@/util/locale"
import { MemoryPromptQueue, PromptQueue, type PromptQueueData } from "@/queue/prompt-queue"
import { runPromptPreview } from "@/queue/preview"
import { ModelID, ProviderID } from "@/provider/schema"
import type { SessionID } from "@/session/schema"
import { isExitCommand, isNewCommand } from "./prompt.shared"
import type { FooterApi, FooterEvent, QueueControl, QueuedPromptPreview, RunPrompt } from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error?: unknown) => void
}

export type QueueInput = {
  footer: FooterApi
  initialInput?: string
  trace?: Trace
  demo?: boolean
  sessionID?: SessionID
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  memoryQueue?: MemoryPromptQueue
  enqueueRemote?: (prompt: RunPrompt) => Promise<void>
  pauseQueueDrainRemote?: () => Promise<void>
  resumeQueueDrainRemote?: () => Promise<void>
  getQueueRemote?: (queueID: string) => Promise<RunPrompt | undefined>
  updateQueueRemote?: (queueID: string, prompt: RunPrompt) => Promise<void>
  removeQueueRemote?: (queueID: string) => Promise<void>
  sendQueueRemote?: (queueID: string, prompt?: RunPrompt) => Promise<void>
  onSend?: (prompt: RunPrompt) => void
  onNewSession?: () => void | Promise<void>
  onAbortSteers?: (abort: () => void) => () => void
  steer?: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
  run: (prompt: RunPrompt, signal: AbortSignal) => Promise<void>
}

const isQueuedPrompt = (prompt: RunPrompt) => prompt.queued === true || prompt.delivery === "deferred"

function queueDataFromRunPrompt(
  prompt: RunPrompt,
  ctx: { agent: string; model: { providerID: string; modelID: string; variant?: string } },
): PromptQueueData {
  return {
    version: 1,
    agent: ctx.agent,
    model: {
      providerID: ProviderID.make(ctx.model.providerID),
      modelID: ModelID.make(ctx.model.modelID),
      variant: ctx.model.variant,
    },
    parts: [{ type: "text", text: prompt.text }, ...(prompt.parts as PromptQueueData["parts"])],
  }
}

type State = {
  queue: RunPrompt[]
  ctrl?: AbortController
  steerCtrls: Set<AbortController>
  closed: boolean
  nextQueueID: number
}

function withQueueID(prompt: RunPrompt, state: State): RunPrompt {
  if (prompt.queueID) return prompt
  state.nextQueueID += 1
  return { ...prompt, queueID: `queue-${state.nextQueueID}` }
}

function queueSnapshot(state: State): QueuedPromptPreview[] {
  return state.queue.map((prompt) => ({
    id: prompt.queueID ?? prompt.text,
    text: runPromptPreview(prompt) || prompt.text.trim().slice(0, 80) || "[queued]",
  }))
}

function defer<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })

  return { promise, resolve, reject }
}

// Runs the prompt queue until the footer closes.
//
// Subscribes to footer prompt events, queues them, and drains one at a
// time through input.run(). If the user submits multiple prompts while
// a turn is running, they queue up and execute in order. The footer shows
// the queue depth so the user knows how many are pending.
export async function runPromptQueue(input: QueueInput): Promise<void> {
  const stop = defer<{ type: "closed" }>()
  const done = defer()
  const state: State = {
    queue: [],
    steerCtrls: new Set(),
    closed: input.footer.isClosed,
    nextQueueID: 0,
  }
  let draining: Promise<void> | undefined

  const emit = (next: FooterEvent, row: Record<string, unknown>) => {
    input.trace?.write("ui.patch", row)
    input.footer.event(next)
  }

  const emitQueue = () => {
    // Remote queue state is driven by session.queue.updated; memoryQueue is unused for display.
    if (input.enqueueRemote) {
      return
    }

    const queued =
      input.memoryQueue && input.sessionID
        ? input.memoryQueue.list(input.sessionID).map(PromptQueue.queueItemPreview)
        : queueSnapshot(state)
    emit(
      {
        type: "queue",
        queue: state.queue.length,
        queued,
      },
      {
        queue: state.queue.length,
        queued,
      },
    )
  }

  const remoteDrafts = new Map<string, RunPrompt>()

  const findQueued = (id: string) => {
    const local = state.queue.find((prompt) => prompt.queueID === id)
    if (local) return local
    return remoteDrafts.get(id)
  }

  const removeQueued = (id: string) => {
    const index = state.queue.findIndex((prompt) => prompt.queueID === id)
    if (index === -1) return undefined
    const [removed] = state.queue.splice(index, 1)
    emitQueue()
    return removed
  }

  const updateQueued = (id: string, prompt: RunPrompt) => {
    const index = state.queue.findIndex((entry) => entry.queueID === id)
    if (index === -1) return false
    state.queue[index] = { ...withQueueID(prompt, state), queueID: id }
    emitQueue()
    return true
  }

  const updateRemote = (id: string, prompt: RunPrompt) => {
    remoteDrafts.set(id, { ...withQueueID(prompt, state), queueID: id })
    if (!input.updateQueueRemote) return true
    void input.updateQueueRemote(id, prompt).catch((error) => {
      done.reject(error)
    })
    return true
  }

  const removeRemote = async (id: string) => {
    const prompt = findQueued(id)
    remoteDrafts.delete(id)
    await input.removeQueueRemote?.(id).catch((error) => {
      done.reject(error)
    })
    return prompt
  }

  const queueControl: QueueControl = {
    get: findQueued,
    load: input.getQueueRemote
      ? async (id) => {
          const existing = findQueued(id)
          if (existing) return existing
          const loaded = await input.getQueueRemote?.(id)
          if (!loaded) return undefined
          const next = { ...withQueueID(loaded, state), queueID: id }
          remoteDrafts.set(id, next)
          return next
        }
      : undefined,
    update: (id, prompt) => {
      if (input.updateQueueRemote) return updateRemote(id, prompt)
      return updateQueued(id, prompt)
    },
    remove: (id) => {
      if (input.removeQueueRemote) return removeRemote(id)
      return removeQueued(id)
    },
    pauseDrain: () => {
      if (input.pauseQueueDrainRemote) return input.pauseQueueDrainRemote()
    },
    resumeDrain: () => {
      if (input.resumeQueueDrainRemote) return input.resumeQueueDrainRemote()
    },
    sendNow: (id: string) => {
      if (input.sendQueueRemote) {
        const prompt = findQueued(id)
        void input.sendQueueRemote(id, prompt).then(
          () => {
            remoteDrafts.delete(id)
          },
          (error) => {
            done.reject(error)
          },
        )
        return
      }
      const prompt = removeQueued(id)
      if (!prompt) return
      const next = { ...prompt, delivery: "immediate" as const }
      if (busy()) {
        steer(next)
        return
      }
      submitPrompt(next)
    },
  }

  let submitPrompt = (_prompt: RunPrompt) => {}

  const busy = () => state.ctrl !== undefined

  const steer = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )

    if (prompt.mode !== "shell" && !input.enqueueRemote) {
      const commit = { kind: "user", text: prompt.text, phase: "start", source: "system" } as const
      input.trace?.write("ui.commit", commit)
      input.footer.append(commit)
    }
    input.onSend?.({ ...prompt, delivery: "immediate" })

    const ctrl = new AbortController()
    void input.run({ ...prompt, delivery: "immediate" }, ctrl.signal).catch((error) => {
      if (ctrl.signal.aborted || state.closed) {
        return
      }

      done.reject(error)
    })
  }

  const abortSteers = () => {
    for (const ctrl of state.steerCtrls) {
      ctrl.abort()
    }
  }

  const finish = () => {
    if (!state.closed || draining) {
      return
    }

    done.resolve()
  }

  const close = () => {
    if (state.closed) {
      return
    }

    state.closed = true
    state.queue.length = 0
    state.ctrl?.abort()
    abortSteers()
    input.footer.setQueueControl?.(undefined)
    emitQueue()
    stop.resolve({ type: "closed" })
    finish()
  }

  const drain = () => {
    if (draining || state.closed || state.queue.length === 0) {
      return
    }

    draining = (async () => {
      try {
        while (!state.closed && state.queue.length > 0) {
          const prompt = state.queue.shift()
          if (!prompt) {
            continue
          }

          emitQueue()

          if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
            if (!input.onNewSession) {
              emit(
                {
                  type: "stream.patch",
                  patch: {
                    status: "new sessions unavailable",
                  },
                },
                {
                  status: "new sessions unavailable",
                },
              )
              continue
            }

            emit(
              {
                type: "stream.patch",
                patch: {
                  phase: "running",
                  status: "starting new session",
                  queue: state.queue.length,
                },
              },
              {
                phase: "running",
                status: "starting new session",
                queue: state.queue.length,
              },
            )
            await input.onNewSession()
            continue
          }

          emit(
            {
              type: "turn.send",
              queue: state.queue.length,
            },
            {
              phase: "running",
              status: "sending prompt",
              queue: state.queue.length,
            },
          )
          const start = Date.now()
          const ctrl = new AbortController()
          state.ctrl = ctrl

          try {
            await input.footer.idle()
            if (state.closed) {
              break
            }

            if (prompt.mode !== "shell" && !input.enqueueRemote) {
              const commit = { kind: "user", text: prompt.text, phase: "start", source: "system" } as const
              input.trace?.write("ui.commit", commit)
              input.footer.append(commit)
            }
            input.onSend?.(prompt)

            if (state.closed) {
              break
            }

            const task = input.run(prompt, ctrl.signal).then(
              () => ({ type: "done" as const }),
              (error) => ({ type: "error" as const, error }),
            )

            const next = await Promise.race([task, stop.promise])
            if (next.type === "closed") {
              ctrl.abort()
              break
            }

            if (next.type === "error") {
              throw next.error
            }
          } finally {
            if (state.ctrl === ctrl) {
              state.ctrl = undefined
            }

            const duration = Locale.duration(Math.max(0, Date.now() - start))
            emit(
              {
                type: "turn.duration",
                duration,
              },
              {
                duration,
              },
            )
          }
        }
      } catch (error) {
        done.reject(error)
        return
      } finally {
        draining = undefined
        emit(
          {
            type: "turn.idle",
            queue: state.queue.length,
          },
          {
            phase: "idle",
            status: "",
            queue: state.queue.length,
          },
        )
      }

      finish()
    })()
  }

  submitPrompt = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (busy() && !isQueuedPrompt(prompt)) {
      steer({ ...prompt, delivery: prompt.delivery ?? "immediate" })
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    state.queue.push(withQueueID(prompt, state))
    emitQueue()
    if (prompt.mode !== "shell" && isNewCommand(prompt.text)) {
      drain()
      return
    }

    emit(
      {
        type: "first",
        first: false,
      },
      {
        first: false,
      },
    )
    drain()
  }

  input.footer.setQueueControl?.(queueControl)

  // Ctrl+Shift+Enter queues a prompt with delivery="deferred". Unlike a normal submit,
  // it never kicks off draining on its own: if a turn is already running, the
  // in-flight drain loop picks it up after the current turn; if the session is
  // idle, it stays queued until the next normal submit drains it.
  const enqueue = (prompt: RunPrompt) => {
    if (!prompt.text.trim() || state.closed) {
      return
    }

    if (input.demo) {
      emit(
        { type: "stream.patch", patch: { status: "queue unavailable in demo" } },
        { status: "queue unavailable in demo" },
      )
      return
    }

    if (prompt.mode !== "shell" && isExitCommand(prompt.text)) {
      input.footer.close()
      return
    }

    if (input.enqueueRemote) {
      void input.enqueueRemote(prompt).catch((error) => {
        done.reject(error)
      })
      emit(
        { type: "first", first: false },
        { first: false },
      )
      return
    }

    if (!input.memoryQueue) {
      state.queue.push(withQueueID(prompt, state))
      emitQueue()
      emit(
        { type: "first", first: false },
        { first: false },
      )
      return
    }

    if (!input.sessionID || !input.agent || !input.model) return
    input.memoryQueue.enqueue(
      input.sessionID,
      queueDataFromRunPrompt(prompt, { agent: input.agent, model: input.model }),
    )
    emitQueue()
    emit(
      { type: "first", first: false },
      { first: false },
    )
  }

  const offPrompt = input.footer.onPrompt((prompt) => {
    if (isQueuedPrompt(prompt)) {
      enqueue(prompt)
      return
    }
    submitPrompt(prompt)
  })
  const offClose = input.footer.onClose(() => {
    close()
  })
  const offAbortSteers = input.onAbortSteers?.(abortSteers) ?? (() => {})

  try {
    if (state.closed) {
      return
    }

    submitPrompt({
      text: input.initialInput ?? "",
      parts: [],
    })
    finish()
    await done.promise
  } finally {
    offPrompt()
    offClose()
    offAbortSteers()
    close()
    input.footer.setQueueControl?.(undefined)
    await draining?.catch(() => {})
  }
}
