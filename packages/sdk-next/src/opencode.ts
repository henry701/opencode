import { OpenCode } from "@opencode-ai/client/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { ConfigProvider, Context, Effect, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"

export interface Options {
  /**
   * Replaces the ConfigProvider this host's layers read while they are built,
   * for example the OPENCODE_DB database placement. The default provider
   * snapshots the process environment on first use, so per-host configuration
   * must come through this seam rather than env mutation. Compose with
   * ConfigProvider.orElse(ConfigProvider.fromEnv()) to keep environment
   * fallback.
   */
  readonly configProvider?: ConfigProvider.ConfigProvider
}

export const create = Effect.fn("OpenCode.create")(function* (options?: Options) {
  const scope = yield* Scope.Scope
  const memoMap = yield* Layer.makeMemoMap
  const withConfig = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    options?.configProvider === undefined
      ? layer
      : layer.pipe(Layer.provide(ConfigProvider.layer(options.configProvider)))
  const context = yield* Layer.buildWithMemoMap(
    withConfig(AppNodeBuilder.build(LayerNode.group([ApplicationTools.node, PermissionSaved.node]))),
    memoMap,
    scope,
  )
  const tools = Context.get(context, ApplicationTools.Service)
  const permissions = Context.get(context, PermissionSaved.Service)
  const web = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        withConfig(
          createEmbeddedRoutes().pipe(
            HttpRouter.provideRequest(Layer.succeed(PermissionSaved.Service, permissions)),
            Layer.provide(HttpServer.layerServices),
          ),
        ),
        { disableLogger: true, memoMap },
      ),
    ),
    (web) => Effect.promise(web.dispose),
  )
  const fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => web.handler(new Request(input, init)), {
    preconnect: () => undefined,
  }) satisfies typeof globalThis.fetch
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  )
  return {
    ...client,
    tools: { register: tools.register },
  }
})

export type Interface = Effect.Success<ReturnType<typeof create>>

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk-next/OpenCode") {}

export const layer = Layer.effect(Service, create())

export const layerWith = (options: Options) => Layer.effect(Service, create(options))
