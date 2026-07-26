export * as LSP from "./lsp"

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node"
import type { Diagnostic } from "vscode-languageserver-types"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import { NonNegativeInt } from "./schema"

const DIAGNOSTIC_WAIT_MS = 5_000
const INITIALIZE_TIMEOUT_MS = 45_000

export const Position = Schema.Struct({ file: Schema.String, line: NonNegativeInt, character: NonNegativeInt })
export type Position = typeof Position.Type

export const Status = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "failed"]),
  error: Schema.optional(Schema.String),
})
export type Status = typeof Status.Type

export interface Interface {
  readonly status: () => Effect.Effect<Status[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (file: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, Diagnostic[]>>
  readonly hover: (input: Position) => Effect.Effect<unknown[]>
  readonly definition: (input: Position) => Effect.Effect<unknown[]>
  readonly references: (input: Position) => Effect.Effect<unknown[]>
  readonly implementation: (input: Position) => Effect.Effect<unknown[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<unknown[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<unknown[]>
  readonly prepareCallHierarchy: (input: Position) => Effect.Effect<unknown[]>
  readonly incomingCalls: (input: Position) => Effect.Effect<unknown[]>
  readonly outgoingCalls: (input: Position) => Effect.Effect<unknown[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/LSP") {}

export const inert = Service.of({
  status: () => Effect.succeed([]),
  hasClients: () => Effect.succeed(false),
  touchFile: () => Effect.void,
  diagnostics: () => Effect.succeed({}),
  hover: () => Effect.succeed([]),
  definition: () => Effect.succeed([]),
  references: () => Effect.succeed([]),
  implementation: () => Effect.succeed([]),
  documentSymbol: () => Effect.succeed([]),
  workspaceSymbol: () => Effect.succeed([]),
  prepareCallHierarchy: () => Effect.succeed([]),
  incomingCalls: () => Effect.succeed([]),
  outgoingCalls: () => Effect.succeed([]),
})

type Server = {
  readonly id: string
  readonly command: readonly string[]
  readonly extensions: readonly string[]
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}

type Client = {
  readonly server: Server
  readonly process: ChildProcessWithoutNullStreams
  readonly connection: MessageConnection
  readonly diagnostics: Map<string, Diagnostic[]>
  readonly waiters: Map<string, Set<() => void>>
  readonly versions: Map<string, number>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const configured = Config.latest(yield* config.entries(), "lsp")
    const servers =
      configured === undefined || configured === false || configured === true
        ? []
        : Object.entries(configured).flatMap(([id, item]): Server[] =>
            item.disabled || item.command.length === 0
              ? []
              : [
                  {
                    id,
                    command: item.command,
                    extensions: item.extensions ?? [],
                    env: item.env,
                    initialization: item.initialization,
                  },
                ],
          )
    const clients = new Map<string, Promise<Client | undefined>>()
    const failures = new Map<string, string>()

    const connect = async (server: Server) => {
      const process = spawn(server.command[0]!, server.command.slice(1), {
        cwd: location.directory,
        env: { ...globalThis.process.env, ...server.env },
        stdio: "pipe",
      })
      const connection = createMessageConnection(
        new StreamMessageReader(process.stdout),
        new StreamMessageWriter(process.stdin),
      )
      const diagnostics = new Map<string, Diagnostic[]>()
      const waiters = new Map<string, Set<() => void>>()
      connection.onNotification(
        "textDocument/publishDiagnostics",
        (input: { uri: string; diagnostics: Diagnostic[] }) => {
          const file = fileURLToPath(input.uri)
          diagnostics.set(file, input.diagnostics)
          for (const resolve of waiters.get(file) ?? []) resolve()
          waiters.delete(file)
        },
      )
      connection.onRequest("workspace/configuration", () => [])
      connection.onRequest("workspace/workspaceFolders", () => [
        { name: path.basename(location.directory), uri: pathToFileURL(location.directory).href },
      ])
      connection.listen()
      try {
        await Promise.race([
          connection.sendRequest("initialize", {
            rootUri: pathToFileURL(location.directory).href,
            processId: globalThis.process.pid,
            workspaceFolders: [{ name: path.basename(location.directory), uri: pathToFileURL(location.directory).href }],
            initializationOptions: server.initialization ?? {},
            capabilities: {
              workspace: { configuration: true, workspaceFolders: true },
              textDocument: { synchronization: { didOpen: true, didChange: true }, publishDiagnostics: {} },
            },
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("LSP initialize timed out")), INITIALIZE_TIMEOUT_MS)),
        ])
        connection.sendNotification("initialized", {})
        return { server, process, connection, diagnostics, waiters, versions: new Map() } satisfies Client
      } catch (error) {
        connection.dispose()
        process.kill()
        failures.set(server.id, error instanceof Error ? error.message : String(error))
      }
    }

    const matches = (server: Server, file: string) =>
      file.startsWith(`${location.directory}${path.sep}`) &&
      (server.extensions.length === 0 || server.extensions.includes(path.extname(file) || file))

    const getClients = (file: string) =>
      Promise.all(
        servers.filter((server) => matches(server, file)).map((server) => {
          const current = clients.get(server.id)
          if (current) return current
          const created = connect(server)
          clients.set(server.id, created)
          return created
        }),
      ).then((items) => items.filter((item): item is Client => item !== undefined))

    const run = (file: string, request: (client: Client) => Promise<unknown>) =>
      Effect.promise(() =>
        getClients(file).then((items) => Promise.all(items.map((client) => request(client).catch(() => undefined)))),
      ).pipe(
        Effect.map((items) =>
          items.flatMap((item) => (item === undefined || item === null ? [] : Array.isArray(item) ? item : [item])),
        ),
      )

    const position = (method: string, input: Position, extra: Record<string, unknown> = {}) =>
      run(input.file, (client) =>
        client.connection.sendRequest(method, {
          textDocument: { uri: pathToFileURL(input.file).href },
          position: { line: input.line, character: input.character },
          ...extra,
        }),
      )

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const pending of clients.values()) {
          const client = await pending
          if (!client) continue
          await client.connection.sendRequest("shutdown").catch(() => {})
          client.connection.sendNotification("exit")
          client.connection.dispose()
          client.process.kill()
        }
      }),
    )

    return Service.of({
      status: Effect.fn("LSP.status")(function* () {
        const connected = (awaited: (Client | undefined)[]) =>
          awaited.flatMap((client): Status[] =>
            client
              ? [{ id: client.server.id, root: ".", status: "connected" }]
              : [],
          )
        const active = yield* Effect.promise(() => Promise.all(clients.values()))
        return [
          ...connected(active),
          ...Array.from(failures, ([id, error]): Status => ({ id, root: ".", status: "failed", error })),
        ].toSorted((left, right) => left.id.localeCompare(right.id))
      }),
      hasClients: (file) => Effect.succeed(servers.some((server) => matches(server, file))),
      touchFile: Effect.fn("LSP.touchFile")(function* (file, mode) {
        const content = yield* Effect.promise(() => Bun.file(file).text())
        yield* Effect.promise(async () => {
          const active = await getClients(file)
          await Promise.all(
            active.map(async (client) => {
              const uri = pathToFileURL(file).href
              const version = (client.versions.get(file) ?? 0) + 1
              const wait =
                mode === undefined
                  ? undefined
                  : new Promise<void>((resolve) => {
                      const set = client.waiters.get(file) ?? new Set()
                      const finish = () => {
                        set.delete(finish)
                        if (set.size === 0) client.waiters.delete(file)
                        resolve()
                      }
                      set.add(finish)
                      client.waiters.set(file, set)
                      setTimeout(finish, DIAGNOSTIC_WAIT_MS)
                    })
              if (version === 1)
                client.connection.sendNotification("textDocument/didOpen", {
                  textDocument: { uri, languageId: path.extname(file).slice(1), version, text: content },
                })
              else
                client.connection.sendNotification("textDocument/didChange", {
                  textDocument: { uri, version },
                  contentChanges: [{ text: content }],
                })
              client.versions.set(file, version)
              await wait
            }),
          )
        })
      }),
      diagnostics: Effect.fn("LSP.diagnostics")(function* () {
        const result: Record<string, Diagnostic[]> = {}
        for (const client of (yield* Effect.promise(() => Promise.all(clients.values()))).filter(
          (item): item is Client => item !== undefined,
        ))
          for (const [file, items] of client.diagnostics) result[file] = [...(result[file] ?? []), ...items]
        return result
      }),
      hover: (input) => position("textDocument/hover", input),
      definition: (input) => position("textDocument/definition", input),
      references: (input) => position("textDocument/references", input, { context: { includeDeclaration: true } }),
      implementation: (input) => position("textDocument/implementation", input),
      prepareCallHierarchy: (input) => position("textDocument/prepareCallHierarchy", input),
      incomingCalls: (input) => position("callHierarchy/incomingCalls", input),
      outgoingCalls: (input) => position("callHierarchy/outgoingCalls", input),
      documentSymbol: (uri) =>
        run(fileURLToPath(uri), (client) =>
          client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
        ),
      workspaceSymbol: (query) =>
        Effect.promise(() =>
          Promise.all(
            Array.from(clients.values(), async (pending) => {
              const client = await pending
              return client?.connection.sendRequest("workspace/symbol", { query }).catch(() => []) ?? []
            }),
          ),
        ).pipe(Effect.map((items) => items.flat())),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, Location.node] })

export function report(file: string, diagnostics: readonly Diagnostic[]) {
  return diagnostics
    .filter((item) => item.severity === 1)
    .map(
      (item) =>
        `${file}:${item.range.start.line + 1}:${item.range.start.character + 1} ${item.source ? `[${item.source}] ` : ""}${item.message}`,
    )
    .join("\n")
}
