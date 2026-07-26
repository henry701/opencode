import { SessionV2 } from "@opencode-ai/core/session"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@opencode-ai/protocol/groups/session"
import {
  AgentNotFoundError,
  CommandNotFoundError,
  ConflictError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  QueueItemNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSharing } from "@opencode-ai/core/session/share"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const sharing = yield* SessionSharing.Service

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.update",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .update({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .fork({ sessionID: ctx.params.sessionID, messageID: ctx.payload.messageID })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag("Session.MessageDecodeError", (error) => {
                  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                  return Effect.logError("failed to decode session message while forking").pipe(
                    Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                    Effect.andThen(
                      Effect.fail(
                        new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                      ),
                    ),
                  )
                }),
              ),
          }
        }),
      )
      .handle(
        "session.share",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.mapError(
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return {
            data: yield* sharing.share(ctx.params.sessionID).pipe(
              Effect.mapError(
                () => new ServiceUnavailableError({ service: "session.share", message: "Session sharing unavailable" }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.unshare",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.mapError(
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return {
            data: yield* sharing.unshare(ctx.params.sessionID).pipe(
              Effect.mapError(
                () =>
                  new ServiceUnavailableError({ service: "session.unshare", message: "Session sharing unavailable" }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          if ((ctx.payload.prompt === undefined) === (ctx.payload.payload === undefined))
            return yield* new InvalidRequestError({ message: "Exactly one of prompt or payload is required" })
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                ...(ctx.payload.payload === undefined
                  ? { prompt: ctx.payload.prompt! }
                  : { payload: ctx.payload.payload }),
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .command({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                name: ctx.payload.name,
                arguments: ctx.payload.arguments,
                payload: ctx.payload.payload,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Command message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
                Effect.catchTag("Command.NotFoundError", (error) =>
                  Effect.fail(
                    new CommandNotFoundError({
                      command: error.command,
                      available: error.available,
                      message: `Command not found: ${error.command}`,
                    }),
                  ),
                ),
                Effect.catchTag("Agent.NotFoundError", (error) =>
                  Effect.fail(
                    new AgentNotFoundError({
                      agent: error.agent,
                      available: error.available,
                      message: `Agent not found: ${error.agent}`,
                    }),
                  ),
                ),
                Effect.catchTag("Command.EvaluationError", (error) =>
                  Effect.fail(
                    new ServiceUnavailableError({
                      message: error.message,
                      service: `command.${error.command}`,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.queueList",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.queue.list(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.queueEnqueue",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.queue
              .enqueue({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                payload: ctx.payload.payload,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag(
                  "Session.PromptConflictError",
                  (error) =>
                    new ConflictError({
                      message: `Queue message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.queueDrainPause",
        Effect.fn(function* (ctx) {
          yield* session.queue.pauseDrain(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.queueDrainResume",
        Effect.fn(function* (ctx) {
          yield* session.queue.resumeDrain(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.queueGet",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.queue.get(ctx.params).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.QueueItemNotFoundError",
                (error) =>
                  new QueueItemNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Queued input not found: ${error.messageID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.queueUpdate",
        Effect.fn(function* (ctx) {
          yield* session.queue.update({ ...ctx.params, payload: ctx.payload.payload }).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.QueueItemNotFoundError",
              (error) =>
                new QueueItemNotFoundError({
                  sessionID: error.sessionID,
                  messageID: error.messageID,
                  message: `Queued input not found: ${error.messageID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.queueRemove",
        Effect.fn(function* (ctx) {
          yield* session.queue.remove(ctx.params).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag(
              "Session.QueueItemNotFoundError",
              (error) =>
                new QueueItemNotFoundError({
                  sessionID: error.sessionID,
                  messageID: error.messageID,
                  message: `Queued input not found: ${error.messageID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.queueSend",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.queue.send({ ...ctx.params, payload: ctx.payload.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.QueueItemNotFoundError",
                (error) =>
                  new QueueItemNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Queued input not found: ${error.messageID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session.shell({ sessionID: ctx.params.sessionID, command: ctx.payload.command }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: "Unexpected server error. Check server logs for details.",
                      ref,
                    }),
                  ),
                ),
              )
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* session.interrupt(ctx.params.sessionID)
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)
