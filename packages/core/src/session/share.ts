export * as SessionSharing from "./share"

import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "../effect/layer-node"
import { SessionSchema } from "./schema"

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()(
  "SessionSharing.UnavailableError",
  { operation: Schema.Literals(["share", "unshare"]) },
) {}

export interface Interface {
  readonly share: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, UnavailableError>
  readonly unshare: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSharing") {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    share: () => new UnavailableError({ operation: "share" }),
    unshare: () => new UnavailableError({ operation: "unshare" }),
  }),
)

export const node = LayerNode.make({ service: Service, layer: unavailableLayer, deps: [] })
