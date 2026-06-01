/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import { testRender } from "@opentui/solid"
import type { JSX as SolidJSX } from "solid-js"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PromptQueueDock } from "../../../src/cli/cmd/tui/component/prompt/queue-dock"
import { listDeferredQueued } from "../../../src/cli/cmd/tui/component/prompt/queue"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { tmpdir } from "../../fixture/fixture"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"

const active: { destroy: () => void }[] = []

afterEach(() => {
  for (const item of active.splice(0)) {
    item.destroy()
  }
})

function withTheme(component: () => SolidJSX.Element) {
  const config = createTuiResolvedConfig()
  return (
    <TuiConfigProvider config={config}>
      <KVProvider>
        <ThemeProvider mode="dark">{component()}</ThemeProvider>
      </KVProvider>
    </TuiConfigProvider>
  )
}

async function renderFrame(
  component: () => SolidJSX.Element,
  size: { width: number; height: number } = { width: 100, height: 20 },
) {
  const app = await testRender(() => withTheme(component), size)
  active.push({ destroy: () => app.renderer.destroy() })
  for (let attempt = 0; attempt < 5; attempt++) {
    await app.renderOnce()
    await Bun.sleep(25)
    const frame = app.captureCharFrame()
    if (frame.trim().length > 0) return frame
  }
  return app.captureCharFrame()
}

test("queue dock lists deferred messages in fifo order with screencap artifact", async () => {
  const tmp = await tmpdir()
  const capDir = path.join(tmp.path, "queue-smoke")
  await mkdir(capDir, { recursive: true })

  const messages = [
    { id: "u1", role: "user", time: { created: 1 } },
    { id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } },
    { id: "u2", role: "user", delivery: "deferred", time: { created: 3 } },
    { id: "u3", role: "user", delivery: "deferred", time: { created: 4 } },
    { id: "u4", role: "user", delivery: "deferred", time: { created: 5 } },
  ] as Message[]

  const parts = {
    u2: [{ id: "p1", sessionID: "s", messageID: "u2", type: "text" as const, text: "first queued" }],
    u3: [{ id: "p2", sessionID: "s", messageID: "u3", type: "text" as const, text: "second queued" }],
    u4: [{ id: "p3", sessionID: "s", messageID: "u4", type: "text" as const, text: "third queued" }],
  }

  const items = listDeferredQueued({
    messages,
    parts,
    pendingAssistantID: "a1",
  })

  expect(items.map((item) => item.text)).toEqual(["first queued", "second queued", "third queued"])

  const frame = await renderFrame(() => (
    <PromptQueueDock items={() => items} onEdit={() => {}} onSendNow={() => {}} />
  ))

  await writeFile(path.join(capDir, "queue-dock.txt"), frame)

  expect(frame).toContain("3 messages queued")
  expect(frame.indexOf("first queued")).toBeLessThan(frame.indexOf("second queued"))
  expect(frame.indexOf("second queued")).toBeLessThan(frame.indexOf("third queued"))
  expect(frame).toContain("[edit]")
})

test("runs serve API smoke script when bash is available", async () => {
  if (!Bun.which("bash") || !Bun.which("curl") || !Bun.which("jq")) return

  const script = path.join(import.meta.dir, "scripts/prompt-queue-tui-smoke.sh")
  const proc = Bun.spawn(["bash", "-n", script], { stdout: "pipe", stderr: "pipe" })
  expect(await proc.exited).toBe(0)
}, 10_000)
