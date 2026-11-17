import type { PluginModule } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin/v2/effect"
import { Effect, Option, Schedule, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

const ID = "codex-shim"
const NAME = "Codex Shim"
const DEFAULT_BASE_URL = "http://127.0.0.1:8765/v1"
const PACKAGE = "@ai-sdk/openai"
const DEFAULT_CONTEXT = 32_768
const DEFAULT_OUTPUT = 8_192

const PickerRows = Schema.Array(Schema.Struct({ slug: Schema.NonEmptyString, display_name: Schema.String }))
const DesktopCatalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      context_window: Schema.optional(Schema.Int),
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
})

type DiscoveredModel = {
  id: string
  name: string
  input: ("text" | "image")[]
  limit: { context: number; output: number }
}

function endpoint(baseURL: unknown) {
  return typeof baseURL === "string" ? baseURL.replace(/\/$/, "") : DEFAULT_BASE_URL
}

async function discover(baseURL: string): Promise<DiscoveredModel[] | undefined> {
  const response = await fetch(new URL("/api/models", baseURL), {
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  }).catch(() => undefined)
  if (!response?.ok) return
  const rows = Option.getOrUndefined(
    Schema.decodeUnknownOption(PickerRows)(await response.json().catch(() => undefined)),
  )
  if (!rows) return
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "custom_model_catalog.json")
  const metadata = Option.getOrUndefined(
    Schema.decodeUnknownOption(DesktopCatalog)(
      await Bun.file(path)
        .json()
        .catch(() => undefined),
    ),
  )
  const bySlug = new Map(metadata?.models.map((model) => [model.slug, model]))
  return rows
    .toSorted((a, b) => a.slug.localeCompare(b.slug))
    .map((row) => {
      const model = bySlug.get(row.slug)
      const context = model?.context_window && model.context_window > 0 ? model.context_window : DEFAULT_CONTEXT
      return {
        id: row.slug,
        name: row.display_name || row.slug,
        input: model?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
        limit: { context, output: Math.min(DEFAULT_OUTPUT, context) },
      }
    })
}

const plugin = {
  id: ID,
  effect: Effect.fn(function* (ctx) {
    const baseURL = endpoint(ctx.options.baseURL)
    let models: DiscoveredModel[] = []
    let signature = JSON.stringify(models)

    yield* ctx.catalog.transform((catalog) => {
      if (!models.length) return
      catalog.provider.update(ID, (provider) => {
        provider.name = NAME
        provider.api = { type: "aisdk", package: PACKAGE, url: baseURL }
      })
      for (const item of models) {
        catalog.model.update(ID, item.id, (model) => {
          model.name = item.name
          model.capabilities = { tools: true, input: item.input, output: ["text"] }
          model.limit = item.limit
        })
      }
    })

    const refresh = Effect.gen(function* () {
      const next = yield* Effect.promise(() => discover(baseURL))
      if (!next) return
      const key = JSON.stringify(next)
      if (key === signature) return
      models = next
      signature = key
      yield* ctx.catalog.reload()
    })
    yield* refresh
    yield* refresh.pipe(Effect.delay("1 minute"), Effect.repeat(Schedule.forever), Effect.forkScoped)
  }),
  async server(_input, options) {
    const baseURL = endpoint(options?.baseURL)
    return {
      async config(config) {
        const models = await discover(baseURL)
        if (!models?.length) return
        config.provider ??= {}
        config.provider[ID] = {
          api: baseURL,
          name: NAME,
          npm: PACKAGE,
          // The legacy OpenAI SDK requires a key even for an unauthenticated local endpoint.
          options: { baseURL, apiKey: "codex-shim-local" },
          models: Object.fromEntries(
            models.map((model) => [
              model.id,
              {
                name: model.name,
                limit: model.limit,
                tool_call: true,
                modalities: { input: model.input, output: ["text"] },
              },
            ]),
          ),
        }
      },
    }
  },
} satisfies Plugin & PluginModule

export default plugin
