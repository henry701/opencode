import { Model, Plugin, Provider } from "@opencode/plugin"
import { Option, Schema } from "effect"
import { homedir } from "node:os"
import { join } from "node:path"

const ID = Provider.ID.make("codex-shim")
const NAME = "Codex Shim"
const DEFAULT_BASE_URL = "http://127.0.0.1:8765/v1"
const PACKAGE = "@opencode/ai/providers/openai-compatible-responses"
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

export default Plugin.define({
  id: ID,
  async setup(ctx) {
    const baseURL = endpoint(ctx.options.baseURL)
    const state = { models: (await discover(baseURL)) ?? [], refreshing: false, disposed: false }
    let published = JSON.stringify(state.models)
    await ctx.provider.transform((editor) => {
      if (!state.models.length) return
      editor.add({
        info: {
          id: ID,
          name: NAME,
          activation: "enabled",
          package: PACKAGE,
          settings: { baseURL },
        },
        models: state.models.map((item) => ({
          ...Model.Info.default(ID, Model.ID.make(item.id)),
          name: item.name,
          capabilities: { tools: true, input: item.input, output: ["text"] },
          limit: item.limit,
        })),
      })
    })

    const timer = setInterval(async () => {
      if (state.refreshing) return
      state.refreshing = true
      try {
        const next = await discover(baseURL)
        if (!next || state.disposed) return
        const signature = JSON.stringify(next)
        if (signature === published) return
        state.models = next
        await ctx.provider.reload()
        published = signature
      } catch {
        // Leave the refresh eligible for retry after a transient reload failure.
      } finally {
        state.refreshing = false
      }
    }, 60_000)
    timer.unref()
    return () => {
      state.disposed = true
      clearInterval(timer)
    }
  },
})
