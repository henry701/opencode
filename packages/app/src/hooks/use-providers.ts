import { useServerSync } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { Iterable, pipe } from "effect"
import { createEffect, createMemo, createResource, type Accessor } from "solid-js"
import { loadProviderChoices, mergeProviderChoices, selectProviderCatalog } from "./provider-catalog"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

export function useProviders(directory: Accessor<string | undefined>) {
  const serverSync = useServerSync()
  const params = useParams()
  const dir = () => (directory ? directory() : decode64(params.dir))
  const serverSDK = useServerSDK()
  const [choices] = createResource(
    () => ({ server: serverSDK(), directory: dir() }),
    async (input) => ({
      ...input,
      items: await loadProviderChoices(input.server.protocol, () =>
        input.server.api.integration.list(input.directory ? { location: { directory: input.directory } } : undefined),
      ),
    }),
  )
  const providers = () => {
    const value = dir()
    const projectStore = value ? serverSync().child(value)[0] : undefined
    if (value)
      return selectProviderCatalog({
        explicit: true,
        directory: value,
        catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      })
    return selectProviderCatalog({
      explicit: false,
      directory: value,
      catalog: projectStore && { ready: projectStore.provider_ready, providers: projectStore.provider },
      global: serverSync().data.provider,
    })
  }

  const all = createMemo(() => {
    const value = choices.latest
    return mergeProviderChoices(
      providers().all,
      value?.server === serverSDK() && value.directory === dir() ? value.items : [],
    )
  })
  return {
    all,
    default: () => providers().default,
    defaultModel: () => providers().defaultModel,
    popular: () =>
      pipe(
        all(),
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => popularProviderSet.has(p.id)),
        (v) => Array.from(v),
      ),
    connected: () => {
      const connected = new Set(providers().connected)
      return pipe(
        providers().all,
        Iterable.map(([, p]) => p),
        Iterable.filter((p) => connected.has(p.id)),
        (v) => Array.from(v),
      )
    },
    paid: () => {
      const connected = new Set(providers().connected)
      const paid = [
        ...Iterable.filter(
          providers().all,
          ([id]) =>
            connected.has(id) &&
            (id !== "opencode" || Object.values(providers().all.get(id)?.models ?? {}).some((m) => m.cost?.input)),
        ),
      ]
      return paid
    },
  }
}
