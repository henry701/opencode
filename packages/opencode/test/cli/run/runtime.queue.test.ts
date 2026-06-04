import { describe, expect, test } from "bun:test"
import { runPromptQueue } from "@/cli/cmd/run/runtime.queue"
import type { FooterApi, FooterEvent, RunPrompt, StreamCommit } from "@/cli/cmd/run/types"

function footer() {
  const prompts = new Set<(input: RunPrompt) => void>()
  const closes = new Set<() => void>()
  const events: FooterEvent[] = []
  const commits: StreamCommit[] = []
  let closed = false

  const api: FooterApi = {
    get isClosed() {
      return closed
    },
    onPrompt(fn) {
      prompts.add(fn)
      return () => {
        prompts.delete(fn)
      }
    },
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    setQueueControl() {},
    event(next) {
      events.push(next)
    },
    append(next) {
      commits.push(next)
    },
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      for (const fn of [...closes]) {
        fn()
      }
    },
    destroy() {
      api.close()
      prompts.clear()
      closes.clear()
    },
  }

  return {
    api,
    events,
    commits,
    submit(text: string, opts?: { mode?: RunPrompt["mode"]; delivery?: RunPrompt["delivery"]; queued?: boolean }) {
      const next: RunPrompt = {
        text,
        parts: [] as RunPrompt["parts"],
        ...(opts?.mode ? { mode: opts.mode } : {}),
        ...(opts?.delivery ? { delivery: opts.delivery } : {}),
        ...(opts?.queued ? { queued: true } : {}),
      }
      for (const fn of [...prompts]) {
        fn(next)
      }
    },
  }
}

describe("run runtime queue", () => {
  test("ignores empty prompts", async () => {
    const ui = footer()
    let calls = 0

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("   ")
    ui.api.close()
    await task

    expect(calls).toBe(0)
  })

  test("treats /exit as a close command", async () => {
    const ui = footer()
    let calls = 0

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        calls += 1
      },
    })

    ui.submit("/exit")
    await task

    expect(calls).toBe(0)
  })

  test("treats /new as a local session command", async () => {
    const ui = footer()
    const seen: string[] = []
    let created = 0

    const task = runPromptQueue({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    ui.submit("/new")
    ui.submit("hello")
    await task

    expect(created).toBe(1)
    expect(seen).toEqual(["hello"])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "hello",
        phase: "start",
        source: "system",
      },
    ])
  })

  test("shell mode submits /exit as a shell command", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/exit", { mode: "shell" })
    await task

    expect(seen).toEqual([{ text: "/exit", parts: [], mode: "shell", queueID: "queue-1" }])
    expect(ui.commits).toEqual([])
  })

  test("shell mode submits /new instead of creating a session", async () => {
    const ui = footer()
    const seen: RunPrompt[] = []
    let created = 0

    const task = runPromptQueue({
      footer: ui.api,
      onNewSession: async () => {
        created += 1
      },
      run: async (input) => {
        seen.push(input)
        ui.api.close()
      },
    })

    ui.submit("/new", { mode: "shell" })
    await task

    expect(created).toBe(0)
    expect(seen).toEqual([{ text: "/new", parts: [], mode: "shell", queueID: "queue-1" }])
    expect(ui.commits).toEqual([])
  })

  test("shell mode does not append a synthetic user row", async () => {
    const ui = footer()

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        expect(ui.commits).toEqual([])
        ui.api.close()
      },
    })

    ui.submit("ls", { mode: "shell" })
    await task
  })

  test("preserves whitespace for initial input", async () => {
    const ui = footer()
    const seen: string[] = []

    await runPromptQueue({
      footer: ui.api,
      initialInput: "  hello  ",
      run: async (input) => {
        seen.push(input.text)
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
    expect(ui.commits).toEqual([
      {
        kind: "user",
        text: "  hello  ",
        phase: "start",
        source: "system",
      },
    ])
  })

  test("passes prompts to onSend", async () => {
    const ui = footer()
    const seen: string[] = []

    await runPromptQueue({
      footer: ui.api,
      initialInput: "  hello  ",
      onSend: (input) => {
        seen.push(input.text)
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(seen).toEqual(["  hello  "])
  })

  test("appends the user row before the turn starts", async () => {
    const ui = footer()

    await runPromptQueue({
      footer: ui.api,
      initialInput: "/fmt bash",
      run: async () => {
        expect(ui.commits).toEqual([
          {
            kind: "user",
            text: "/fmt bash",
            phase: "start",
            source: "system",
          },
        ])
        ui.api.close()
      },
    })
  })

  test("runs queued prompts in order", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    ui.submit("one")
    ui.submit("two", { queued: true })
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    wake?.()
    await task

    expect(seen).toEqual(["one", "two"])
  })

  test("drains a prompt queued during an in-flight turn", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    ui.submit("one")
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    wake?.()
    await Promise.resolve()
    ui.submit("two")
    await task

    expect(seen).toEqual(["one", "two"])
  })

  test("close aborts the active run and drops pending queued work", async () => {
    const ui = footer()
    const seen: string[] = []
    let hit = false

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input, signal) => {
        seen.push(input.text)
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            hit = true
            resolve()
            return
          }

          signal.addEventListener(
            "abort",
            () => {
              hit = true
              resolve()
            },
            { once: true },
          )
        })
      },
    })

    ui.submit("one")
    await Promise.resolve()
    ui.submit("two", { queued: true })
    ui.api.close()
    await task

    expect(hit).toBe(true)
    expect(seen).toEqual(["one"])
  })

  test("propagates run errors", async () => {
    const ui = footer()

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        throw new Error("boom")
      },
    })

    ui.submit("one")
    await expect(task).rejects.toThrow("boom")
  })

  test("steers immediate prompts during an in-flight turn", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }
      },
    })

    ui.submit("one")
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    ui.submit("steer")
    await Promise.resolve()
    expect(seen).toEqual(["one", "steer"])
    expect(ui.commits.filter((item) => item.kind === "user").map((item) => item.text)).toEqual(["one", "steer"])

    wake?.()
    ui.api.close()
    await task
  })

  test("deferred delivery enqueues without starting a drain", async () => {
    const ui = footer()
    const seen: string[] = []
    let wake: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      wake = resolve
    })

    const task = runPromptQueue({
      footer: ui.api,
      run: async (input) => {
        seen.push(input.text)
        if (seen.length === 1) {
          await gate
          return
        }

        ui.api.close()
      },
    })

    ui.submit("one")
    await Promise.resolve()
    expect(seen).toEqual(["one"])

    ui.submit("queued", { queued: true })
    await Promise.resolve()
    expect(seen).toEqual(["one"])
    expect(ui.events.some((event) => event.type === "queue" && event.queue === 1)).toBe(true)

    wake?.()
    await task

    expect(seen).toEqual(["one", "queued"])
  })

  test("queue control updates queued prompts in place", async () => {
    const ui = footer()
    let control: import("@/cli/cmd/run/types").QueueControl | undefined

    const task = runPromptQueue({
      footer: {
        ...ui.api,
        setQueueControl(next) {
          control = next
        },
      },
      run: async () => {
        ui.api.close()
      },
    })

    ui.submit("one", { queued: true })
    await Promise.resolve()
    const id = control?.get("queue-1")?.queueID
    expect(id).toBe("queue-1")
    expect(control?.update("queue-1", { text: "updated", parts: [] })).toBe(true)
    expect(control?.get("queue-1")?.text).toBe("updated")

    ui.api.close()
    await task
  })

  test("remote queue control caches drafts for edit and update", async () => {
    const ui = footer()
    let control: import("@/cli/cmd/run/types").QueueControl | undefined
    const updates: { id: string; text: string }[] = []

    const task = runPromptQueue({
      footer: {
        ...ui.api,
        setQueueControl(next) {
          control = next
        },
      },
      updateQueueRemote: async (id, prompt) => {
        updates.push({ id, text: prompt.text })
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(control?.get("pqu_test")).toBeUndefined()
    expect(control?.update("pqu_test", { text: "draft", parts: [], queueID: "pqu_test" })).toBe(true)
    expect(control?.get("pqu_test")?.text).toBe("draft")
    expect(updates).toEqual([{ id: "pqu_test", text: "draft" }])

    ui.api.close()
    await task
  })

  test("remote queue control loads full queued prompt details before editing", async () => {
    const ui = footer()
    let control: import("@/cli/cmd/run/types").QueueControl | undefined
    const loaded: string[] = []

    const task = runPromptQueue({
      footer: {
        ...ui.api,
        setQueueControl(next) {
          control = next
        },
      },
      getQueueRemote: async (id) => {
        loaded.push(id)
        return {
          text: "line one\nline two",
          parts: [{ type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" }],
          queueID: id,
          queued: true,
        }
      },
      updateQueueRemote: async () => {},
      run: async () => {
        ui.api.close()
      },
    })

    expect(control?.get("pqu_full")).toBeUndefined()
    expect(await control?.load?.("pqu_full")).toEqual({
      text: "line one\nline two",
      parts: [{ type: "file", url: "file:///tmp/a.ts", filename: "a.ts", mime: "text/typescript" }],
      queueID: "pqu_full",
      queued: true,
    })
    expect(control?.get("pqu_full")?.text).toBe("line one\nline two")
    expect(loaded).toEqual(["pqu_full"])

    ui.api.close()
    await task
  })

  test("remote queue control allows pause to settle before send now", async () => {
    const ui = footer()
    let control: import("@/cli/cmd/run/types").QueueControl | undefined
    const calls: string[] = []
    const sent: { id: string; text?: string }[] = []

    const task = runPromptQueue({
      footer: {
        ...ui.api,
        setQueueControl(next) {
          control = next
        },
      },
      pauseQueueDrainRemote: async () => {
        calls.push("pause")
      },
      updateQueueRemote: async () => {},
      sendQueueRemote: async (id, prompt) => {
        calls.push("send")
        sent.push({ id, text: prompt?.text })
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(control?.update("pqu_test", { text: "edited", parts: [], queueID: "pqu_test" })).toBe(true)
    await control?.pauseDrain?.()
    await control?.sendNow("pqu_test")

    expect(calls).toEqual(["pause", "send"])
    expect(sent).toEqual([{ id: "pqu_test", text: "edited" }])

    ui.api.close()
    await task
  })

  test("remote queue control send now does not block on the assistant turn", async () => {
    const ui = footer()
    let control: import("@/cli/cmd/run/types").QueueControl | undefined
    let finishSend!: () => void
    const sendFinished = new Promise<void>((resolve) => {
      finishSend = resolve
    })
    const sent: string[] = []

    const task = runPromptQueue({
      footer: {
        ...ui.api,
        setQueueControl(next) {
          control = next
        },
      },
      updateQueueRemote: async () => {},
      sendQueueRemote: async (id) => {
        sent.push(id)
        await sendFinished
      },
      run: async () => {
        ui.api.close()
      },
    })

    expect(control?.update("pqu_test", { text: "edited", parts: [], queueID: "pqu_test" })).toBe(true)
    const sendNow = control?.sendNow("pqu_test")
    let settled = false
    void Promise.resolve(sendNow).then(() => {
      settled = true
    })
    await Promise.resolve()

    expect(sent).toEqual(["pqu_test"])
    expect(settled).toBe(true)

    finishSend()
    await sendFinished
    ui.api.close()
    await task
  })

  test("demo mode does not enqueue prompts", async () => {
    const ui = footer()
    let status = ""

    ui.api.event = (next) => {
      if (next.type === "stream.patch" && next.patch?.status) status = next.patch.status
    }

    const task = runPromptQueue({
      footer: ui.api,
      demo: true,
      run: async () => {},
    })

    ui.submit("queued", { queued: true })
    ui.api.close()
    await task

    expect(status).toBe("queue unavailable in demo")
  })

  test("deferred delivery ignores empty prompts", async () => {
    const ui = footer()
    let calls = 0

    const task = runPromptQueue({
      footer: ui.api,
      run: async () => {
        calls += 1
        ui.api.close()
      },
    })

    ui.submit("   ", { queued: true })
    ui.api.close()
    await task

    expect(calls).toBe(0)
  })
})
