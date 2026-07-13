/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
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

test("TUI sync preserves queued prompts across rollback session updates", async () => {
  const state = "/tmp/opencode/state"
  await mkdir(state, { recursive: true })
  await writeFile(path.join(state, "kv.json"), "{}")

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
    <TestTuiContexts paths={{ state }}>
      <ArgsProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} events={events.source} fetch={calls.fetch}>
            <PermissionProvider>
              <ProjectProvider>
                <ExitProvider exit={() => {}}>
                  <SyncProvider>
                    <Probe />
                  </SyncProvider>
                </ExitProvider>
              </ProjectProvider>
            </PermissionProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
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
