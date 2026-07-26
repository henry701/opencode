import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { Tool } from "../../tool/tool"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { SessionMessage } from "../message"
import { SessionV1 } from "../../v1/session"
import { InstallationVersion } from "../../installation/version"
import { Slug } from "../../util/slug"
import { SessionRevert } from "../revert"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const configEntries = yield* config.entries()
    const compaction = SessionCompaction.make({ events, llm, config: configEntries })
    const subagentDepth = Config.latest(configEntries, "subagent_depth") ?? 1
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          if (tool.name === "task") continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const createChild = Effect.fn("SessionRunner.createChild")(function* (input: {
      parent: SessionSchema.Info
      sessionID: SessionSchema.ID
      agent: string
      model: SessionInputPayload.Payload["model"]
      title: string
    }) {
      const existing = yield* store.get(input.sessionID)
      if (existing) return existing
      const now = Date.now()
      const info = SessionV1.SessionInfo.make({
        id: input.sessionID,
        slug: Slug.create(),
        version: InstallationVersion,
        projectID: input.parent.projectID,
        parentID: input.parent.id,
        directory: input.parent.location.directory,
        path: input.parent.subpath ?? "",
        workspaceID: input.parent.location.workspaceID,
        title: input.title,
        agent: AgentV2.ID.make(input.agent),
        model: {
          providerID: input.model.providerID,
          id: ModelV2.ID.make(input.model.modelID),
          variant: input.model.variant,
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      })
      yield* events.publish(
        SessionV1.Event.Created,
        { sessionID: input.sessionID, info },
        { location: input.parent.location },
      )
      const child = yield* store.get(input.sessionID)
      if (!child) return yield* Effect.die(`Child Session was not projected: ${input.sessionID}`)
      return child
    })

    const executeChild = Effect.fn("SessionRunner.executeChild")(function* (input: {
      parent: SessionSchema.Info
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      agent: string
      model: SessionInputPayload.Payload["model"]
      title: string
      prompt: string
      execution: {
        readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
        readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
      }
    }) {
      let current = input.parent
      let depth = 0
      while (current.parentID) {
        depth++
        const parent = yield* store.get(current.parentID)
        if (!parent) return yield* Effect.fail(new Error(`Parent Session not found: ${current.parentID}`))
        current = parent
      }
      if (depth >= subagentDepth)
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${subagentDepth}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )

      const existing = yield* store.get(input.sessionID)
      if (
        existing &&
        (existing.parentID !== input.parent.id ||
          existing.location.directory !== input.parent.location.directory ||
          existing.location.workspaceID !== input.parent.location.workspaceID)
      )
        return yield* Effect.fail(
          new Error(`Task ${input.sessionID} does not belong to Session ${input.parent.id} in this Location`),
        )
      yield* createChild({
        parent: input.parent,
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        title: input.title,
      })
      if (!(yield* SessionInput.find(db, input.messageID))) {
        const payload = SessionInputPayload.Payload.make({
          version: 1,
          agent: input.agent,
          model: input.model,
          parts: [SessionInputPayload.TextPart.make({ type: "text", text: input.prompt })],
        })
        yield* SessionInput.admit(db, events, {
          id: input.messageID,
          sessionID: input.sessionID,
          prompt: SessionInputPayload.toPrompt(payload),
          payload,
          delivery: "steer",
        })
      }
      yield* input.execution
        .resume(input.sessionID)
        .pipe(Effect.onInterrupt(() => input.execution.interrupt(input.sessionID)))
      return {
        sessionID: input.sessionID,
        result: (yield* getContext(input.sessionID))
          .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
          .flatMap((message) =>
            message.content.flatMap((item) => (item.type === "text" && item.text.trim() ? [item.text] : [])),
          )
          .join("\n")
          .trim(),
      }
    })

    const runSubtask = Effect.fn("SessionRunner.runSubtask")(function* (input: {
      session: SessionSchema.Info
      payload: SessionInputPayload.Payload
      user: SessionMessage.User
      part: SessionInputPayload.Part & { type: "subtask" }
      execution: {
        readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
        readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
        readonly queueDrainPaused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
      }
    }) {
      const callID = `subtask_${input.user.id}`
      const recorded = (yield* getContext(input.session.id))
        .filter((message): message is SessionMessage.Assistant => message.type === "assistant")
        .flatMap((message) =>
          message.content.flatMap((item) => (item.type === "tool" && item.id === callID ? [{ message, item }] : [])),
        )
        .at(-1)
      if (recorded?.item.state.status === "completed" || recorded?.item.state.status === "error") return false

      const childSessionID =
        recorded?.item.state.status === "running" && typeof recorded.item.state.input.sessionID === "string"
          ? SessionSchema.ID.make(recorded.item.state.input.sessionID)
          : SessionSchema.ID.create()
      const childMessageID =
        recorded?.item.state.status === "running" && typeof recorded.item.state.input.messageID === "string"
          ? SessionMessage.ID.make(recorded.item.state.input.messageID)
          : SessionMessage.ID.create()
      const assistantMessageID = recorded?.message.id ?? SessionMessage.ID.create()
      const childModel = input.part.model ?? input.payload.model
      const toolInput = {
        sessionID: childSessionID,
        messageID: childMessageID,
        agent: input.part.agent,
        description: input.part.description,
        command: input.part.command,
        prompt: input.part.prompt,
      }
      if (!recorded) {
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          agent: input.payload.agent,
          model: {
            providerID: input.payload.model.providerID,
            id: ModelV2.ID.make(input.payload.model.modelID),
            variant: input.payload.model.variant,
          },
        })
        yield* events.publish(SessionEvent.Tool.Input.Started, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          name: "task",
        })
        yield* events.publish(SessionEvent.Tool.Input.Ended, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          text: JSON.stringify(toolInput),
        })
        yield* events.publish(SessionEvent.Tool.Called, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          tool: "task",
          input: toolInput,
          provider: { executed: false },
        })
      }

      const childExit = yield* executeChild({
        parent: input.session,
        sessionID: childSessionID,
        messageID: childMessageID,
        agent: input.part.agent,
        model: childModel,
        title: input.part.description || `Task from ${input.session.id}`,
        prompt: input.part.prompt,
        execution: input.execution,
      }).pipe(Effect.exit)
      if (childExit._tag === "Failure") {
        if (Cause.hasInterrupts(childExit.cause)) return yield* Effect.interrupt
        const error = Cause.squash(childExit.cause)
        yield* events.publish(SessionEvent.Tool.Failed, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          error: { type: "unknown", message: error instanceof Error ? error.message : String(error) },
          provider: { executed: false },
        })
      } else {
        yield* events.publish(SessionEvent.Tool.Success, {
          sessionID: input.session.id,
          timestamp: yield* DateTime.now,
          assistantMessageID,
          callID,
          structured: childExit.value,
          content: [{ type: "text", text: childExit.value.result }],
          result: childExit.value.result,
          provider: { executed: false },
        })
      }
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: input.session.id,
        timestamp: yield* DateTime.now,
        assistantMessageID,
        finish: "tool-calls",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      return true
    })

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      execution: {
        readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
        readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
        readonly queueDrainPaused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
      },
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      const cutoff = promotion ? yield* EventV2.latestSequence(db, session.id) : undefined
      const pending =
        promotion && cutoff !== undefined
          ? yield* SessionInput.nextForPromotion(db, session.id, promotion, cutoff)
          : undefined
      if (pending !== undefined && session.revert)
        yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
      const contextBeforePromotion = yield* getContext(session.id)
      const payload =
        pending === undefined
          ? contextBeforePromotion.findLast((message) => message.type === "user")?.payload
          : pending.payload
      const selectedSession =
        payload === undefined
          ? session
          : {
              ...session,
              agent: AgentV2.ID.make(payload.agent),
              model: {
                providerID: payload.model.providerID,
                id: payload.model.modelID,
                ...(payload.model.variant === undefined ? {} : { variant: payload.model.variant }),
              },
            }
      const agent = yield* agents.select(selectedSession.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      if (promotion && cutoff !== undefined) {
        let promoted = 0
        if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id, cutoff))
          promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
        if (promoted > 0) currentStep = 1
      }
      const user = (yield* getContext(session.id)).findLast(
        (message): message is SessionMessage.User => message.type === "user",
      )
      const subtask = payload?.parts.find(
        (part): part is SessionInputPayload.Part & { type: "subtask" } => part.type === "subtask",
      )
      if (
        payload &&
        user &&
        subtask &&
        (yield* runSubtask({
          session,
          payload,
          user,
          part: subtask,
          execution,
        }))
      )
        return { needsContinuation: true, step: currentStep }
      const model = yield* models.resolve(selectedSession)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const history = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const permissions = [
        ...(agent.info?.permissions ?? []),
        ...(payload?.permissions?.map((permission) => ({
          action: permission.permission,
          resource: permission.pattern,
          effect: permission.action,
        })) ?? []),
      ]
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize(permissions)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        providerOptions: { openai: { promptCacheKey } },
        system: [agent.info?.system, payload?.system, system.baseline]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(history, model), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools:
          toolMaterialization?.definitions.filter((definition) => payload?.tools?.[definition.name] !== false) ?? [],
        toolChoice: isLastStep ? "none" : undefined,
        responseFormat:
          payload?.format?.type === "json_schema"
            ? { type: "json", schema: payload.format.schema }
            : payload?.format?.type === "text"
              ? { type: "text" }
              : undefined,
      })
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(selectedSession.model?.variant === undefined ? {} : { variant: selectedSession.model.variant }),
        },
        snapshot: startSnapshot,
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm
        .stream(request, {
          onPrepared: (prepared) => {
            const systemPrompt = prepared.metadata?.systemPrompt
            const toolDefinitions = prepared.metadata?.toolDefinitions
            return publisher.setPreparedContext({
              ...(typeof systemPrompt === "string" ? { systemPrompt } : {}),
              ...(typeof toolDefinitions === "string" ? { toolDefinitions } : {}),
            })
          },
        })
        .pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (overflowFailure || publisher.hasProviderError()) return
              if (LLMEvent.is.providerError(event)) {
                if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                  overflowFailure = event
                  return
                }
              }
              yield* publish(event)
              if (event.type !== "tool-call" || event.providerExecuted) return
              if (!toolMaterialization) {
                yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
                return
              }
              needsContinuation = true
              const assistantMessageID = yield* publisher.assistantMessageID(event.id)
              yield* Effect.uninterruptibleMask((restore) =>
                restore(
                  toolMaterialization.settle({
                    sessionID: session.id,
                    agent: agent.id,
                    assistantMessageID,
                    call: event,
                    task: (input) =>
                      Effect.gen(function* () {
                        const childAgent = yield* agents.get(AgentV2.ID.make(input.subagentType))
                        if (!childAgent)
                          return yield* Effect.fail(
                            new Tool.Failure({ message: `Unknown subagent type: ${input.subagentType}` }),
                          )
                        const model = childAgent.model ?? selectedSession.model
                        if (!model)
                          return yield* Effect.fail(
                            new Tool.Failure({ message: "No model selected for subagent task" }),
                          )
                        return yield* executeChild({
                          parent: session,
                          sessionID: input.taskID ? SessionSchema.ID.make(input.taskID) : SessionSchema.ID.create(),
                          messageID: SessionMessage.ID.create(),
                          agent: childAgent.id,
                          model: {
                            providerID: model.providerID,
                            modelID: model.id,
                            variant: model.variant,
                          },
                          title: input.description || `Task from ${session.id}`,
                          prompt: input.prompt,
                          execution,
                        }).pipe(
                          Effect.mapError(
                            (error) =>
                              new Tool.Failure({
                                message: error instanceof Error ? error.message : String(error),
                              }),
                          ),
                        )
                      }),
                    transition: (input) =>
                      Effect.gen(function* () {
                        const messageID = SessionMessage.ID.create()
                        const timestamp = yield* DateTime.now
                        const transitionModel = {
                          providerID: ProviderV2.ID.make(model.provider),
                          modelID: ModelV2.ID.make(model.id),
                          ...(selectedSession.model?.variant === undefined
                            ? {}
                            : { variant: selectedSession.model.variant }),
                        }
                        const payload = SessionInputPayload.Payload.make({
                          version: 1,
                          agent: input.agent,
                          model: transitionModel,
                          parts: [
                            SessionInputPayload.TextPart.make({ type: "text", text: input.text, synthetic: true }),
                          ],
                        })
                        yield* events.publish(SessionEvent.AgentSwitched, {
                          sessionID: session.id,
                          messageID: SessionMessage.ID.create(),
                          timestamp,
                          agent: input.agent,
                        })
                        yield* SessionInput.admit(db, events, {
                          id: messageID,
                          sessionID: session.id,
                          prompt: SessionInputPayload.toPrompt(payload),
                          payload,
                          delivery: "steer",
                        })
                      }),
                  }),
                ).pipe(
                  Effect.flatMap((settlement) =>
                    publish(
                      LLMEvent.toolResult({
                        id: event.id,
                        name: event.name,
                        result: settlement.result,
                        output: settlement.output,
                      }),
                      settlement.outputPaths ?? [],
                    ),
                  ),
                ),
              ).pipe(FiberSet.run(toolFibers))
            }),
          ),
          Effect.ensuring(withPublication(publisher.flush())),
        )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(publisher.failAssistant({ type: "unknown", message: llmFailure.reason.message }))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            if (publisher.hasActiveAssistant())
              yield* withPublication(
                publisher.failAssistant({ type: "interrupted", message: "Provider turn interrupted" }),
              )
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`))
          }
          const stepSettlement = publisher.stepSettlement()
          if (stepSettlement && !publisher.hasProviderError()) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            const diffs =
              startSnapshot && endSnapshot
                ? yield* snapshots.diff({ from: startSnapshot, to: endSnapshot }).pipe(
                    Effect.map((items) =>
                      items.map((item) => ({
                        file: item.path,
                        patch: item.patch,
                        additions: item.additions,
                        deletions: item.deletions,
                        status: item.status,
                      })),
                    ),
                    Effect.catch(() => Effect.succeed(undefined)),
                  )
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                finish: stepSettlement.finish,
                cost: 0,
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
                diffs,
              }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          if (stream._tag === "Failure") return yield* Effect.failCause(stream.cause)
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      execution: {
        readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
        readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
        readonly queueDrainPaused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
      },
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, execution) {
      return yield* runTurnAttempt(sessionID, promotion, step, execution).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, execution)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, execution) {
      return yield* runTurnAttempt(sessionID, promotion, step, execution, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, execution)
            return yield* runTurn(sessionID, undefined, defect.transition.step, execution)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly execution: {
        readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, RunError>
        readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
        readonly queueDrainPaused: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
      }
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue =
        hasSteer || (yield* input.execution.queueDrainPaused(input.sessionID))
          ? false
          : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          if (promotion === "queue" && (yield* input.execution.queueDrainPaused(input.sessionID))) return
          const result = yield* runTurn(input.sessionID, promotion, step, input.execution)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun =
          !(yield* input.execution.queueDrainPaused(input.sessionID)) &&
          (yield* SessionInput.hasPending(db, input.sessionID, "queue"))
        promotion = shouldRun ? "queue" : undefined
      }
    })
    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
  ],
})
