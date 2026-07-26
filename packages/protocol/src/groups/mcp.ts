import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { InvalidRequestError } from "../errors"

export const Status = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs_auth") }),
  Schema.Struct({ status: Schema.Literal("needs_client_registration"), error: Schema.String }),
])

const ServerParams = Schema.Struct({ name: Schema.String })
const ResourceQuery = Schema.Struct({ ...LocationQuery.fields, server: Schema.optional(Schema.String) })
const ResourceRead = Schema.Struct({ server: Schema.String, uri: Schema.String })
const Timeout = Schema.Struct({
  startup: Schema.optional(Schema.Number),
  request: Schema.optional(Schema.Number),
})
const OAuth = Schema.Struct({
  client_id: Schema.optional(Schema.String),
  client_secret: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  callback_port: Schema.optional(Schema.Number),
  redirect_uri: Schema.optional(Schema.String),
})
export const Server = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.Array(Schema.String),
    cwd: Schema.optional(Schema.String),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    disabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Timeout),
  }),
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])),
    disabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Timeout),
  }),
])
export const AddPayload = Schema.Struct({ name: Schema.String, server: Server })
export const AuthStart = Schema.Struct({ authorizationUrl: Schema.String, oauthState: Schema.String })
export const AuthCallback = Schema.Struct({ code: Schema.String })

export const MCPGroup = HttpApiGroup.make("server.mcp")
  .add(
    HttpApiEndpoint.get("mcp.status", "/api/mcp", {
      query: LocationQuery,
      success: Location.response(Schema.Record(Schema.String, Status)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.status", summary: "Get MCP server status" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.connect", "/api/mcp/:name/connect", {
      params: ServerParams,
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.connect", summary: "Connect an MCP server" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.add", "/api/mcp", {
      query: LocationQuery,
      payload: AddPayload,
      success: Location.response(Schema.Record(Schema.String, Status)),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.add", summary: "Add an MCP server" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.authStart", "/api/mcp/:name/auth", {
      params: ServerParams,
      query: LocationQuery,
      success: Location.response(AuthStart),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.auth.start", summary: "Start MCP OAuth" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.authCallback", "/api/mcp/:name/auth/callback", {
      params: ServerParams,
      query: LocationQuery,
      payload: AuthCallback,
      success: Location.response(Status),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.auth.callback", summary: "Complete MCP OAuth" })),
  )
  .add(
    HttpApiEndpoint.delete("mcp.authRemove", "/api/mcp/:name/auth", {
      params: ServerParams,
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.auth.remove", summary: "Remove MCP OAuth" })),
  )
  .add(
    HttpApiEndpoint.post("mcp.disconnect", "/api/mcp/:name/disconnect", {
      params: ServerParams,
      query: LocationQuery,
      success: Location.response(Schema.Boolean),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.disconnect", summary: "Disconnect an MCP server" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.resources", "/api/mcp/resource", {
      query: ResourceQuery,
      success: Location.response(Schema.Array(Schema.Unknown)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.resources", summary: "List MCP resources" })),
  )
  .add(
    HttpApiEndpoint.get("mcp.resourceTemplates", "/api/mcp/resource-template", {
      query: ResourceQuery,
      success: Location.response(Schema.Array(Schema.Unknown)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.mcp.resourceTemplates", summary: "List MCP resource templates" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("mcp.resourceRead", "/api/mcp/resource/read", {
      query: LocationQuery,
      payload: ResourceRead,
      success: Location.response(Schema.Unknown),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.mcp.resourceRead", summary: "Read an MCP resource" })),
  )
  .annotateMerge(OpenApi.annotations({ title: "mcp", description: "Model Context Protocol routes." }))
