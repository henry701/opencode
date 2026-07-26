export * as FeatureFlag from "./feature-flag"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Flag } from "./flag/flag"

export interface Interface {
  readonly codeMode: boolean
  readonly lspTool: boolean
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/FeatureFlag") {}

const layer = Layer.effect(
  Service,
  Effect.sync(() =>
    Service.of({
      codeMode: Flag.OPENCODE_EXPERIMENTAL_CODE_MODE,
      lspTool: Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL,
    }),
  ),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
