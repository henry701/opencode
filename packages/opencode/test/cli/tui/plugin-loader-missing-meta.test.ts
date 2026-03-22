import { expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { CliRenderer } from "@opentui/core"
import { tmpdir } from "../../fixture/fixture"
import { Log } from "../../../src/util/log"
import { TuiConfig } from "../../../src/config/tui"
import { createPluginKeybind } from "../../../src/cli/cmd/tui/context/plugin-keybinds"

mock.module("@opentui/solid/preload", () => ({}))
mock.module("@opentui/solid", () => ({
  createSolidSlotRegistry: () => ({
    register: () => () => {},
  }),
  createSlot: () => () => null,
  useRenderer: () => ({
    getPalette: async () => ({ palette: [] as string[] }),
    clearPaletteCache: () => {},
  }),
}))
mock.module("@opentui/solid/jsx-runtime", () => ({
  Fragment: Symbol.for("Fragment"),
  jsx: () => null,
  jsxs: () => null,
  jsxDEV: () => null,
}))
const { TuiPlugin } = await import("../../../src/cli/cmd/tui/plugin")

async function waitForLog(text: string, timeout = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const file = Log.file()
    if (file) {
      const content = await Bun.file(file)
        .text()
        .catch(() => "")
      if (content.includes(text)) return content
    }
    await Bun.sleep(25)
  }
  return Bun.file(Log.file())
    .text()
    .catch(() => "")
}

test("continues loading tui plugins when a plugin is missing config metadata", async () => {
  const stamp = Date.now()
  await using tmp = await tmpdir({
    init: async (dir) => {
      const badPluginPath = path.join(dir, `missing-meta-plugin-${stamp}.ts`)
      const nextPluginPath = path.join(dir, `next-plugin-${stamp}.ts`)
      const plainPluginPath = path.join(dir, `plain-plugin-${stamp}.ts`)
      const badSpec = pathToFileURL(badPluginPath).href
      const nextSpec = pathToFileURL(nextPluginPath).href
      const plainSpec = pathToFileURL(plainPluginPath).href
      const badMarker = path.join(dir, "missing-meta-called.txt")
      const nextMarker = path.join(dir, "next-called.txt")
      const plainMarker = path.join(dir, "plain-called.txt")

      await Bun.write(
        badPluginPath,
        `export default {
  tui: async (_input, options) => {
    if (!options?.marker) return
    await Bun.write(options.marker, "called")
  },
}
`,
      )

      await Bun.write(
        nextPluginPath,
        `export default {
  tui: async (_input, options) => {
    if (!options?.marker) return
    await Bun.write(options.marker, "called")
  },
}
`,
      )

      await Bun.write(
        plainPluginPath,
        `export default {
  tui: async (_input, options) => {
    await Bun.write(${JSON.stringify(plainMarker)}, options === undefined ? "undefined" : options === null ? "null" : "value")
  },
}
`,
      )

      return {
        badSpec,
        nextSpec,
        plainSpec,
        badMarker,
        nextMarker,
        plainMarker,
      }
    },
  })

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const bad = path.parse(new URL(tmp.extra.badSpec).pathname).name
  const next = path.parse(new URL(tmp.extra.nextSpec).pathname).name
  const plain = path.parse(new URL(tmp.extra.plainSpec).pathname).name
  const get = spyOn(TuiConfig, "get").mockResolvedValue({
    plugin: [
      [tmp.extra.badSpec, { marker: tmp.extra.badMarker }],
      [tmp.extra.nextSpec, { marker: tmp.extra.nextMarker }],
      tmp.extra.plainSpec,
    ],
    plugin_meta: {
      [next]: {
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
      [plain]: {
        scope: "local",
        source: path.join(tmp.path, "tui.json"),
      },
    },
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()

  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  let selected = "opencode"
  const renderer = {
    ...Object.create(null),
    once(this: CliRenderer) {
      return this
    },
  } satisfies CliRenderer
  const kv: Record<string, unknown> = {}
  const keybind = {
    match: () => false,
    print: (key: string) => key,
  }

  try {
    await TuiPlugin.init({
      client: createOpencodeClient({
        baseUrl: "http://localhost:4096",
      }),
      event: {
        on: () => () => {},
      },
      renderer,
      api: {
        command: {
          register: () => {},
          trigger: () => {},
        },
        route: {
          register: () => () => {},
          navigate: () => {},
          get current() {
            return { name: "home" as const }
          },
        },
        ui: {
          Dialog: () => null,
          DialogAlert: () => null,
          DialogConfirm: () => null,
          DialogPrompt: () => null,
          DialogSelect: () => null,
          toast: () => {},
          dialog: {
            replace: () => {},
            clear: () => {},
            setSize: () => {},
            get size() {
              return "medium" as const
            },
            get depth() {
              return 0
            },
            get open() {
              return false
            },
          },
        },
        keybind: {
          ...keybind,
          create(defaults, overrides) {
            return createPluginKeybind(keybind, defaults, overrides)
          },
        },
        kv: {
          get(key, fallback) {
            return (kv[key] ?? fallback) as never
          },
          set(key, value) {
            kv[key] = value
          },
          get ready() {
            return true
          },
        },
        state: {
          session: {
            diff() {
              return []
            },
            todo() {
              return []
            },
          },
          lsp() {
            return []
          },
          mcp() {
            return []
          },
        },
        theme: {
          get current() {
            return {}
          },
          get selected() {
            return selected
          },
          has() {
            return false
          },
          set(name) {
            selected = name
            return true
          },
          async install() {
            throw new Error("base theme.install should not run")
          },
          mode() {
            return "dark" as const
          },
          get ready() {
            return true
          },
        },
      },
    })

    await expect(fs.readFile(tmp.extra.badMarker, "utf8")).rejects.toThrow()
    await expect(fs.readFile(tmp.extra.nextMarker, "utf8")).resolves.toBe("called")
    await expect(fs.readFile(tmp.extra.plainMarker, "utf8")).resolves.toBe("undefined")

    const log = await waitForLog("missing tui plugin metadata")
    expect(log).toContain("missing tui plugin metadata")
    expect(log).toContain(`name=${bad}`)
  } finally {
    cwd.mockRestore()
    get.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})
