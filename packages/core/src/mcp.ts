export * as MCP from "./mcp"

import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  CallToolResultSchema,
  ListRootsRequestSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type ReadResourceResult,
  type Resource as MCPResource,
  type ResourceTemplate as MCPResourceTemplate,
  type Tool as MCPTool,
} from "@modelcontextprotocol/sdk/types.js"
import { Cause, Context, Effect, Exit, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Config } from "./config"
import { ConfigMCP } from "./config/mcp"
import { makeLocationNode } from "./effect/app-node"
import { InstallationVersion } from "./installation/version"
import { Location } from "./location"
import { MCPAuth } from "./mcp/oauth"
import { PendingProvider, Provider } from "./mcp/oauth-provider"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000
const CLIENT_OPTIONS = {
  capabilities: {
    roots: {},
  },
} satisfies ClientOptions

export interface Prompt {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly arguments: readonly {
    readonly name: string
    readonly description?: string
    readonly required?: boolean
  }[]
}

export interface Tool {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly inputSchema: MCPTool["inputSchema"]
  readonly outputSchema?: MCPTool["outputSchema"]
}

export interface Resource extends MCPResource {
  readonly server: string
}

export interface ResourceTemplate extends MCPResourceTemplate {
  readonly server: string
}

export interface Instructions {
  readonly server: string
  readonly text: string
  readonly tools: readonly string[]
}

export const Status = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs_auth") }),
  Schema.Struct({ status: Schema.Literal("needs_client_registration"), error: Schema.String }),
])
export type Status = typeof Status.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("MCP.NotFoundError", {
  name: Schema.String,
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly add: (name: string, server: ConfigMCP.Local | ConfigMCP.Remote) => Effect.Effect<Record<string, Status>>
  readonly connect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly disconnect: (name: string) => Effect.Effect<void, NotFoundError>
  readonly auth: {
    readonly start: (
      name: string,
    ) => Effect.Effect<{ readonly authorizationUrl: string; readonly oauthState: string }, NotFoundError | Error>
    readonly finish: (name: string, code: string) => Effect.Effect<Status, NotFoundError | Error>
    readonly remove: (name: string) => Effect.Effect<void, NotFoundError>
  }
  readonly instructions: () => Effect.Effect<Instructions[]>
  readonly tool: {
    readonly list: () => Effect.Effect<Tool[]>
    readonly call: (input: {
      readonly server: string
      readonly name: string
      readonly arguments: Record<string, unknown>
      readonly signal?: AbortSignal
    }) => Effect.Effect<CallToolResult, NotFoundError | Error>
    readonly changes: () => Stream.Stream<void>
  }
  readonly prompt: {
    readonly list: () => Effect.Effect<Prompt[]>
    readonly get: (input: {
      readonly server: string
      readonly name: string
      readonly arguments: Record<string, string>
    }) => Effect.Effect<string | undefined>
    readonly changes: () => Stream.Stream<void>
  }
  readonly resource: {
    readonly available: () => Effect.Effect<boolean>
    readonly list: (server?: string) => Effect.Effect<Resource[]>
    readonly templates: (server?: string) => Effect.Effect<ResourceTemplate[]>
    readonly read: (input: {
      readonly server: string
      readonly uri: string
    }) => Effect.Effect<ReadResourceResult, NotFoundError | Error>
    readonly changes: () => Stream.Stream<void>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MCP") {}

type Server = ConfigMCP.Local | ConfigMCP.Remote
type Connected = {
  readonly client: Client
  readonly timeout: number
}
type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* MCPAuth.Service
    const location = yield* Location.Service
    const changes = yield* PubSub.sliding<void>(1)
    const resolved = effective(yield* config.entries())
    const clients = new Map<string, Connected>()
    const statuses = new Map<string, Status>()
    const pending = new Map<
      string,
      { readonly transport: StreamableHTTPClientTransport; readonly provider: PendingProvider; readonly client: Client }
    >()
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const runPromise = Effect.runPromiseWith(context)

    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid)

    const close = Effect.fnUntraced(function* (name: string) {
      const connected = clients.get(name)
      if (!connected) return
      clients.delete(name)
      yield* Effect.tryPromise(() => connected.client.close()).pipe(Effect.ignore)
    })

    const createClient = (server: string) => {
      const client = new Client({ name: "opencode", version: InstallationVersion }, CLIENT_OPTIONS)
      client.setRequestHandler(ListRootsRequestSchema, () =>
        Promise.resolve({ roots: [{ uri: pathToFileURL(location.directory).href }] }),
      )
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => runPromise(notify).then(() => undefined))
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => runPromise(notify).then(() => undefined))
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
        runPromise(notify).then(() => undefined),
      )
      client.onerror = (error) => {
        if (clients.get(server)?.client !== client) return
        runFork(
          close(server).pipe(
            Effect.andThen(
              Effect.sync(() => {
                statuses.set(server, { status: "failed", error: error.message })
              }),
            ),
            Effect.andThen(notify),
            Effect.andThen(Effect.logWarning("MCP client error", { server, error: error.message })),
          ),
        )
      }
      client.onclose = () => {
        if (clients.get(server)?.client !== client) return
        runFork(
          close(server).pipe(
            Effect.andThen(
              Effect.sync(() => {
                statuses.set(server, { status: "failed", error: "Connection closed" })
              }),
            ),
            Effect.andThen(notify),
          ),
        )
      }
      return client
    }

    const connectTransport = Effect.fnUntraced(function* (name: string, transport: Transport, timeout: number) {
      return yield* Effect.acquireUseRelease(
        Effect.succeed(transport),
        (value) =>
          Effect.tryPromise({
            try: async () => {
              const client = createClient(name)
              await client.connect(value, { timeout })
              return client
            },
            catch: asError,
          }),
        (value, exit) =>
          Exit.isFailure(exit) ? Effect.tryPromise(() => value.close()).pipe(Effect.ignore) : Effect.void,
      )
    })

    const connectServer = Effect.fnUntraced(function* (name: string, server: Server) {
      yield* close(name)
      if (server.disabled) {
        statuses.set(name, { status: "disabled" })
        yield* notify
        return
      }

      const startup = server.timeout?.startup ?? resolved.timeout.startup ?? DEFAULT_TIMEOUT
      const request = server.timeout?.request ?? resolved.timeout.request ?? DEFAULT_TIMEOUT
      const result =
        server.type === "local"
          ? yield* connectLocal(name, server, location, startup, connectTransport).pipe(Effect.exit)
          : yield* connectRemote(
              name,
              server,
              startup,
              connectTransport,
              server.oauth === false
                ? undefined
                : new Provider(
                    name,
                    server.url,
                    {
                      clientId: server.oauth?.client_id,
                      clientSecret: server.oauth?.client_secret,
                      scope: server.oauth?.scope,
                      callbackPort: server.oauth?.callback_port,
                      redirectUri: server.oauth?.redirect_uri,
                    },
                    () => {},
                    auth,
                  ),
            ).pipe(Effect.exit)

      if (result._tag === "Failure") {
        const error = result.cause.toString()
        const needsAuth = /unauthorized|oauth|401/i.test(error)
        statuses.set(name, needsAuth ? { status: "needs_auth" } : { status: "failed", error })
        yield* Effect.logWarning("failed to connect MCP server", { name, error })
        yield* notify
        return
      }

      clients.set(name, { client: result.value, timeout: request })
      statuses.set(name, { status: "connected" })
      yield* notify
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const server = resolved.servers.get(name)
      if (!server) return yield* new NotFoundError({ name })
      return yield* connectServer(name, server)
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      if (!resolved.servers.has(name)) return yield* new NotFoundError({ name })
      yield* close(name)
      statuses.set(name, { status: "disabled" })
      return yield* notify
    })

    const add = Effect.fn("MCP.add")(function* (name: string, server: Server) {
      resolved.servers.set(name, server)
      yield* connectServer(name, server)
      return Object.fromEntries(statuses)
    })

    const requireRemote = Effect.fnUntraced(function* (name: string) {
      const server = resolved.servers.get(name)
      if (!server) return yield* new NotFoundError({ name })
      if (server.type !== "remote") return yield* Effect.fail(new Error(`MCP server ${name} is not remote`))
      if (server.oauth === false) return yield* Effect.fail(new Error(`MCP server ${name} has OAuth disabled`))
      if (!URL.canParse(server.url)) return yield* Effect.fail(new Error(`Invalid MCP URL for "${name}"`))
      return server
    })

    const startAuth = Effect.fn("MCP.auth.start")(function* (name: string) {
      const server = yield* requireRemote(name)
      const oauth = server.oauth || undefined
      const oauthState = crypto.getRandomValues(new Uint8Array(32)).toHex()
      yield* auth.updateOAuthState(name, oauthState)
      let authorizationUrl: URL | undefined
      const provider = new PendingProvider(
        name,
        server.url,
        {
          clientId: oauth?.client_id,
          clientSecret: oauth?.client_secret,
          scope: oauth?.scope,
          callbackPort: oauth?.callback_port,
          redirectUri: oauth?.redirect_uri,
        },
        (url) => {
          authorizationUrl = url
        },
        auth,
      )
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        authProvider: provider,
        requestInit: server.headers ? { headers: server.headers } : undefined,
      })
      const client = createClient(name)
      const result = yield* Effect.tryPromise({
        try: () => client.connect(transport, { timeout: server.timeout?.startup ?? resolved.timeout.startup ?? DEFAULT_TIMEOUT }),
        catch: asError,
      }).pipe(Effect.exit)
      if (result._tag === "Success") {
        yield* Effect.tryPromise(() => provider.commit())
        clients.set(name, { client, timeout: server.timeout?.request ?? resolved.timeout.request ?? DEFAULT_TIMEOUT })
        statuses.set(name, { status: "connected" })
        yield* auth.clearOAuthState(name)
        yield* notify
        return { authorizationUrl: "", oauthState }
      }
      const failure = Option.getOrElse(Cause.findErrorOption(result.cause), () => asError(result.cause))
      if (!authorizationUrl || !(failure instanceof UnauthorizedError)) {
        yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
        return yield* Effect.fail(asError(failure))
      }
      const previous = pending.get(name)
      if (previous) yield* Effect.tryPromise(() => previous.client.close()).pipe(Effect.ignore)
      pending.set(name, { transport, provider, client })
      statuses.set(name, { status: "needs_auth" })
      yield* notify
      return { authorizationUrl: authorizationUrl.toString(), oauthState }
    })

    const finishAuth = Effect.fn("MCP.auth.finish")(function* (name: string, code: string) {
      yield* requireRemote(name)
      const flow = pending.get(name)
      if (!flow) return yield* Effect.fail(new Error(`No pending OAuth flow for MCP server: ${name}`))
      yield* Effect.tryPromise({ try: () => flow.transport.finishAuth(code), catch: asError })
      yield* Effect.tryPromise(() => flow.provider.commit())
      yield* auth.clearCodeVerifier(name)
      yield* auth.clearOAuthState(name)
      pending.delete(name)
      yield* Effect.tryPromise(() => flow.client.close()).pipe(Effect.ignore)
      yield* connect(name)
      return statuses.get(name) ?? ({ status: "failed", error: "MCP connection did not report status" } satisfies Status)
    })

    const removeAuth = Effect.fn("MCP.auth.remove")(function* (name: string) {
      if (!resolved.servers.has(name)) return yield* new NotFoundError({ name })
      yield* auth.remove(name)
      const flow = pending.get(name)
      pending.delete(name)
      if (flow) yield* Effect.tryPromise(() => flow.client.close()).pipe(Effect.ignore)
    })

    const service = Service.of({
      status: Effect.fn("MCP.status")(function* () {
        return Object.fromEntries(statuses)
      }),
      add,
      connect,
      disconnect,
      auth: { start: startAuth, finish: finishAuth, remove: removeAuth },
      instructions: Effect.fn("MCP.instructions")(function* () {
        return Array.from(clients)
          .flatMap(([server, connected]) => {
            const text = connected.client.getInstructions()
            if (!text) return []
            return [
              {
                server,
                text,
                tools: [],
              },
            ]
          })
          .toSorted((left, right) => left.server.localeCompare(right.server))
      }),
      tool: {
        changes: () => Stream.fromPubSub(changes),
        list: Effect.fn("MCP.tool.list")(function* () {
          return (yield* Effect.forEach(
            Array.from(clients).toSorted(([left], [right]) => left.localeCompare(right)),
            ([server, connected]) =>
              Effect.tryPromise({
                try: () => listTools(connected.client, connected.timeout),
                catch: asError,
              }).pipe(
                Effect.map((items) =>
                  items.map((item) => ({
                    server,
                    name: item.name,
                    description: item.description,
                    inputSchema: item.inputSchema,
                    outputSchema: item.outputSchema,
                  })),
                ),
                Effect.tapError((error) =>
                  Effect.logWarning("failed to list MCP tools", { server, error: error.message }),
                ),
                Effect.orElseSucceed(() => [] as Tool[]),
              ),
            { concurrency: "unbounded" },
          )).flat()
        }),
        call: Effect.fn("MCP.tool.call")(function* (input) {
          const connected = clients.get(input.server)
          if (!connected) return yield* new NotFoundError({ name: input.server })
          return yield* Effect.tryPromise({
            try: () =>
              connected.client.callTool({ name: input.name, arguments: input.arguments }, CallToolResultSchema, {
                timeout: connected.timeout,
                resetTimeoutOnProgress: true,
                signal: input.signal,
                onprogress: () => {},
              }),
            catch: asError,
          }).pipe(
            Effect.flatMap((result) =>
              result.isError
                ? Effect.fail(
                    new Error(
                      result.content
                        .flatMap((item) => (item.type === "text" ? [item.text] : []))
                        .filter((text) => text.trim())
                        .join("\n\n") || "MCP tool returned an error",
                    ),
                  )
                : Effect.succeed(result),
            ),
          )
        }),
      },
      prompt: {
        changes: () => Stream.fromPubSub(changes),
        list: Effect.fn("MCP.prompt.list")(function* () {
          return (yield* Effect.forEach(
            Array.from(clients).toSorted(([left], [right]) => left.localeCompare(right)),
            ([server, connected]) =>
              Effect.tryPromise({
                try: () => prompts(connected.client, connected.timeout),
                catch: asError,
              }).pipe(
                Effect.map((items) =>
                  items.map((item) => ({
                    server,
                    name: item.name,
                    description: item.description,
                    arguments: item.arguments ?? [],
                  })),
                ),
                Effect.tapError((error) =>
                  Effect.logWarning("failed to list MCP prompts", { server, error: error.message }),
                ),
                Effect.orElseSucceed(() => [] as Prompt[]),
              ),
            { concurrency: "unbounded" },
          )).flat()
        }),
        get: Effect.fn("MCP.prompt.get")(function* (input) {
          const connected = clients.get(input.server)
          if (!connected) return undefined
          return yield* Effect.tryPromise({
            try: () =>
              connected.client.getPrompt(
                {
                  name: input.name,
                  arguments: input.arguments,
                },
                { timeout: connected.timeout },
              ),
            catch: asError,
          }).pipe(
            Effect.map((result) =>
              result.messages
                .flatMap((message) => (message.content.type === "text" ? [message.content.text] : []))
                .join("\n"),
            ),
            Effect.tapError((error) =>
              Effect.logWarning("failed to get MCP prompt", {
                server: input.server,
                prompt: input.name,
                error: error.message,
              }),
            ),
            Effect.orElseSucceed(() => undefined),
          )
        }),
      },
      resource: {
        available: Effect.fn("MCP.resource.available")(function* () {
          return Array.from(clients.values()).some((connected) =>
            Boolean(connected.client.getServerCapabilities()?.resources),
          )
        }),
        changes: () => Stream.fromPubSub(changes),
        list: Effect.fn("MCP.resource.list")(function* (server?: string) {
          return yield* collect(clients, server, "resources", (connected) =>
            listResources(connected.client, connected.timeout),
          )
        }),
        templates: Effect.fn("MCP.resource.templates")(function* (server?: string) {
          return yield* collect(clients, server, "resource templates", (connected) =>
            listResourceTemplates(connected.client, connected.timeout),
          )
        }),
        read: Effect.fn("MCP.resource.read")(function* (input) {
          const connected = clients.get(input.server)
          if (!connected) return yield* new NotFoundError({ name: input.server })
          return yield* Effect.tryPromise({
            try: () => connected.client.readResource({ uri: input.uri }, { timeout: connected.timeout }),
            catch: asError,
          })
        }),
      },
    })

    yield* Effect.forEach(resolved.servers, ([name, server]) => connectServer(name, server), {
      concurrency: "unbounded",
      discard: true,
    })
    yield* Effect.addFinalizer(() =>
      PubSub.shutdown(changes).pipe(
        Effect.andThen(Effect.forEach(clients.keys(), close, { discard: true })),
        Effect.andThen(
          Effect.forEach(pending.values(), (flow) => Effect.tryPromise(() => flow.client.close()).pipe(Effect.ignore), {
            discard: true,
          }),
        ),
      ),
    )
    return service
  }),
)

function effective(entries: readonly Config.Entry[]) {
  const servers = new Map<string, Server>()
  const timeout: { startup?: number; request?: number } = {}
  for (const entry of entries) {
    if (entry.type !== "document" || !entry.info.mcp) continue
    if (entry.info.mcp.timeout?.startup !== undefined) timeout.startup = entry.info.mcp.timeout.startup
    if (entry.info.mcp.timeout?.request !== undefined) timeout.request = entry.info.mcp.timeout.request
    for (const [name, server] of Object.entries(entry.info.mcp.servers ?? {})) servers.set(name, server)
  }
  return { servers, timeout }
}

function connectLocal(
  name: string,
  server: ConfigMCP.Local,
  location: Location.Info,
  timeout: number,
  connect: (name: string, transport: Transport, timeout: number) => Effect.Effect<Client, Error>,
) {
  const [command, ...args] = server.command
  if (!command) return Effect.fail(new Error(`MCP server "${name}" has no command`))
  return connect(
    name,
    new StdioClientTransport({
      stderr: "pipe",
      command,
      args,
      cwd: server.cwd ? path.resolve(location.directory, server.cwd) : location.directory,
      env: {
        ...process.env,
        ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}),
        ...server.environment,
      },
    }),
    timeout,
  )
}

function connectRemote(
  name: string,
  server: ConfigMCP.Remote,
  timeout: number,
  connect: (name: string, transport: Transport, timeout: number) => Effect.Effect<Client, Error>,
  authProvider?: Provider,
) {
  if (!URL.canParse(server.url)) return Effect.fail(new Error(`Invalid MCP URL for "${name}"`))
  const url = new URL(server.url)
  const options = {
    ...(server.headers ? { requestInit: { headers: server.headers } } : {}),
    ...(authProvider ? { authProvider } : {}),
  }
  return connect(name, new StreamableHTTPClientTransport(url, options), timeout).pipe(
    Effect.catch((first) =>
      connect(name, new SSEClientTransport(url, options), timeout).pipe(
        Effect.mapError((second) => new Error(`${first.message}; ${second.message}`)),
      ),
    ),
  )
}

async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => readonly T[],
  label: string,
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const current = await list(cursor)
    result.push(...items(current))
    if (current.nextCursor === undefined) return result
    if (cursors.has(current.nextCursor))
      throw new Error(`MCP ${label} list returned duplicate cursor: ${current.nextCursor}`)
    cursors.add(current.nextCursor)
    cursor = current.nextCursor
  }
  throw new Error(`MCP ${label} list exceeded ${MAX_LIST_PAGES} pages`)
}

async function prompts(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.prompts) return []
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
    "prompt",
  )
}

async function listTools(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.tools) return []
  return paginate(
    (cursor) => client.listTools(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.tools,
    "tool",
  )
}

async function listResources(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.resources) return []
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
    "resource",
  )
}

async function listResourceTemplates(client: Client, timeout: number) {
  if (!client.getServerCapabilities()?.resources) return []
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
    "resource template",
  )
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
export const toolName = (server: string, name: string) => `${sanitize(server)}_${sanitize(name)}`

function collect<T>(
  clients: ReadonlyMap<string, Connected>,
  server: string | undefined,
  label: string,
  list: (connected: Connected) => Promise<readonly T[]>,
) {
  return Effect.forEach(
    Array.from(clients)
      .filter(([name]) => server === undefined || name === server)
      .toSorted(([left], [right]) => left.localeCompare(right)),
    ([name, connected]) =>
      Effect.tryPromise({
        try: () => list(connected),
        catch: asError,
      }).pipe(
        Effect.map((items) => items.map((item) => ({ ...item, server: name }))),
        Effect.tapError((error) =>
          Effect.logWarning(`failed to list MCP ${label}`, { server: name, error: error.message }),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((items) => items.flat() as (T & { readonly server: string })[]))
}

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, MCPAuth.node],
})
