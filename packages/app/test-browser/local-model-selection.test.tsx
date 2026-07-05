import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createContext, createSignal, useContext, type ParentProps } from "solid-js"
import { createComponent, render } from "solid-js/web"
import type { Component } from "solid-js"
import { ServerScope } from "@/utils/server-scope"
import { PersistTesting } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"

let Local: typeof import("@/context/local")
let params: { id?: string }
const [catalogEmpty, setCatalogEmpty] = createSignal(false)
const [selectedDisconnected, setSelectedDisconnected] = createSignal(false)
const [selectedModelUnavailable, setSelectedModelUnavailable] = createSignal(false)

const bigPickle = {
  id: "big-pickle",
  name: "Big Pickle",
  provider: { id: "opencode", name: "OpenCode" },
}
const selectedModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: { id: "anthropic", name: "Anthropic" },
}
const sameProviderSelectedModel = {
  id: "deepseek-v4-flash-free",
  name: "DeepSeek V4 Flash Free",
  provider: { id: "opencode", name: "OpenCode" },
}

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useParams: () => params,
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: (input: { name: string; init: (props: Record<string, unknown>) => unknown }) => {
      const context = createContext<unknown>()
      return {
        provider: (props: ParentProps<Record<string, unknown>>) =>
          createComponent(context.Provider, {
            value: input.init(props),
            get children() {
              return props.children
            },
          }),
        use: () => {
          const value = useContext(context)
          if (!value) throw new Error(`${input.name} context must be used within a context provider`)
          return value
        },
      }
    },
  }))
  mock.module("@/context/sdk", () => ({
    useSDK: () => () => ({ directory: "/repo", scope: ServerScope.local }),
  }))
  mock.module("@/context/server-sdk", () => ({
    useServerSDK: () => () => ({ scope: ServerScope.local }),
  }))
  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: {
        agent: [{ name: "build", mode: "primary", model: { providerID: "opencode", modelID: "big-pickle" } }],
        config: {},
      },
    }),
  }))
  mock.module("@/hooks/use-providers", () => ({
    useProviders: () => ({
      all: () =>
        catalogEmpty()
          ? new Map()
          : new Map([
              [
                "opencode",
                {
                  id: "opencode",
                  name: "OpenCode",
                  models: selectedModelUnavailable()
                    ? { "big-pickle": { id: "big-pickle" } }
                    : {
                        "big-pickle": { id: "big-pickle" },
                        "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" },
                      },
                },
              ],
              [
                "anthropic",
                { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4": { id: "claude-sonnet-4" } } },
              ],
            ]),
      connected: () =>
        catalogEmpty()
          ? []
          : selectedDisconnected()
            ? [
                {
                  id: "opencode",
                  name: "OpenCode",
                  models: {
                    "big-pickle": { id: "big-pickle" },
                    "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" },
                  },
                },
              ]
            : [
                {
                  id: "opencode",
                  name: "OpenCode",
                  models: selectedModelUnavailable()
                    ? { "big-pickle": { id: "big-pickle" } }
                    : {
                        "big-pickle": { id: "big-pickle" },
                        "deepseek-v4-flash-free": { id: "deepseek-v4-flash-free" },
                      },
                },
                { id: "anthropic", name: "Anthropic", models: { "claude-sonnet-4": { id: "claude-sonnet-4" } } },
              ],
      default: () => ({ opencode: "big-pickle" }),
    }),
  }))
  mock.module("@/context/models", () => ({
    useModels: () => ({
      ready: () => true,
      list: () => [bigPickle, selectedModel, sameProviderSelectedModel],
      find: (key: { providerID: string; modelID: string }) =>
        selectedModelUnavailable() && key.providerID === "opencode" && key.modelID === "deepseek-v4-flash-free"
          ? undefined
          : [bigPickle, selectedModel, sameProviderSelectedModel].find(
              (item) => item.provider.id === key.providerID && item.id === key.modelID,
            ),
      visible: () => true,
      setVisibility: () => undefined,
      recent: {
        list: () => [],
        push: () => undefined,
      },
      variant: {
        get: () => undefined,
        set: () => undefined,
      },
    }),
  }))
  mock.module("@/context/platform", () => ({
    usePlatform: () => ({ platform: "browser" }),
  }))

  Local = await import("@/context/local")
})

beforeEach(() => {
  params = { id: "session-1" }
  localStorage.clear()
  setCatalogEmpty(false)
  setSelectedDisconnected(false)
  setSelectedModelUnavailable(false)
})

describe("local model selection", () => {
  test("makes explicit model selection visible synchronously before submit reads the current model", () => {
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      seen.push(local.model.current()?.id ?? "none")
      local.model.set({ providerID: "anthropic", modelID: "claude-sonnet-4" }, { recent: true })
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["big-pickle", "claude-sonnet-4"])
  })

  test("lets session history repair stale defaults without clobbering explicit picker changes", () => {
    params = { id: "session-2" }
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      seen.push(local.model.current()?.id ?? "none")
      local.session.restore({
        sessionID: "session-2",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      })
      seen.push(local.model.current()?.id ?? "none")
      local.model.set({ providerID: "opencode", modelID: "big-pickle" }, { recent: true })
      seen.push(local.model.current()?.id ?? "none")
      local.session.restore({
        sessionID: "session-2",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      })
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["big-pickle", "claude-sonnet-4", "big-pickle", "big-pickle"])
  })

  test("keeps the explicit model while the provider catalog transiently empties", () => {
    params = { id: "session-3" }
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      local.model.set({ providerID: "anthropic", modelID: "claude-sonnet-4" }, { recent: true })
      seen.push(local.model.current()?.id ?? "none")
      // Simulate a scoped provider refetch clearing the catalog mid-flight.
      setCatalogEmpty(true)
      seen.push(local.model.current()?.id ?? "none")
      // Catalog settles again with the same providers.
      setCatalogEmpty(false)
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["claude-sonnet-4", "claude-sonnet-4", "claude-sonnet-4"])
  })

  test("keeps the explicit model while its provider transiently disconnects", () => {
    params = { id: "session-4" }
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      local.model.set({ providerID: "anthropic", modelID: "claude-sonnet-4" }, { recent: true })
      seen.push(local.model.current()?.id ?? "none")
      // Simulate provider auth/config refresh briefly removing only the
      // selected provider from connected providers while the default remains.
      setSelectedDisconnected(true)
      seen.push(local.model.current()?.id ?? "none")
      setSelectedDisconnected(false)
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["claude-sonnet-4", "claude-sonnet-4", "claude-sonnet-4"])
  })

  test("keeps the explicit model while its provider transiently omits that model", () => {
    params = { id: "session-5" }
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      local.model.set({ providerID: "opencode", modelID: "deepseek-v4-flash-free" }, { recent: true })
      seen.push(local.model.current()?.id ?? "none")
      // This mirrors the Sisyphus/Big Pickle setup: the selected model and the
      // configured default share a provider, and a provider refresh briefly
      // exposes only the default model.
      setSelectedModelUnavailable(true)
      seen.push(local.model.current()?.id ?? "none")
      setSelectedModelUnavailable(false)
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["deepseek-v4-flash-free", "deepseek-v4-flash-free", "deepseek-v4-flash-free"])
  })

  test("does not fall back to the agent default when promoting a submitted user model during a provider refresh", () => {
    params = {}
    setSelectedModelUnavailable(true)
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      local.session.promote("/repo", "session-6", {
        agent: "build",
        model: {
          providerID: "opencode",
          modelID: "deepseek-v4-flash-free",
          name: "DeepSeek V4 Flash Free",
          providerName: "OpenCode",
        },
        source: "user",
      })
      seen.push(local.model.current()?.id ?? "none")
      setSelectedModelUnavailable(false)
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["deepseek-v4-flash-free", "deepseek-v4-flash-free"])
  })

  test("normalizes persisted session models that use the backend session model shape", () => {
    params = { id: "session-backend-shape" }
    const storage = PersistTesting.workspaceStorage(pathKey("/repo"))
    localStorage.setItem(
      `${storage}:workspace:model-selection`,
      JSON.stringify({
        session: {
          "session-backend-shape": {
            agent: "build",
            model: { providerID: "opencode", id: "deepseek-v4-flash-free", variant: "high" },
            variant: null,
            source: "user",
          },
        },
      }),
    )
    const host = document.createElement("div")
    const seen: string[] = []

    const Probe: Component = () => {
      const local = Local.useLocal()
      seen.push(local.model.current()?.id ?? "none")
      return null
    }

    const dispose = render(
      () =>
        createComponent(Local.LocalProvider, {
          get children() {
            return createComponent(Probe, {})
          },
        }),
      host,
    )
    dispose()

    expect(seen).toEqual(["deepseek-v4-flash-free"])
  })
})
