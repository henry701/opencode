/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { DataProvider, useData } from "../../../src/context/data"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function global(payload: Event): GlobalEvent {
  return { directory, project: "proj_test", payload }
}

test("current TUI data preserves queued prompts across rollback session updates", async () => {
  const state = "/tmp/opencode/state"
  await mkdir(state, { recursive: true })
  await writeFile(path.join(state, "kv.json"), "{}")

  const events = createEventSource()
  const queued = [
    {
      id: "pqu_1",
      sessionID: "ses_1",
      position: 0,
      timeCreated: 1,
      payload: {
        version: 1,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        parts: [{ type: "text", text: "stay queued after rollback" }],
      },
    },
  ]
  let queueRequests = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/ses_1/queue") {
      queueRequests++
      return json({ data: queued })
    }
    return undefined
  })
  let data!: ReturnType<typeof useData>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    data = useData()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={{ state }}>
      <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
        <ProjectProvider>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ProjectProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  try {
    await mounted
    await data.session.queue.refresh("ses_1")
    expect(data.session.queue.list("ses_1")).toEqual([{ id: "pqu_1", text: "stay queued after rollback" }])

    events.emit(
      global({
        id: "evt_queue_1",
        type: "session.next.prompt.admitted",
        properties: {
          sessionID: "ses_1",
          messageID: "pqu_1",
          prompt: { text: "stay queued after rollback" },
          delivery: "queue",
        },
      } as unknown as Event),
    )
    await wait(() => queueRequests === 2)

    events.emit(
      global({
        id: "evt_session_1",
        type: "session.updated",
        properties: {
          info: {
            id: "ses_1",
            time: { created: 1, updated: 2 },
            revert: { messageID: "msg_1" },
          },
        },
      } as unknown as Event),
    )

    await Bun.sleep(25)
    expect(data.session.queue.list("ses_1")).toEqual([{ id: "pqu_1", text: "stay queued after rollback" }])
  } finally {
    app.renderer.destroy()
  }
})
