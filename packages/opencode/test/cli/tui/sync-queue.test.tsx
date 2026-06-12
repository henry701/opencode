/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { createExit, ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"

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

test("TUI sync preserves queued prompts across rollback session updates", async () => {
  await mkdir(Global.Path.state, { recursive: true })
  await writeFile(path.join(Global.Path.state, "kv.json"), "{}")

  const events = createEventSource()
  const calls = createFetch()
  let sync!: ReturnType<typeof useSync>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    sync = useSync()
    onMount(ready)
    return <box />
  }

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
      <ProjectProvider>
        <KVProvider>
          <ExitProvider exit={createExit(async () => {})}>
            <ArgsProvider>
              <SyncProvider>
                <Probe />
              </SyncProvider>
            </ArgsProvider>
          </ExitProvider>
        </KVProvider>
      </ProjectProvider>
    </SDKProvider>
  ))

  try {
    await mounted
    await wait(() => sync.ready)

    events.emit(
      global({
        id: "evt_queue_1",
        type: "session.queue.updated",
        properties: {
          sessionID: "ses_1",
          items: [{ id: "pqu_1", text: "stay queued after rollback" }],
        },
      } as unknown as Event),
    )
    await wait(() => sync.data.prompt_queue.ses_1?.length === 1)

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
    expect(sync.data.prompt_queue.ses_1).toEqual([{ id: "pqu_1", text: "stay queued after rollback" }])
  } finally {
    app.renderer.destroy()
  }
})
