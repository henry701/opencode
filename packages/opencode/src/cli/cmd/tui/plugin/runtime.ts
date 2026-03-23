import "@opentui/solid/runtime-plugin-support"
import {
  type TuiPlugin as TuiPluginFn,
  type TuiPluginInit,
  type TuiPluginInput,
  type TuiTheme,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import type { CliRenderer } from "@opentui/core"
import path from "path"
import { fileURLToPath } from "url"

import { Config } from "@/config/config"
import { TuiConfig } from "@/config/tui"
import { Log } from "@/util/log"
import { isRecord } from "@/util/record"
import { Instance } from "@/project/instance"
import { isDeprecatedPlugin, resolvePluginTarget, uniqueModuleEntries } from "@/plugin/shared"
import { PluginMeta } from "@/plugin/meta"
import { addTheme, hasTheme } from "../context/theme"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { INTERNAL_TUI_PLUGINS, type InternalTuiPlugin } from "./internal"
import { getTuiSlotPlugin, setupSlots, Slot as View, type InitInput } from "./slots"

type Loaded = {
  item?: Config.PluginSpec
  spec: string
  target: string
  retry: boolean
  mod: Record<string, unknown>
  install: TuiTheme["install"]
}
type Deps = {
  wait?: Promise<void>
}

const log = Log.create({ service: "tui.plugin" })

function isTuiPlugin(value: unknown): value is TuiPluginFn<CliRenderer, JSX.Element> {
  return typeof value === "function"
}

function getTuiPlugin(value: unknown) {
  if (!isRecord(value) || !("tui" in value)) return
  if (!isTuiPlugin(value.tui)) return
  return value.tui
}

function isTheme(value: unknown) {
  if (!isRecord(value)) return false
  if (!isRecord(value.theme)) return false
  return true
}

function localDir(file: string) {
  const dir = path.dirname(file)
  if (path.basename(dir) === ".opencode") return path.join(dir, "themes")
  return path.join(dir, ".opencode", "themes")
}

function scopeDir(pluginMeta: TuiConfig.PluginMeta) {
  if (pluginMeta.scope === "local") return localDir(pluginMeta.source)
  return path.join(Global.Path.config, "themes")
}

function pluginRoot(spec: string, target: string) {
  if (spec.startsWith("file://")) return path.dirname(fileURLToPath(spec))
  if (target.startsWith("file://")) return path.dirname(fileURLToPath(target))
  return target
}

function rootDir(root?: string) {
  if (!root) return process.cwd()
  if (root.startsWith("file://")) {
    const file = fileURLToPath(root)
    if (root.endsWith("/")) return file
    return path.dirname(file)
  }
  if (path.isAbsolute(root)) return root
  return path.resolve(process.cwd(), root)
}

function resolveThemePath(root: string, file: string) {
  if (file.startsWith("file://")) return fileURLToPath(file)
  if (path.isAbsolute(file)) return file
  return path.resolve(root, file)
}

function themeName(file: string) {
  return path.basename(file, path.extname(file))
}

function getPluginMeta(config: TuiConfig.Info, item: Config.PluginSpec) {
  const key = Config.getPluginName(item)
  return config.plugin_meta?.[key]
}

function makeInstallFn(meta: TuiConfig.PluginMeta, root: string, spec: string): TuiTheme["install"] {
  return async (file) => {
    const src = resolveThemePath(root, file)
    const theme = themeName(src)
    if (hasTheme(theme)) return

    const text = await Filesystem.readText(src).catch((error) => {
      log.warn("failed to read tui plugin theme", { path: spec, theme: src, error })
      return
    })
    if (text === undefined) return

    const fail = Symbol()
    const data = await Promise.resolve(text)
      .then((x) => JSON.parse(x) as unknown)
      .catch((error) => {
        log.warn("failed to parse tui plugin theme", { path: spec, theme: src, error })
        return fail
      })
    if (data === fail) return

    if (!isTheme(data)) {
      log.warn("invalid tui plugin theme", { path: spec, theme: src })
      return
    }

    const dest = path.join(scopeDir(meta), `${theme}.json`)
    if (!(await Filesystem.exists(dest))) {
      await Filesystem.write(dest, text).catch((error) => {
        log.warn("failed to persist tui plugin theme", { path: spec, theme: src, dest, error })
      })
    }

    addTheme(theme, data)
  }
}

function waitDeps(state: Deps) {
  state.wait ??= TuiConfig.waitForDependencies().catch((error) => {
    log.warn("failed waiting for tui plugin dependencies", { error })
  })
  return state.wait
}

async function prepPlugin(config: TuiConfig.Info, item: Config.PluginSpec, retry = false): Promise<Loaded | undefined> {
  const spec = Config.pluginSpecifier(item)
  if (isDeprecatedPlugin(spec)) return
  log.info("loading tui plugin", { path: spec, retry })
  const target = await resolvePluginTarget(spec).catch((error) => {
    log.error("failed to resolve tui plugin", { path: spec, retry, error })
    return
  })
  if (!target) return

  const root = pluginRoot(spec, target)
  const pluginMeta = getPluginMeta(config, item)
  if (!pluginMeta) {
    log.warn("missing tui plugin metadata", {
      path: spec,
      retry,
      name: Config.getPluginName(item),
    })
    return
  }

  const install = makeInstallFn(pluginMeta, root, spec)
  const mod = await import(target).catch((error) => {
    log.error("failed to load tui plugin", { path: spec, retry, error })
    return
  })
  if (!mod) return

  return {
    item,
    spec,
    target,
    retry,
    mod,
    install,
  }
}

function createInit(
  spec: string,
  target: string,
  meta: Awaited<ReturnType<typeof PluginMeta.touch>> | undefined,
  name?: string,
): TuiPluginInit {
  if (meta) {
    return {
      state: meta.state,
      entry: meta.entry,
    }
  }

  const source = spec.startsWith("internal:") ? "internal" : spec.startsWith("file://") ? "file" : "npm"
  const now = Date.now()
  return {
    state: source === "internal" ? "same" : "first",
    entry: {
      name: name ?? spec,
      source,
      spec,
      target,
      first_time: now,
      last_time: now,
      time_changed: now,
      load_count: 1,
      fingerprint: target,
    },
  }
}

function prepInternalPlugin(item: InternalTuiPlugin): Loaded {
  const spec = `internal:${item.name}`
  const target = item.root ?? spec
  const root = rootDir(item.root)

  return {
    spec,
    target,
    retry: false,
    mod: item.module,
    install: makeInstallFn(
      {
        scope: "global",
        source: target,
      },
      root,
      spec,
    ),
  }
}

async function applyPlugin(input: TuiPluginInput<CliRenderer, JSX.Element>, load: Loaded, init: TuiPluginInit) {
  const api = {
    command: input.api.command,
    route: input.api.route,
    ui: input.api.ui,
    keybind: input.api.keybind,
    theme: Object.create(input.api.theme, {
      install: {
        value: load.install,
        configurable: true,
        enumerable: true,
      },
    }),
    kv: input.api.kv,
    state: input.api.state,
  } satisfies TuiPluginInput<CliRenderer, JSX.Element>["api"]
  const opts = load.item ? Config.pluginOptions(load.item) : undefined

  for (const [name, value] of uniqueModuleEntries(load.mod)) {
    if (!value || typeof value !== "object") {
      log.warn("ignoring non-object tui plugin export", {
        path: load.spec,
        name,
        type: value === null ? "null" : typeof value,
      })
      continue
    }

    const slotPlugin = getTuiSlotPlugin(value)
    if (slotPlugin) input.slots.register(slotPlugin)

    const tuiPlugin = getTuiPlugin(value)
    if (!tuiPlugin) continue
    await tuiPlugin(
      {
        ...input,
        api,
      },
      opts,
      init,
    )
  }
}

export namespace TuiPlugin {
  let dir = ""
  let loaded: Promise<void> | undefined
  export const Slot = View

  export async function init(input: InitInput) {
    const cwd = process.cwd()
    if (loaded && dir === cwd) return loaded
    dir = cwd
    loaded = load({
      ...input,
      slots: setupSlots(input),
    })
    return loaded
  }

  async function load(input: TuiPluginInput<CliRenderer, JSX.Element>) {
    const dir = process.cwd()

    await Instance.provide({
      directory: dir,
      fn: async () => {
        const config = await TuiConfig.get()
        const plugins = config.plugin ?? []
        const deps: Deps = {}

        try {
          for (const item of INTERNAL_TUI_PLUGINS) {
            log.info("loading internal tui plugin", { name: item.name })
            const entry = prepInternalPlugin(item)
            await applyPlugin(input, entry, createInit(entry.spec, entry.target, undefined, item.name)).catch(
              (error) => {
                log.error("failed to load internal tui plugin", { name: item.name, error })
              },
            )
          }

          const loaded = await Promise.all(plugins.map((item) => prepPlugin(config, item)))

          for (let i = 0; i < plugins.length; i++) {
            let entry = loaded[i]
            if (!entry) {
              const item = plugins[i]
              if (!item) continue
              const spec = Config.pluginSpecifier(item)
              if (!spec.startsWith("file://")) continue
              await waitDeps(deps)
              entry = await prepPlugin(config, item, true)
            }
            if (!entry) continue

            const meta = await PluginMeta.touch(entry.spec, entry.target).catch((error) => {
              log.warn("failed to track tui plugin", { path: entry.spec, retry: entry.retry, error })
              return undefined
            })
            if (meta && meta.state !== "same") {
              log.info("tui plugin metadata updated", {
                path: entry.spec,
                retry: entry.retry,
                state: meta.state,
                source: meta.entry.source,
                version: meta.entry.version,
                modified: meta.entry.modified,
              })
            }

            // Keep plugin execution sequential for deterministic side effects:
            // command registration order affects keybind/command precedence,
            // route registration is last-wins when ids collide,
            // and hook chains rely on stable plugin ordering.
            await applyPlugin(input, entry, createInit(entry.spec, entry.target, meta))
          }
        } finally {
          await PluginMeta.persist().catch((error) => {
            log.warn("failed to persist tui plugin metadata", { error })
          })
        }
      },
    }).catch((error) => {
      log.error("failed to load tui plugins", { directory: dir, error })
    })
  }
}
