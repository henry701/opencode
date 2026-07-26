export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { Config } from "./config"
import { Shell } from "./shell"
import { spawn, type ChildProcess } from "node:child_process"
import { env, platform } from "node:process"
import { CommandV2 } from "./command"
import { homedir } from "node:os"
import { stat } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { PermissionV1 } from "./v1/permission"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  parentID?: SessionSchema.ID
  title?: string
  metadata?: SessionV1.SessionInfo["metadata"]
  permission?: PermissionV1.Ruleset
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "command", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class QueueItemNotFoundError extends Schema.TaggedErrorClass<QueueItemNotFoundError>()(
  "Session.QueueItemNotFoundError",
  {
    sessionID: SessionSchema.ID,
    messageID: SessionMessage.ID,
  },
) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | QueueItemNotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly update: (input: {
    sessionID: SessionSchema.ID
    title?: string
  }) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly fork: (input: {
    sessionID: SessionSchema.ID
    messageID?: SessionMessage.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageDecodeError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly latestSequence: (sessionID: SessionSchema.ID) => Effect.Effect<number, NotFoundError>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (
    input: {
      id?: SessionMessage.ID
      sessionID: SessionSchema.ID
      delivery?: SessionInput.Delivery
      resume?: boolean
    } & ({ prompt: PromptInput.Prompt; payload?: never } | { payload: SessionInputPayload.Payload; prompt?: never }),
  ) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly queue: {
    readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInput.Queued[], NotFoundError>
    readonly get: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
    }) => Effect.Effect<SessionInput.Queued, NotFoundError | QueueItemNotFoundError>
    readonly enqueue: (input: {
      id?: SessionMessage.ID
      sessionID: SessionSchema.ID
      payload: SessionInputPayload.Payload
      resume?: boolean
    }) => Effect.Effect<SessionInput.Queued, NotFoundError | PromptConflictError>
    readonly update: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      payload: SessionInputPayload.Payload
    }) => Effect.Effect<void, NotFoundError | QueueItemNotFoundError>
    readonly remove: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
    }) => Effect.Effect<void, NotFoundError | QueueItemNotFoundError>
    readonly send: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      payload?: SessionInputPayload.Payload
    }) => Effect.Effect<SessionInput.Admitted, NotFoundError | QueueItemNotFoundError>
    readonly pauseDrain: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
    readonly resumeDrain: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly command: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    name: string
    arguments: string
    payload: SessionInputPayload.Payload
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<
    SessionInput.Admitted,
    NotFoundError | PromptConflictError | CommandV2.NotFoundError | CommandV2.EvaluationError | AgentV2.NotFoundError
  >
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const shells = new Map<SessionSchema.ID, Set<ChildProcess>>()
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )
    const runShell = Effect.fn("V2Session.runShell")(function* (input: {
      sessionID: SessionSchema.ID
      command: string
      directory: string
    }) {
      const config = yield* Config.Service
      const executable = Shell.preferred(Config.latest(yield* config.entries(), "shell"))
      if (!executable) return yield* new OperationUnavailableError({ operation: "shell" })
      const child = spawn(executable, Shell.args(executable, input.command, input.directory), {
        cwd: input.directory,
        detached: platform !== "win32",
        env: { ...env, TERM: "dumb" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
      const active = shells.get(input.sessionID) ?? new Set()
      active.add(child)
      shells.set(input.sessionID, active)
      return yield* Effect.tryPromise({
        try: (signal) =>
          new Promise<string>((resolve) => {
            const chunks: Buffer[] = []
            child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk))
            child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk))
            child.once("error", (error) => {
              chunks.push(Buffer.from(error.message))
              resolve(Buffer.concat(chunks).toString())
            })
            child.once("close", () => resolve(Buffer.concat(chunks).toString()))
            signal.addEventListener("abort", () => void Shell.killTree(child), { once: true })
          }),
        catch: (error) => error,
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(child)
            if (active.size === 0) shells.delete(input.sessionID)
          }),
        ),
        Effect.orDie,
      )
    })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          parentID: input.parentID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: input.title ?? `New session - ${new Date(now).toISOString()}`,
          metadata: input.metadata,
          permission: input.permission,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      update: Effect.fn("V2Session.update")(function* (input) {
        const current = yield* result.get(input.sessionID)
        if (input.title === undefined || input.title === current.title) return current
        yield* events.publish(SessionEvent.InfoUpdated, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          title: input.title,
        })
        return yield* result.get(input.sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const original = yield* result.get(input.sessionID)
        const source = yield* db
          .select({ metadata: SessionTable.metadata, permission: SessionTable.permission })
          .from(SessionTable)
          .where(eq(SessionTable.id, original.id))
          .get()
          .pipe(Effect.orDie)
        const match = original.title.match(/^(.+) \(fork #(\d+)\)$/)
        const forked = yield* result.create({
          parentID: original.id,
          title: match ? `${match[1]} (fork #${Number(match[2]) + 1})` : `${original.title} (fork #1)`,
          location: original.location,
          agent: original.agent,
          model: original.model,
          metadata: source?.metadata == null ? undefined : structuredClone(source.metadata),
          permission: source?.permission == null ? undefined : structuredClone(source.permission),
        })
        for (const message of yield* result.messages({ sessionID: original.id, order: "asc" })) {
          if (message.id === input.messageID) break
          const cloned =
            message.type === "synthetic"
              ? { ...message, id: SessionMessage.ID.create(), sessionID: forked.id }
              : { ...message, id: SessionMessage.ID.create() }
          yield* events.publish(SessionEvent.MessageImported, {
            sessionID: forked.id,
            sourceSessionID: original.id,
            timestamp: yield* DateTime.now,
            message: cloned,
          })
        }
        return yield* result.get(forked.id).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      latestSequence: Effect.fn("V2Session.latestSequence")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* EventV2.latestSequence(db, sessionID)
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            yield* result.get(input.sessionID)
            const payload = input.payload
            const prompt = payload ? SessionInputPayload.toPrompt(payload) : resolvePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, payload, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              payload,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      queue: {
        list: Effect.fn("V2Session.queue.list")(function* (sessionID) {
          yield* result.get(sessionID)
          return yield* SessionInput.listQueued(db, sessionID)
        }),
        get: Effect.fn("V2Session.queue.get")(function* (input) {
          yield* result.get(input.sessionID)
          const queued = yield* SessionInput.getQueued(db, input.sessionID, input.messageID)
          if (!queued)
            return yield* new QueueItemNotFoundError({
              sessionID: input.sessionID,
              messageID: input.messageID,
            })
          return queued
        }),
        enqueue: Effect.fn("V2Session.queue.enqueue")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* result.get(input.sessionID)
              const messageID = input.id ?? SessionMessage.ID.create()
              const prompt = SessionInputPayload.toPrompt(input.payload)
              const admitted = yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: input.sessionID,
                prompt,
                payload: input.payload,
                delivery: "queue",
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                    : Effect.die(defect),
                ),
              )
              if (
                !SessionInput.equivalent(admitted, {
                  sessionID: input.sessionID,
                  prompt,
                  payload: input.payload,
                  delivery: "queue",
                })
              )
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              if (input.resume === true) yield* execution.wake(input.sessionID)
              const queued = yield* SessionInput.getQueued(db, input.sessionID, messageID)
              if (!queued) return yield* Effect.die("Newly admitted queue item is not pending")
              return queued
            }),
          ),
        ),
        update: Effect.fn("V2Session.queue.update")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* result.get(input.sessionID)
              yield* SessionInput.revise(db, events, {
                id: input.messageID,
                sessionID: input.sessionID,
                payload: input.payload,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new QueueItemNotFoundError({
                        sessionID: input.sessionID,
                        messageID: input.messageID,
                      })
                    : Effect.die(defect),
                ),
              )
            }),
          ),
        ),
        remove: Effect.fn("V2Session.queue.remove")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* result.get(input.sessionID)
              yield* SessionInput.discard(db, events, {
                id: input.messageID,
                sessionID: input.sessionID,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new QueueItemNotFoundError({
                        sessionID: input.sessionID,
                        messageID: input.messageID,
                      })
                    : Effect.die(defect),
                ),
              )
            }),
          ),
        ),
        send: Effect.fn("V2Session.queue.send")((input) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              yield* result.get(input.sessionID)
              const admitted = yield* SessionInput.expedite(db, events, {
                id: input.messageID,
                sessionID: input.sessionID,
                payload: input.payload,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new QueueItemNotFoundError({
                        sessionID: input.sessionID,
                        messageID: input.messageID,
                      })
                    : Effect.die(defect),
                ),
              )
              yield* execution.wake(input.sessionID)
              return admitted
            }),
          ),
        ),
        pauseDrain: Effect.fn("V2Session.queue.pauseDrain")(function* (sessionID) {
          yield* result.get(sessionID)
          yield* execution.pauseQueueDrain(sessionID)
        }),
        resumeDrain: Effect.fn("V2Session.queue.resumeDrain")(function* (sessionID) {
          yield* result.get(sessionID)
          yield* execution.resumeQueueDrain(sessionID)
        }),
      },
      command: Effect.fn("V2Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* Effect.gen(function* () {
          const commands = yield* CommandV2.Service
          const agents = yield* AgentV2.Service
          const messageID = input.id ?? SessionMessage.ID.create()
          const delivery = input.delivery ?? "steer"
          const signature = commandSignature(input, delivery)
          const existing = yield* SessionInput.find(db, messageID)
          if (existing) {
            if (
              existing.sessionID !== input.sessionID ||
              existing.delivery !== delivery ||
              commandMarker(existing.payload) !== signature
            )
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(input.sessionID)
            return existing
          }
          const historical = input.id ? yield* store.message(messageID) : undefined
          if (historical) {
            if (
              historical.sessionID !== input.sessionID ||
              historical.message.type !== "user" ||
              historical.message.payload === undefined ||
              commandMarker(historical.message.payload) !== signature
            )
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            const row = yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(eq(SessionMessageTable.id, messageID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            const admitted = yield* SessionInput.synthesizeProjected(db, {
              id: messageID,
              sessionID: input.sessionID,
              prompt: Prompt.make({
                text: historical.message.text,
                files: historical.message.files,
                agents: historical.message.agents,
              }),
              payload: historical.message.payload,
              delivery,
              timeCreated: historical.message.time.created,
              promotedSeq: row.seq,
            })
            if (input.resume !== false) yield* execution.wake(input.sessionID)
            return admitted
          }

          const command = yield* commands.get(input.name)
          if (!command)
            return yield* new CommandV2.NotFoundError({
              command: input.name,
              available: (yield* commands.list()).map((item) => item.name).toSorted(),
            })
          const expanded = (yield* commands.evaluate({ name: input.name, arguments: input.arguments })).text
          const agentID = AgentV2.ID.make(command.agent ?? input.payload.agent)
          const agent = yield* agents.get(agentID)
          if (!agent)
            return yield* new AgentV2.NotFoundError({
              agent: agentID,
              available: (yield* agents.all())
                .filter((item) => !item.hidden)
                .map((item) => item.id)
                .toSorted(),
            })
          const model = command.model ?? (command.agent ? agent.model : undefined) ?? {
            providerID: input.payload.model.providerID,
            id: input.payload.model.modelID,
            variant: input.payload.model.variant,
          }
          const subtask = command.subtask === true || (agent?.mode === "subagent" && command.subtask !== false)
          const retained = input.payload.parts.filter(
            (part) => part.type !== "text" || part.synthetic === true || part.ignored === true,
          )
          const references = [
            ...new Set(
              Array.from(expanded.matchAll(/(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g)).flatMap((match) =>
                match[1] ? [match[1]] : [],
              ),
            ),
          ]
          const referenced = yield* Effect.forEach(
            references,
            Effect.fnUntraced(function* (name) {
              const file = name.startsWith("~/")
                ? path.join(homedir(), name.slice(2))
                : path.resolve(session.location.directory, name)
              const info = yield* Effect.promise(() => stat(file)).pipe(Effect.option)
              if (info._tag === "Some")
                return SessionInputPayload.FilePart.make({
                  type: "file",
                  url: pathToFileURL(file).href,
                  filename: name,
                  mime: info.value.isDirectory() ? "application/x-directory" : "text/plain",
                })
              const referencedAgent = yield* agents.get(AgentV2.ID.make(name))
              if (referencedAgent) return SessionInputPayload.AgentPart.make({ type: "agent", name })
            }),
            { concurrency: "unbounded" },
          )
          const attachments = referenced.filter(
            (part): part is NonNullable<(typeof referenced)[number]> => part !== undefined,
          )
          const urls = new Set(retained.flatMap((part) => (part.type === "file" ? [part.url] : [])))
          const names = new Set(retained.flatMap((part) => (part.type === "agent" ? [part.name] : [])))
          const parts: SessionInputPayload.Part[] = subtask
            ? [
                SessionInputPayload.SubtaskPart.make({
                  type: "subtask",
                  agent: agentID,
                  description: command.description ?? "",
                  command: command.name,
                  prompt: expanded,
                  model: {
                    providerID: model.providerID,
                    modelID: model.id,
                    variant: model.variant,
                  },
                }),
              ]
            : [
                SessionInputPayload.TextPart.make({ type: "text", text: expanded }),
                ...attachments.filter((part) => {
                  if (part.type === "file") {
                    if (urls.has(part.url)) return false
                    urls.add(part.url)
                    return true
                  }
                  if (names.has(part.name)) return false
                  names.add(part.name)
                  return true
                }),
                ...retained,
              ]
          const output = yield* commands.execute.trigger(
            { command: input.name, sessionID: input.sessionID, arguments: input.arguments },
            { parts },
          )
          const payload = SessionInputPayload.Payload.make({
            ...input.payload,
            agent: subtask ? input.payload.agent : agentID,
            model: subtask
              ? input.payload.model
              : { providerID: model.providerID, modelID: model.id, variant: model.variant },
            parts: [
              ...output.parts,
              SessionInputPayload.TextPart.make({
                type: "text",
                text: "",
                synthetic: true,
                ignored: true,
                metadata: { kind: "command_request", signature },
              }),
            ],
          })
          const admitted = yield* result.prompt({
            id: messageID,
            sessionID: input.sessionID,
            delivery,
            resume: input.resume,
            payload,
          })
          yield* events.publish(SessionEvent.Command.Executed, {
            sessionID: input.sessionID,
            messageID,
            timestamp: yield* DateTime.now,
            name: input.name,
            arguments: input.arguments,
          })
          return admitted
        }).pipe(Effect.provide(locations.get(session.location)))
      }),
      shell: Effect.fn("V2Session.shell")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const callID = `shell_${crypto.randomUUID()}`
        const messageID = SessionMessage.ID.create()
        const run = Effect.gen(function* () {
          yield* events.publish(
            SessionEvent.Shell.Started,
            {
              sessionID: input.sessionID,
              messageID,
              callID,
              command: input.command,
              timestamp: yield* DateTime.now,
            },
            { id: input.id, location: session.location },
          )
          const output = yield* runShell({
            sessionID: input.sessionID,
            command: input.command,
            directory: session.location.directory,
          })
          yield* events.publish(
            SessionEvent.Shell.Ended,
            {
              sessionID: input.sessionID,
              callID,
              output,
              timestamp: yield* DateTime.now,
            },
            { location: session.location },
          )
        })
        yield* run.pipe(Effect.provide(locations.get(session.location)))
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(
          Effect.all([
            execution.interrupt(sessionID),
            Effect.promise(() =>
              Promise.all(Array.from(shells.get(sessionID) ?? [], (process) => Shell.killTree(process))),
            ),
          ]).pipe(Effect.asVoid),
        ),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

function commandSignature(input: {
  name: string
  arguments: string
  payload: SessionInputPayload.Payload
}, delivery: SessionInput.Delivery) {
  return JSON.stringify({ name: input.name, arguments: input.arguments, payload: input.payload, delivery })
}

function commandMarker(payload: SessionInputPayload.Payload | undefined) {
  const marker = payload?.parts.find(
    (part) =>
      part.type === "text" &&
      part.ignored === true &&
      part.synthetic === true &&
      part.metadata?.kind === "command_request",
  )
  return marker?.type === "text" && typeof marker.metadata?.signature === "string"
    ? marker.metadata.signature
    : undefined
}

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
