export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Config, Context, Effect, Layer } from "effect"
import { Global } from "../global"
import { truthyConfig } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

function resolvePath(input: { readonly file: string | undefined; readonly disableChannelDb: boolean }) {
  if (input.file) {
    if (input.file === ":memory:" || isAbsolute(input.file)) return input.file
    return join(Global.Path.data, input.file)
  }
  if (["latest", "beta", "prod"].includes(InstallationChannel) || input.disableChannelDb)
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

export const path = Effect.gen(function* () {
  const file = yield* Config.string("OPENCODE_DB").pipe(Config.withDefault(undefined))
  const disableChannelDb = yield* truthyConfig("OPENCODE_DISABLE_CHANNEL_DB")
  return resolvePath({ file, disableChannelDb })
}).pipe(Effect.orDie)

const configuredLayer = Layer.unwrap(Effect.map(path, layerFromPath))

export const node = makeGlobalNode({ service: Service, layer: configuredLayer, deps: [] })
