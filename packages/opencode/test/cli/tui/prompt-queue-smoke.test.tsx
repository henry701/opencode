/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { afterEach, expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import type { JSX as SolidJSX } from "solid-js"
import { onCleanup } from "solid-js"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { PromptQueueDock } from "../../../src/cli/cmd/tui/component/prompt/queue-dock"
import { listDeferredQueued } from "../../../src/cli/cmd/tui/component/prompt/queue"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { tmpdir } from "../../fixture/fixture"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/cli/cmd/tui/keymap"

const active: { destroy: () => void }[] = []

afterEach(() => {
  for (const item of active.splice(0)) {
    item.destroy()
  }
})

function withTheme(component: () => SolidJSX.Element) {
  const config = createTuiResolvedConfig()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <ThemeProvider mode="dark">{component()}</ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  return <Harness />
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

  const items = listDeferredQueued({
    pending: [
      { id: "pqu_1", text: "first queued" },
      { id: "pqu_2", text: "second queued" },
      { id: "pqu_3", text: "third queued" },
    ],
  })

  expect(items.map((item) => item.text)).toEqual(["first queued", "second queued", "third queued"])

  const frame = await renderFrame(() => (
    <PromptQueueDock items={() => items} onEdit={() => {}} onSendNow={() => {}} />
  ))

  await writeFile(path.join(capDir, "queue-dock.txt"), frame)

  expect(frame).toContain("3 messages queued")
  expect(frame.indexOf("first queued")).toBeLessThan(frame.indexOf("second queued"))
  expect(frame).not.toContain("third queued")
  expect(frame).toContain("+1 more queued")
  expect(frame).toContain("[edit]")
  expect(frame).toContain("[send now]")
  expect(frame).toContain("1. first queued")
})

test("queue dock keeps active queued edit preview to one line", async () => {
  const frame = await renderFrame(() => (
    <PromptQueueDock
      items={() => [{ id: "pqu_1", text: "line one\nline two\nline three" }]}
      editing={() => true}
      editingMessageID={() => "pqu_1"}
      onEdit={() => {}}
      onSendNow={() => {}}
    />
  ))

  expect(frame).toContain("Editing queued message")
  expect(frame).toContain("1. line one")
  expect(frame).not.toContain("line two")
})

test("queue dock edit mode renders only a three item window around the active queue item", async () => {
  const items = [
    { id: "pqu_1", text: "first queued" },
    { id: "pqu_2", text: "second queued" },
    { id: "pqu_3", text: "third queued" },
    { id: "pqu_4", text: "fourth queued" },
    { id: "pqu_5", text: "fifth queued" },
  ]

  const frame = await renderFrame(() => (
    <PromptQueueDock
      items={() => items}
      editing={() => true}
      editingMessageID={() => "pqu_3"}
      onEdit={() => {}}
      onSendNow={() => {}}
    />
  ))

  expect(frame).toContain("5 messages queued")
  expect(frame).toContain("2. second queued")
  expect(frame).toContain("3. third queued")
  expect(frame).toContain("4. fourth queued")
  expect(frame).not.toContain("first queued")
  expect(frame).not.toContain("fifth queued")
})

test("runs serve API smoke script when bash is available", async () => {
  if (!Bun.which("bash") || !Bun.which("curl") || !Bun.which("jq")) return

  const script = path.join(import.meta.dir, "scripts/prompt-queue-tui-smoke.sh")
  const proc = Bun.spawn(["bash", "-n", script], { stdout: "pipe", stderr: "pipe" })
  expect(await proc.exited).toBe(0)
}, 10_000)
