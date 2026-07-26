import { Account } from "@/account/account"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Database } from "@opencode-ai/core/database/database"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { eq } from "drizzle-orm"
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

const disabled = process.env["OPENCODE_DISABLE_SHARE"] === "true" || process.env["OPENCODE_DISABLE_SHARE"] === "1"

export type Data =
  | { type: "session"; data: { id: string } }
  | { type: "message"; data: { id: string } }
  | { type: "part"; data: { id: string; messageID: string } }
  | { type: "session_diff"; data: unknown[] }
  | { type: "model"; data: unknown[] }

export type Api = {
  create: string
  sync: (shareID: string) => string
  remove: (shareID: string) => string
  data: (shareID: string) => string
}

export type Request = {
  headers: Record<string, string>
  api: Api
  baseUrl: string
}

const ShareSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  secret: Schema.String,
})
export type Share = typeof ShareSchema.Type

type State = {
  queue: Map<string, Map<string, Data>>
  scope: Scope.Closeable
  shared: Map<string, Share | null>
}

export interface Interface {
  readonly init: () => Effect.Effect<void, unknown>
  readonly url: () => Effect.Effect<string, unknown>
  readonly request: () => Effect.Effect<Request, unknown>
  readonly sync: (sessionID: string, data: Data[]) => Effect.Effect<void, unknown>
  readonly create: (sessionID: string) => Effect.Effect<Share, unknown>
  readonly remove: (sessionID: string) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareTransport") {}

export const use = serviceUse(Service)

function api(resource: string): Api {
  return {
    create: `/api/${resource}`,
    sync: (shareID) => `/api/${resource}/${shareID}/sync`,
    remove: (shareID) => `/api/${resource}/${shareID}`,
    data: (shareID) => `/api/${resource}/${shareID}/data`,
  }
}

function key(item: Data) {
  switch (item.type) {
    case "session":
      return "session"
    case "message":
      return `message/${item.data.id}`
    case "part":
      return `part/${item.data.messageID}/${item.data.id}`
    case "session_diff":
      return "session_diff"
    case "model":
      return "model"
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const account = yield* Account.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    const state: InstanceState.InstanceState<State> = yield* InstanceState.make<State>(
      Effect.fn("ShareTransport.state")(function* () {
        const cache: State = { queue: new Map(), scope: yield* Scope.make(), shared: new Map() }
        yield* Effect.addFinalizer(() =>
          Scope.close(cache.scope, Exit.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cache.queue.clear()
                cache.shared.clear()
              }),
            ),
          ),
        )
        return cache
      }),
    )

    const request = Effect.fn("ShareTransport.request")(function* () {
      const headers: Record<string, string> = {}
      const active = yield* account.active()
      if (Option.isNone(active) || !active.value.active_org_id) {
        const baseUrl = (yield* cfg.get()).enterprise?.url ?? "https://opncd.ai"
        return { headers, api: api("share"), baseUrl } satisfies Request
      }

      const token = yield* account.token(active.value.id)
      if (Option.isNone(token)) throw new Error("No active account token available for sharing")
      headers.authorization = `Bearer ${token.value}`
      headers["x-org-id"] = active.value.active_org_id
      return { headers, api: api("shares"), baseUrl: active.value.url } satisfies Request
    })

    const get = Effect.fnUntraced(function* (sessionID: string) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return { id: row.id, secret: row.secret, url: row.url } satisfies Share
    })

    const getCached = Effect.fnUntraced(function* (sessionID: string) {
      const cache = yield* InstanceState.get(state)
      if (cache.shared.has(sessionID)) {
        const shared = cache.shared.get(sessionID)
        return shared === null ? undefined : shared
      }
      const shared = yield* get(sessionID)
      cache.shared.set(sessionID, shared ?? null)
      return shared
    })

    const flush = Effect.fn("ShareTransport.flush")(function* (sessionID: string) {
      if (disabled) return
      const cache = yield* InstanceState.get(state)
      const queued = cache.queue.get(sessionID)
      if (!queued) return
      cache.queue.delete(sessionID)

      const shared = yield* getCached(sessionID)
      if (!shared) return
      const req = yield* request()
      const response = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.sync(shared.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: shared.secret, data: Array.from(queued.values()) }),
        Effect.flatMap((request) => http.execute(request)),
      )
      if (response.status < 400) return
      yield* Effect.logWarning("failed to sync share", { sessionID, shareID: shared.id, status: response.status })
    })

    const sync = Effect.fn("ShareTransport.sync")(function* (sessionID: string, data: Data[]) {
      if (disabled) return
      if (!(yield* getCached(sessionID))) return
      const cache = yield* InstanceState.get(state)
      const queued = cache.queue.get(sessionID)
      if (queued) {
        data.forEach((item) => queued.set(key(item), item))
        return
      }

      cache.queue.set(sessionID, new Map(data.map((item) => [key(item), item])))
      yield* flush(sessionID).pipe(
        Effect.delay(1000),
        Effect.catchCause((cause) => Effect.logError("share flush failed", { sessionID, cause })),
        Effect.forkIn(cache.scope),
      )
    })

    const init = Effect.fn("ShareTransport.init")(function* () {
      if (disabled) return
      yield* InstanceState.get(state)
    })

    const url = Effect.fn("ShareTransport.url")(function* () {
      return (yield* request()).baseUrl
    })

    const create = Effect.fn("ShareTransport.create")(function* (sessionID: string) {
      if (disabled) return { id: "", url: "", secret: "" }
      yield* Effect.logInfo("creating share", { sessionID })
      const req = yield* request()
      const result = yield* HttpClientRequest.post(`${req.baseUrl}${req.api.create}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ sessionID }),
        Effect.flatMap((request) => httpOk.execute(request)),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(ShareSchema)),
      )
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: result.secret, url: result.url })
        .onConflictDoUpdate({
          target: SessionShareTable.session_id,
          set: { id: result.id, secret: result.secret, url: result.url },
        })
        .run()
        .pipe(Effect.orDie)
      const cache = yield* InstanceState.get(state)
      cache.shared.set(sessionID, result)
      return result
    })

    const remove = Effect.fn("ShareTransport.remove")(function* (sessionID: string) {
      if (disabled) return
      yield* Effect.logInfo("removing share", { sessionID })
      const cache = yield* InstanceState.get(state)
      const shared = yield* getCached(sessionID)
      if (!shared) {
        cache.shared.delete(sessionID)
        cache.queue.delete(sessionID)
        return
      }
      const req = yield* request()
      yield* HttpClientRequest.delete(`${req.baseUrl}${req.api.remove(shared.id)}`).pipe(
        HttpClientRequest.setHeaders(req.headers),
        HttpClientRequest.bodyJson({ secret: shared.secret }),
        Effect.flatMap((request) => httpOk.execute(request)),
      )
      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
      cache.shared.delete(sessionID)
      cache.queue.delete(sessionID)
    })

    return Service.of({ init, url, request, sync, create, remove })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Account.node, Config.node, Database.node, httpClient],
})

export * as ShareTransport from "./transport"
