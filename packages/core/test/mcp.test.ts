import path from "path"
import { expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { MCP } from "@opencode-ai/core/mcp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { MCPTools } from "@opencode-ai/core/tool/mcp"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { location } from "./fixture/location"
import { executeTool, toolDefinitions } from "./lib/tool"

test("native client owns prompt pagination, lazy get, invalidation, and reconnect", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.acquireRelease(
        Effect.promise(async () => {
          const requests: Record<string, string>[] = []
          const makeProtocol = async () => {
            const protocol = new Server(
              { name: "core-mcp-test", version: "1.0.0" },
              {
                capabilities: {
                  prompts: { listChanged: true },
                  tools: { listChanged: true },
                  resources: { listChanged: true },
                },
                instructions: "Use the native test MCP server.",
              },
            )
            protocol.setRequestHandler(ListPromptsRequestSchema, (request) =>
              Promise.resolve(
                request.params?.cursor === "next"
                  ? { prompts: [{ name: "second" }] }
                  : {
                      prompts: [
                        {
                          name: "first",
                          description: "First prompt",
                          arguments: [{ name: "target", required: true }],
                        },
                      ],
                      nextCursor: "next",
                    },
              ),
            )
            protocol.setRequestHandler(GetPromptRequestSchema, (request) => {
              requests.push(request.params.arguments ?? {})
              return Promise.resolve({
                messages: [
                  { role: "user", content: { type: "text", text: `target=${request.params.arguments?.target}` } },
                  { role: "assistant", content: { type: "image", data: "AA==", mimeType: "image/png" } },
                  { role: "assistant", content: { type: "text", text: "done" } },
                ],
              })
            })
            protocol.setRequestHandler(ListToolsRequestSchema, () =>
              Promise.resolve({
                tools: [
                  {
                    name: "echo.value",
                    description: "Echo a value",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
                    },
                  },
                ],
              }),
            )
            protocol.setRequestHandler(CallToolRequestSchema, (request) =>
              Promise.resolve({
                content: [
                  { type: "text", text: `echo=${request.params.arguments?.value}` },
                  { type: "image", data: "AA==", mimeType: "image/png" },
                ],
              }),
            )
            protocol.setRequestHandler(ListResourcesRequestSchema, () =>
              Promise.resolve({
                resources: [{ name: "Guide", uri: "memory://guide", mimeType: "text/plain" }],
              }),
            )
            protocol.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
              Promise.resolve({
                resourceTemplates: [{ name: "Document", uriTemplate: "memory://document/{id}" }],
              }),
            )
            protocol.setRequestHandler(ReadResourceRequestSchema, (request) =>
              Promise.resolve({
                contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "resource body" }],
              }),
            )
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              enableJsonResponse: true,
            })
            await protocol.connect(transport)
            return { protocol, transport }
          }
          let current = await makeProtocol()
          const oauth = await makeProtocol()
          const http = Bun.serve({
            port: 0,
            fetch: (request) => {
              const url = new URL(request.url)
              if (url.pathname === "/oauth/resource")
                return Response.json({ resource: `${url.origin}/oauth/mcp`, authorization_servers: [url.origin] })
              if (
                url.pathname === "/.well-known/oauth-authorization-server" ||
                url.pathname === "/.well-known/openid-configuration"
              )
                return Response.json({
                  issuer: url.origin,
                  authorization_endpoint: `${url.origin}/oauth/authorize`,
                  token_endpoint: `${url.origin}/oauth/token`,
                  response_types_supported: ["code"],
                  code_challenge_methods_supported: ["S256"],
                  token_endpoint_auth_methods_supported: ["none"],
                })
              if (url.pathname === "/oauth/token")
                return Response.json({ access_token: "oauth-token", token_type: "Bearer" })
              if (url.pathname === "/oauth/mcp" && request.headers.get("authorization") !== "Bearer oauth-token")
                return new Response("Unauthorized", {
                  status: 401,
                  headers: {
                    "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/oauth/resource"`,
                  },
                })
              return (url.pathname === "/oauth/mcp" ? oauth.transport : current.transport).handleRequest(request)
            },
          })
          return {
            requests,
            url: http.url.toString(),
            oauthUrl: new URL("/oauth/mcp", http.url).toString(),
            sendPromptListChanged: () => current.protocol.sendPromptListChanged(),
            restart: async () => {
              await current.protocol.close().catch(() => {})
              current = await makeProtocol()
            },
            close: async () => {
              await current.protocol.close().catch(() => {})
              await oauth.protocol.close().catch(() => {})
              void http.stop(true)
            },
          }
        }),
        (server) => Effect.promise(server.close),
      ).pipe(
        Effect.flatMap((server) => {
          const config = Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Config.Info)({
                    mcp: {
                      timeout: { request: 2_000 },
                      servers: {
                        prompts: { type: "remote", url: server.url, oauth: false },
                        stdio: {
                          type: "local",
                          command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-stdio.ts")],
                          cwd: ".",
                        },
                        disabled: { type: "local", command: ["unused"], disabled: true },
                      },
                    },
                  }),
                }),
                new Config.Document({
                  type: "document",
                  info: Schema.decodeUnknownSync(Config.Info)({ mcp: { timeout: { startup: 2_000 } } }),
                }),
              ]),
          })
          const directory = AbsolutePath.make(import.meta.dir)
          const layer = LayerNode.compile(LayerNode.group([MCP.node, ToolRegistry.node, MCPTools.node]), [
            [Config.node, Layer.succeed(Config.Service, config)],
            [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory })))],
            [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ])

          return Effect.gen(function* () {
            const mcp = yield* MCP.Service
            expect(yield* mcp.status()).toEqual({
              prompts: { status: "connected" },
              stdio: { status: "connected" },
              disabled: { status: "disabled" },
            })
            expect(
              yield* mcp.add("dynamic", { type: "local", command: ["unused"], disabled: true }),
            ).toMatchObject({ dynamic: { status: "disabled" } })
            yield* mcp.auth.remove("dynamic")
            expect(
              yield* mcp.add("oauth", {
                type: "remote",
                url: server.oauthUrl,
                oauth: { client_id: "test-client", redirect_uri: "http://127.0.0.1/callback" },
              }),
            ).toMatchObject({ oauth: { status: "needs_auth" } })
            const authorization = yield* mcp.auth.start("oauth")
            expect(authorization.oauthState).toHaveLength(64)
            expect(new URL(authorization.authorizationUrl).pathname).toBe("/oauth/authorize")
            expect(yield* mcp.auth.finish("oauth", "test-code")).toEqual({ status: "connected" })
            expect((yield* mcp.status()).oauth).toEqual({ status: "connected" })
            yield* mcp.auth.remove("oauth")
            expect(yield* mcp.prompt.list()).toEqual([
              {
                server: "prompts",
                name: "first",
                description: "First prompt",
                arguments: [{ name: "target", required: true }],
              },
              { server: "prompts", name: "second", arguments: [] },
              {
                server: "stdio",
                name: "cwd",
                arguments: [{ name: "suffix" }],
              },
            ])
            expect(server.requests).toEqual([])
            expect(yield* mcp.prompt.get({ server: "prompts", name: "first", arguments: { target: "src" } })).toBe(
              "target=src\ndone",
            )
            expect(server.requests).toEqual([{ target: "src" }])
            expect(yield* mcp.instructions()).toEqual([
              { server: "prompts", text: "Use the native test MCP server.", tools: [] },
            ])
            expect(yield* mcp.tool.list()).toEqual([
              {
                server: "prompts",
                name: "echo.value",
                description: "Echo a value",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
                outputSchema: undefined,
              },
            ])
            expect(yield* mcp.resource.list()).toEqual([
              {
                server: "prompts",
                name: "Guide",
                uri: "memory://guide",
                mimeType: "text/plain",
              },
            ])
            expect(yield* mcp.resource.templates()).toEqual([
              {
                server: "prompts",
                name: "Document",
                uriTemplate: "memory://document/{id}",
              },
            ])

            const registry = yield* ToolRegistry.Service
            const definitions = yield* toolDefinitions(registry)
            expect(definitions.map((definition) => definition.name)).toContain("prompts_echo_value")
            expect(definitions.find((definition) => definition.name === "prompts_echo_value")?.inputSchema).toEqual({
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            })
            const execution = {
              sessionID: SessionV2.ID.make("ses_mcp"),
              agent: AgentV2.ID.make("build"),
              assistantMessageID: SessionMessage.ID.make("msg_mcp"),
            }
            expect(
              yield* executeTool(registry, {
                ...execution,
                call: {
                  type: "tool-call",
                  id: "call-mcp",
                  name: "prompts_echo_value",
                  input: { value: "native" },
                },
              }),
            ).toEqual({
              type: "content",
              value: [
                { type: "text", text: "echo=native" },
                { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" },
              ],
            })
            expect(
              yield* executeTool(registry, {
                ...execution,
                call: {
                  type: "tool-call",
                  id: "call-resource",
                  name: "read_mcp_resource",
                  input: { server: "prompts", uri: "memory://guide" },
                },
              }),
            ).toEqual({ type: "text", value: "resource body" })
            expect(yield* mcp.prompt.get({ server: "stdio", name: "cwd", arguments: { suffix: "child" } })).toBe(
              path.join(import.meta.dir, "child"),
            )

            const changed = yield* mcp.prompt.changes().pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.promise(server.sendPromptListChanged)
            yield* Fiber.join(changed).pipe(Effect.timeout("2 seconds"))

            yield* Effect.promise(server.restart)
            yield* Effect.sleep("50 millis")
            expect((yield* mcp.status()).prompts?.status).toBe("failed")
            yield* mcp.connect("prompts")
            expect((yield* mcp.status()).prompts).toEqual({ status: "connected" })

            yield* mcp.disconnect("prompts")
            expect((yield* mcp.prompt.list()).map((prompt) => prompt.server)).toEqual(["stdio"])
            yield* Effect.promise(server.restart)
            yield* mcp.connect("prompts")
            expect((yield* mcp.status()).prompts).toEqual({ status: "connected" })
            expect((yield* mcp.prompt.list()).map((prompt) => prompt.name)).toEqual(["first", "second", "cwd"])
          }).pipe(Effect.provide(layer))
        }),
      ),
    ),
  ))
