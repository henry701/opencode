import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Config } from "@opencode-ai/core/config"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { testEffect } from "./lib/effect"

const executionCalls: SessionV2.ID[] = []
const interruptCalls: SessionV2.ID[] = []
const wakeCalls: SessionV2.ID[] = []
const pauseQueueDrainCalls: SessionV2.ID[] = []
const resumeQueueDrainCalls: SessionV2.ID[] = []
const activeSessions = new Set<SessionV2.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(activeSessions)),
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
    interrupt: (sessionID) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
      }),
    wake: (sessionID) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
      }),
    pauseQueueDrain: (sessionID) =>
      Effect.sync(() => {
        pauseQueueDrainCalls.push(sessionID)
      }),
    resumeQueueDrain: (sessionID) =>
      Effect.sync(() => {
        resumeQueueDrainCalls.push(sessionID)
      }),
    queueDrainPaused: () => Effect.succeed(false),
  }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () => Effect.succeed([]),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      LocationServiceMap.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
    ]),
    [
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_prompt_test")
const messageID = SessionMessage.ID.create()

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const admitted = (id: SessionMessage.ID) => Database.Service.use(({ db }) => SessionInput.find(db, id))
const admittedCount = Database.Service.use(({ db }) =>
  db
    .select()
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    ),
)
const eventCount = (type: string) =>
  Database.Service.use(({ db }) =>
    db
      .select()
      .from(EventTable)
      .where(eq(EventTable.type, type))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.length),
      ),
  )

describe("SessionV2.prompt", () => {
  it.effect("exposes the execution registry", () =>
    Effect.gen(function* () {
      activeSessions.add(sessionID)
      expect(Array.from(yield* (yield* SessionV2.Service).active)).toEqual([sessionID])
    }).pipe(Effect.ensuring(Effect.sync(() => activeSessions.clear()))),
  )

  it.effect("delegates execution continuation through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("delegates process-local interruption through SessionExecution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(sessionID)
      expect(interruptCalls).toEqual([sessionID])
      expect(yield* session.messages({ sessionID })).toEqual([])
    }),
  )

  it.effect("delegates interruption without requiring a recorded Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      interruptCalls.length = 0

      yield* session.interrupt(SessionV2.ID.make("ses_missing"))
      expect(interruptCalls).toEqual([SessionV2.ID.make("ses_missing")])
    }),
  )

  it.effect("records shell commands and output in current Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ directory: process.cwd() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service

      yield* session.shell({ sessionID, command: "printf current-shell-output" })

      expect(yield* session.messages({ sessionID, order: "asc" })).toMatchObject([
        {
          type: "shell",
          command: "printf current-shell-output",
          output: "current-shell-output",
        },
      ])
    }),
  )

  it.effect("durably admits one user message before transcript promotion", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      expect(message.prompt.text).toBe("Fix the failing tests")
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).toMatchObject({
        id: message.id,
        sessionID,
        prompt: { text: "Fix the failing tests" },
        delivery: "steer",
      })
    }),
  )

  it.effect("durably preserves the complete payload for a normal prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const payload = SessionInputPayload.Payload.make({
        version: 1,
        agent: "reviewer",
        model: {
          providerID: SessionInputPayload.ProviderID.make("test"),
          modelID: SessionInputPayload.ModelID.make("model"),
          variant: SessionInputPayload.VariantID.make("careful"),
        },
        tools: { write: false },
        system: "Review only",
        format: { type: "json_schema", schema: { type: "object" }, retryCount: 1 },
        permissions: [{ permission: "read", pattern: "*", action: "allow" }],
        parts: [
          { type: "text", text: "Inspect this" },
          { type: "agent", name: "reviewer" },
        ],
      })

      const message = yield* session.prompt({ sessionID, payload, resume: false })

      expect(message).toMatchObject({
        prompt: { text: "Inspect this", agents: [{ name: "reviewer" }] },
        payload,
      })
      expect(yield* admitted(message.id)).toMatchObject({ payload })
    }),
  )

  it.effect("resolves attachment MIME before admission", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: {
          text: "Inspect this image",
          files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "image.png" }],
        },
        resume: false,
      })

      expect(message.prompt.files).toEqual([
        { uri: "data:image/png;base64,aGVsbG8=", name: "image.png", mime: "image/png" },
      ])
      expect((yield* admitted(message.id))?.prompt.files).toEqual(message.prompt.files)
    }),
  )

  it.effect("streams durable Session events after an aggregate sequence", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const fiber = yield* session.events({ sessionID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Second" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      const streamed = Array.from(yield* Fiber.join(fiber))

      expect(streamed.map((event) => [event.durable?.seq, event.type])).toEqual([
        [0, "session.next.prompt.admitted"],
        [1, "session.next.prompt.admitted"],
        [2, "session.next.prompted"],
        [3, "session.next.prompted"],
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, after: streamed[0]!.durable?.seq })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((event) => [event.durable?.seq, event.type]),
      ).toEqual([[1, "session.next.prompt.admitted"]])
    }),
  )

  it.effect("resumes through a recorded message without appending another prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const message = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })

      executionCalls.length = 0
      wakeCalls.length = 0
      yield* session.resume(sessionID)

      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admitted(message.id)).not.toHaveProperty("promotedSeq")
      expect(executionCalls).toEqual([sessionID])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("records distinct messages when the ID is omitted", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = { sessionID, prompt: Prompt.make({ text: "Fix the failing tests" }), resume: false }

      const first = yield* session.prompt(input)
      const second = yield* session.prompt(input)

      expect(second.id).not.toBe(first.id)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(2)
    }),
  )

  it.effect("returns the original recorded message when the ID is retried", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const first = yield* session.prompt(input)
      const retried = yield* session.prompt(input)

      expect(retried).toEqual(first)
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("wakes execution when an exact prompt retry recovers a committed message", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Recover committed prompt" }),
        resume: false,
      }
      const first = yield* session.prompt(input)
      wakeCalls.length = 0

      const retried = yield* session.prompt({ ...input, resume: true })

      expect(retried).toEqual(first)
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("rejects reuse of one ID with a different prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: Prompt.make({ text: "Delete the failing tests" }),
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
      expect(yield* session.messages({ sessionID })).toHaveLength(0)
      expect(yield* admittedCount).toBe(1)
    }),
  )

  it.effect("rejects reuse of one ID with a different delivery mode", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      })
      const failure = yield* session
        .prompt({
          id: messageID,
          sessionID,
          prompt: Prompt.make({ text: "Fix the failing tests" }),
          delivery: "queue",
          resume: false,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("returns one recorded message to concurrent exact retries", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const input = {
        sessionID,
        id: messageID,
        prompt: Prompt.make({ text: "Fix the failing tests" }),
        resume: false,
      }

      const messages = yield* Effect.all([session.prompt(input), session.prompt(input)], { concurrency: "unbounded" })

      expect(messages[1]).toEqual(messages[0])
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(yield* admittedCount).toBe(1)
      expect(yield* eventCount(EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1))).toBe(1)
    }),
  )

  it.effect("promotes one message once under concurrent promotion attempts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Promote once" }), resume: false })

      yield* Effect.all(
        [
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
          SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER),
        ],
        { concurrency: "unbounded" },
      )

      expect(yield* eventCount(EventV2.versionedType(SessionEvent.Prompted.type, 1))).toBe(1)
      expect(yield* admitted(messageID)).toMatchObject({ promotedSeq: 1 })
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: messageID, type: "user", text: "Promote once" },
      ])
    }),
  )

  it.effect("promotes steers only through the captured inbox cutoff", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const first = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Before cutoff" }), resume: false })
      const cutoff = first.admittedSeq
      const second = yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "After cutoff" }), resume: false })

      yield* SessionInput.promoteSteers(db, events, sessionID, cutoff)

      expect(yield* admitted(first.id)).toHaveProperty("promotedSeq")
      expect(yield* admitted(second.id)).not.toHaveProperty("promotedSeq")
    }),
  )

  it.effect("reprojects pending inbox input without scheduling execution", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      wakeCalls.length = 0
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: Prompt.make({ text: "Replay pending" }),
        resume: false,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      yield* events.remove(sessionID)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* events.replayAll(
        recorded.map((event) => ({
          id: event.id,
          aggregateID: event.aggregate_id,
          seq: event.seq,
          type: event.type,
          data: event.data,
        })),
      )

      expect(yield* admitted(messageID)).toMatchObject({ id: messageID, prompt: { text: "Replay pending" } })
      expect(yield* session.messages({ sessionID })).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )

  it.effect("returns an exact retry of a legacy projected prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "steer",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical prompt" } })
      expect(yield* admitted(messageID)).toHaveProperty("promotedSeq")
    }),
  )

  it.effect("returns an exact retry of a legacy projected queued prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const prompt = Prompt.make({ text: "Historical queued prompt" })
      yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        prompt,
        delivery: "queue",
      })

      const retried = yield* session.prompt({ id: messageID, sessionID, prompt, delivery: "queue", resume: false })

      expect(retried).toMatchObject({ id: messageID, prompt: { text: "Historical queued prompt" } })
      expect(yield* admitted(messageID)).toMatchObject({ delivery: "queue" })
    }),
  )

  it.effect("rejects reuse of one globally unique message ID across sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      const other = SessionV2.ID.make("ses_prompt_other")
      yield* db
        .insert(SessionTable)
        .values({
          id: other,
          project_id: Project.ID.global,
          slug: "other",
          directory: "/project",
          title: "other",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const prompt = Prompt.make({ text: "Fix the failing tests" })

      yield* session.prompt({ id: messageID, sessionID, prompt, resume: false })
      const failure = yield* session
        .prompt({ id: messageID, sessionID: other, prompt, resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID: other, messageID })
    }),
  )

  it.effect("rejects a prompt ID already used by visible Session history", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: "Existing history",
      })

      const failure = yield* session
        .prompt({ id: messageID, sessionID, prompt: Prompt.make({ text: "Conflicting prompt" }), resume: false })
        .pipe(Effect.flip)

      expect(failure).toMatchObject({ _tag: "Session.PromptConflictError", sessionID, messageID })
      expect(yield* admitted(messageID)).toBeUndefined()
    }),
  )

  it.effect("starts execution by default after recording the prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Run by default" }) })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("starts execution when resume is explicitly true", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Run explicitly" }),
        resume: true,
      })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([sessionID])
    }),
  )

  it.effect("only records the prompt when resume is false", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      executionCalls.length = 0
      wakeCalls.length = 0

      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Do not run" }), resume: false })

      expect(executionCalls).toEqual([])
      expect(wakeCalls).toEqual([])
    }),
  )
})

describe("SessionV2.command", () => {
  const payload = SessionInputPayload.Payload.make({
    version: 1,
    agent: "build",
    model: {
      providerID: SessionInputPayload.ProviderID.make("input"),
      modelID: SessionInputPayload.ModelID.make("input-model"),
      variant: SessionInputPayload.VariantID.make("input-variant"),
    },
    parts: [{ type: "text", text: "Discarded command text" }],
  })

  it.effect("reconciles exact retries before shell interpolation and emits one execution event", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ directory: process.cwd() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const location = (yield* session.get(sessionID)).location
      const locations = yield* LocationServiceMap.Service
      const command = yield* CommandV2.Service.pipe(Effect.provide(locations.get(location)))
      const agents = yield* AgentV2.Service.pipe(Effect.provide(locations.get(location)))
      yield* agents.transform((draft) => draft.update(AgentV2.ID.make("build"), () => undefined))
      const sideEffect = `/tmp/opencode-command-retry-${crypto.randomUUID()}`
      yield* command.transform((draft) =>
        draft.update("retry-safe", (item) => {
          item.template = `!` + "`" + `printf x >> '${sideEffect}'; printf expanded` + "`"
        }),
      )
      const id = SessionMessage.ID.create()

      const first = yield* session.command({
        id,
        sessionID,
        name: "retry-safe",
        arguments: "",
        payload,
        resume: false,
      })
      const second = yield* session.command({
        id,
        sessionID,
        name: "retry-safe",
        arguments: "",
        payload,
        resume: false,
      })
      const events = yield* EventV2.Service
      yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      yield* db.delete(SessionInputTable).where(eq(SessionInputTable.id, id)).run().pipe(Effect.orDie)
      const historical = yield* session.command({
        id,
        sessionID,
        name: "retry-safe",
        arguments: "",
        payload,
        resume: false,
      })
      const conflict = yield* session
        .command({
          id,
          sessionID,
          name: "retry-safe",
          arguments: "different",
          payload,
          resume: false,
        })
        .pipe(Effect.flip, Effect.orDie)

      expect(second).toEqual(first)
      expect(historical).toMatchObject({ id, payload: first.payload, promotedSeq: expect.any(Number) })
      expect(conflict._tag).toBe("Session.PromptConflictError")
      expect(yield* Effect.promise(() => Bun.file(sideEffect).text())).toBe("x")
      expect(yield* eventCount("session.next.command.executed.1")).toBe(1)
      yield* Effect.promise(() => Bun.file(sideEffect).delete())
    }),
  )

  it.effect("applies the before hook, deduplicates references, and preserves the parent subtask envelope", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ directory: process.cwd() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const location = (yield* session.get(sessionID)).location
      const locations = yield* LocationServiceMap.Service
      const command = yield* CommandV2.Service.pipe(Effect.provide(locations.get(location)))
      const agents = yield* AgentV2.Service.pipe(Effect.provide(locations.get(location)))
      yield* agents.transform((draft) => {
        draft.update(AgentV2.ID.make("build"), () => undefined)
        draft.update(AgentV2.ID.make("review"), (agent) => {
          agent.mode = "subagent"
          agent.model = {
            providerID: ProviderV2.ID.make("agent"),
            id: ModelV2.ID.make("agent-model"),
            variant: ModelV2.VariantID.make("agent-variant"),
          }
        })
      })
      yield* command.transform((draft) =>
        draft.update("review", (item) => {
          item.template = "Review $ARGUMENTS"
          item.agent = "review"
          item.description = "Review changes"
        }),
      )
      let hookInput: CommandV2.BeforeInput | undefined
      yield* command.execute.before((input, output) => {
        hookInput = input
        output.parts.push({ type: "agent", name: "hook-added" })
      })

      const admitted = yield* session.command({
        sessionID,
        name: "review",
        arguments: "carefully",
        payload,
        resume: false,
      })

      expect(hookInput).toEqual({ command: "review", sessionID, arguments: "carefully" })
      expect(admitted.payload).toMatchObject({
        agent: payload.agent,
        model: payload.model,
      })
      expect(admitted.payload?.parts[0]).toMatchObject({
        type: "subtask",
        agent: "review",
        description: "Review changes",
        command: "review",
        prompt: "Review carefully",
        model: {
          providerID: "agent",
          modelID: "agent-model",
          variant: "agent-variant",
        },
      })
      expect(admitted.payload?.parts[1]).toMatchObject({ type: "agent", name: "hook-added" })
    }),
  )

  it.effect("reports typed command and agent lookup failures", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ directory: process.cwd() })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      expect(
        (
          yield* session
            .command({
              sessionID,
              name: "missing",
              arguments: "",
              payload,
              resume: false,
            })
            .pipe(Effect.flip, Effect.orDie)
        )._tag,
      ).toBe("Command.NotFoundError")

      const location = (yield* session.get(sessionID)).location
      const locations = yield* LocationServiceMap.Service
      const command = yield* CommandV2.Service.pipe(Effect.provide(locations.get(location)))
      yield* command.transform((draft) =>
        draft.update("missing-agent", (item) => {
          item.template = "Run"
          item.agent = "does-not-exist"
        }),
      )
      expect(
        (
          yield* session
            .command({
              sessionID,
              name: "missing-agent",
              arguments: "",
              payload,
              resume: false,
            })
            .pipe(Effect.flip, Effect.orDie)
        )._tag,
      ).toBe("Agent.NotFoundError")
    }),
  )
})

describe("SessionV2.queue", () => {
  const payload = SessionInputPayload.Payload.make({
    version: 1,
    agent: "build",
    model: {
      providerID: SessionInputPayload.ProviderID.make("anthropic"),
      modelID: SessionInputPayload.ModelID.make("claude-sonnet"),
      variant: SessionInputPayload.VariantID.make("thinking"),
    },
    tools: { bash: true, write: false },
    system: "Keep the response concise.",
    format: {
      type: "json_schema",
      schema: { type: "object", properties: { answer: { type: "string" } } },
      retryCount: 4,
    },
    permissions: [{ permission: "bash", pattern: "git *", action: "allow" }],
    parts: [
      { type: "text", text: "First" },
      { type: "agent", name: "review", source: { value: "@review", start: 0, end: 7 } },
      {
        type: "subtask",
        prompt: "Check the parser",
        description: "Parser review",
        agent: "review",
        model: {
          providerID: SessionInputPayload.ProviderID.make("openai"),
          modelID: SessionInputPayload.ModelID.make("gpt-5"),
        },
        command: "review",
      },
    ],
  })

  it.effect("ignores prompt-only queue records in the typed queue listing", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const admitted = yield* session.prompt({
        sessionID,
        prompt: Prompt.make({ text: "legacy queue prompt" }),
        delivery: "queue",
        resume: false,
      })

      expect(admitted.payload).toBeUndefined()
      expect(yield* session.queue.list(sessionID)).toEqual([])
    }),
  )

  it.effect("persists, revises, expedites, and tombstones queued payloads durably", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      wakeCalls.length = 0

      const first = yield* session.queue.enqueue({ sessionID, payload })
      const second = yield* session.queue.enqueue({
        sessionID,
        payload: SessionInputPayload.Payload.make({
          ...payload,
          parts: [{ type: "text", text: "Second" }],
        }),
      })

      expect(wakeCalls).toEqual([])
      expect((yield* session.queue.list(sessionID)).map((item) => [item.id, item.position])).toEqual([
        [first.id, 0],
        [second.id, 1],
      ])
      expect((yield* session.queue.get({ sessionID, messageID: first.id })).payload).toEqual(payload)

      const revised = SessionInputPayload.Payload.make({
        ...payload,
        parts: [{ type: "text", text: "First edited" }],
      })
      yield* session.queue.update({ sessionID, messageID: first.id, payload: revised })
      const sent = yield* session.queue.send({ sessionID, messageID: first.id })
      expect(sent.delivery).toBe("steer")
      expect(sent.payload).toEqual(revised)
      expect(wakeCalls).toEqual([sessionID])

      yield* session.queue.remove({ sessionID, messageID: second.id })
      expect(yield* session.queue.list(sessionID)).toEqual([])
      expect(yield* SessionInput.find((yield* Database.Service).db, second.id)).toMatchObject({
        id: second.id,
        discardedSeq: expect.any(Number),
      })
      expect(
        (yield* session.history({ sessionID, limit: 20 })).events.map((event) => event.type),
      ).toEqual([
        "session.next.prompt.admitted",
        "session.next.prompt.admitted",
        "session.next.prompt.revised",
        "session.next.prompt.expedited",
        "session.next.prompt.discarded",
      ])
    }),
  )

  it.effect("delegates queue drain holds to process-global execution", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      pauseQueueDrainCalls.length = 0
      resumeQueueDrainCalls.length = 0

      yield* session.queue.pauseDrain(sessionID)
      yield* session.queue.pauseDrain(sessionID)
      yield* session.queue.resumeDrain(sessionID)
      yield* session.queue.resumeDrain(sessionID)

      expect(pauseQueueDrainCalls).toEqual([sessionID, sessionID])
      expect(resumeQueueDrainCalls).toEqual([sessionID, sessionID])
    }),
  )
})
