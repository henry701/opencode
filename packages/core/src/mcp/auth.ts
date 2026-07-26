import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { EffectFlock } from "../util/effect-flock"

export const Tokens = Schema.Struct({
  accessToken: Schema.mutableKey(Schema.String),
  refreshToken: Schema.mutableKey(Schema.optional(Schema.String)),
  expiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  scope: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Tokens = typeof Tokens.Type

export const ClientInfo = Schema.Struct({
  clientId: Schema.mutableKey(Schema.String),
  clientSecret: Schema.mutableKey(Schema.optional(Schema.String)),
  clientIdIssuedAt: Schema.mutableKey(Schema.optional(Schema.Number)),
  clientSecretExpiresAt: Schema.mutableKey(Schema.optional(Schema.Number)),
})
export type ClientInfo = typeof ClientInfo.Type

export const Entry = Schema.Struct({
  tokens: Schema.mutableKey(Schema.optional(Tokens)),
  clientInfo: Schema.mutableKey(Schema.optional(ClientInfo)),
  codeVerifier: Schema.mutableKey(Schema.optional(Schema.String)),
  oauthState: Schema.mutableKey(Schema.optional(Schema.String)),
  serverUrl: Schema.mutableKey(Schema.optional(Schema.String)),
})
export type Entry = typeof Entry.Type

type Data = Record<string, Entry>
const decode = Schema.decodeUnknownOption(Schema.Record(Schema.String, Entry))

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Entry | undefined>
  readonly getForUrl: (name: string, url: string) => Effect.Effect<Entry | undefined>
  readonly set: (name: string, entry: Entry, url?: string) => Effect.Effect<void>
  readonly remove: (name: string) => Effect.Effect<void>
  readonly updateTokens: (name: string, tokens: Tokens, url?: string) => Effect.Effect<void>
  readonly updateClientInfo: (name: string, info: ClientInfo, url?: string) => Effect.Effect<void>
  readonly updateCodeVerifier: (name: string, verifier: string) => Effect.Effect<void>
  readonly clearCodeVerifier: (name: string) => Effect.Effect<void>
  readonly updateOAuthState: (name: string, state: string) => Effect.Effect<void>
  readonly clearOAuthState: (name: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MCP/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const locks = yield* EffectFlock.Service
    const file = path.join(global.data, "mcp-auth.json")
    const key = `mcp-auth:${file}`

    const read = Effect.fnUntraced(function* () {
      return yield* fs.readJson(file).pipe(
        Effect.map((value): Data => Option.getOrElse(decode(value), () => ({}))),
        Effect.catch(() => Effect.succeed({} as Data)),
      )
    })
    const all = () => read().pipe(locks.withLock(key), Effect.orDie)
    const mutate = (update: (data: Data) => Data | undefined) =>
      Effect.gen(function* () {
        const next = update(yield* read())
        if (next) yield* fs.writeJson(file, next, 0o600).pipe(Effect.orDie)
      }).pipe(locks.withLock(key), Effect.orDie)
    const get = Effect.fn("MCP.Auth.get")(function* (name: string) {
      return (yield* all())[name]
    })
    const getForUrl = Effect.fn("MCP.Auth.getForUrl")(function* (name: string, url: string) {
      const entry = yield* get(name)
      return entry?.serverUrl === url ? entry : undefined
    })
    const set = Effect.fn("MCP.Auth.set")(function* (name: string, entry: Entry, url?: string) {
      yield* mutate((data) => ({ ...data, [name]: url ? { ...entry, serverUrl: url } : entry }))
    })
    const remove = Effect.fn("MCP.Auth.remove")(function* (name: string) {
      yield* mutate((data) => {
        const next = { ...data }
        delete next[name]
        return next
      })
    })
    const update = <K extends keyof Entry>(field: K, span: string) =>
      Effect.fn(`MCP.Auth.${span}`)(function* (name: string, value: NonNullable<Entry[K]>, url?: string) {
        yield* mutate((data) => ({
          ...data,
          [name]: { ...data[name], [field]: value, ...(url ? { serverUrl: url } : {}) },
        }))
      })
    const clear = (field: keyof Entry, span: string) =>
      Effect.fn(`MCP.Auth.${span}`)(function* (name: string) {
        yield* mutate((data) => {
          if (!data[name]) return
          const entry = { ...data[name] }
          delete entry[field]
          return { ...data, [name]: entry }
        })
      })

    return Service.of({
      get,
      getForUrl,
      set,
      remove,
      updateTokens: update("tokens", "updateTokens"),
      updateClientInfo: update("clientInfo", "updateClientInfo"),
      updateCodeVerifier: update("codeVerifier", "updateCodeVerifier"),
      clearCodeVerifier: clear("codeVerifier", "clearCodeVerifier"),
      updateOAuthState: update("oauthState", "updateOAuthState"),
      clearOAuthState: clear("oauthState", "clearOAuthState"),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node, EffectFlock.node] })
