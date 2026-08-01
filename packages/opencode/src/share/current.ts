export * as SessionSharingCurrent from "./current"

import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSharing } from "@opencode-ai/core/session/share"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { ShareTransport } from "./transport"

const encodeInfo = Schema.encodeSync(SessionV2.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

function shareMessage(message: SessionMessage.Message) {
  const result = encodeMessage(message)
  if (result.type !== "assistant") return result
  delete (result as { systemPrompt?: string }).systemPrompt
  delete (result as { toolDefinitions?: string }).toolDefinitions
  return result
}

const layer = Layer.effect(
  SessionSharing.Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionV2.Service
    const instances = yield* InstanceStore.Service
    const transport = yield* ShareTransport.Service

    const sync = Effect.fn("SessionSharingCurrent.sync")(function* (sessionID: SessionV2.ID) {
      const info = yield* sessions.get(sessionID)
      const messages = yield* sessions.messages({ sessionID, order: "asc" })
      const instance = (yield* InstanceRef) ?? (yield* instances.load({ directory: info.location.directory }))
      yield* transport
        .sync(sessionID, [
          { type: "session", data: encodeInfo(info) },
          ...messages.map((message) => ({ type: "message" as const, data: shareMessage(message) })),
        ])
        .pipe(Effect.provideService(InstanceRef, instance))
    })

    const unsubscribe = yield* events.listen((event) => {
      if (!event.type.startsWith("session.next.")) return Effect.void
      const sessionID = (event.data as { sessionID?: unknown }).sessionID
      if (typeof sessionID !== "string") return Effect.void
      return sync(SessionV2.ID.make(sessionID)).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("current share subscriber failed", { type: event.type, sessionID, cause }),
        ),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const result = (sessionID: SessionV2.ID) => sessions.get(sessionID).pipe(Effect.orDie)
    const updateShare = (sessionID: SessionV2.ID, url: string | null) =>
      db
        .update(SessionTable)
        .set({ share_url: url, time_updated: Date.now() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)

    return SessionSharing.Service.of({
      share: (sessionID) =>
        Effect.gen(function* () {
          if ((yield* cfg.get()).share === "disabled") {
            return yield* new SessionSharing.UnavailableError({ operation: "share" })
          }
          const shared = yield* transport.create(sessionID)
          yield* updateShare(sessionID, shared.url)
          yield* sync(sessionID)
          return yield* result(sessionID)
        }).pipe(
          Effect.mapError(() => new SessionSharing.UnavailableError({ operation: "share" })),
          Effect.catchDefect(() => new SessionSharing.UnavailableError({ operation: "share" })),
        ),
      unshare: (sessionID) =>
        transport.remove(sessionID).pipe(
          Effect.andThen(updateShare(sessionID, null)),
          Effect.andThen(result(sessionID)),
          Effect.mapError(() => new SessionSharing.UnavailableError({ operation: "unshare" })),
          Effect.catchDefect(() => new SessionSharing.UnavailableError({ operation: "unshare" })),
        ),
    })
  }),
)

export const node = LayerNode.make({
  service: SessionSharing.Service,
  layer,
  deps: [Config.node, Database.node, EventV2.node, ShareTransport.node, SessionV2.node, InstanceStore.node],
})
