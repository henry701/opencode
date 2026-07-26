import { MCP } from "@opencode-ai/core/mcp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"

const request = <A>(effect: Effect.Effect<A, Error | MCP.NotFoundError>) =>
  effect.pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequestError({
          message: error instanceof MCP.NotFoundError ? `MCP server not found: ${error.name}` : error.message,
          kind: error instanceof MCP.NotFoundError ? "mcp_server_not_found" : "mcp_request_failed",
        }),
    ),
  )

export const MCPHandler = HttpApiBuilder.group(Api, "server.mcp", (handlers) =>
  handlers
    .handle("mcp.status", () => response(MCP.Service.use((mcp) => mcp.status())))
    .handle("mcp.add", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.add(input.payload.name, input.payload.server)))),
    )
    .handle("mcp.authStart", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.auth.start(input.params.name)))),
    )
    .handle("mcp.authCallback", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.auth.finish(input.params.name, input.payload.code)))),
    )
    .handle("mcp.authRemove", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.auth.remove(input.params.name)).pipe(Effect.as(true)))),
    )
    .handle("mcp.connect", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.connect(input.params.name)).pipe(Effect.as(true)))),
    )
    .handle("mcp.disconnect", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.disconnect(input.params.name)).pipe(Effect.as(true)))),
    )
    .handle("mcp.resources", (input) =>
      response(MCP.Service.use((mcp) => mcp.resource.list(input.query.server))),
    )
    .handle("mcp.resourceTemplates", (input) =>
      response(MCP.Service.use((mcp) => mcp.resource.templates(input.query.server))),
    )
    .handle("mcp.resourceRead", (input) =>
      response(MCP.Service.use((mcp) => request(mcp.resource.read(input.payload)))),
    ),
)
