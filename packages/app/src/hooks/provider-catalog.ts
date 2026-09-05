import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

const emptyProviderCatalog: NormalizedProviderListResponse = { all: new Map(), connected: [], default: {} }

type ProviderChoice = { id: string; name: string }

export async function loadProviderChoices(
  protocol: Promise<"v1" | "v2">,
  list: () => Promise<{ data?: readonly ProviderChoice[] }>,
) {
  if ((await protocol) === "v1") return []
  return list()
    .then((result) => (Array.isArray(result.data) ? result.data : []))
    .catch(() => [])
}

export function mergeProviderChoices(
  providers: NormalizedProviderListResponse["all"],
  choices: readonly ProviderChoice[],
) {
  if (!choices.length) return providers
  const all = new Map(providers)
  for (const choice of choices) {
    if (all.has(choice.id)) continue
    all.set(choice.id, { ...choice, source: "custom", env: [], options: {}, models: {} })
  }
  return all
}

type DirectoryCatalog = {
  ready: boolean
  providers: NormalizedProviderListResponse
}

type ProviderCatalogInput =
  | {
      explicit: true
      directory?: string
      catalog?: DirectoryCatalog
    }
  | {
      explicit: false
      directory?: string
      catalog?: DirectoryCatalog
      global: NormalizedProviderListResponse
    }

export function selectProviderCatalog(input: ProviderCatalogInput) {
  if (input.directory && input.catalog?.ready) return input.catalog.providers
  if (input.explicit) return emptyProviderCatalog
  return input.global
}

export function resolveDefaultModel(
  current: NormalizedProviderListResponse["defaultModel"],
  legacy: string | undefined,
) {
  if (current !== undefined) return current ?? undefined
  if (!legacy) return undefined
  const [providerID, modelID] = legacy.split("/")
  return { providerID, modelID }
}
