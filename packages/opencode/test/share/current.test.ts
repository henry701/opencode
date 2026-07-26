import { beforeEach, describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSharing } from "@opencode-ai/core/session/share"
import { SessionStore } from "@opencode-ai/core/session/store"
import { DateTime, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { SessionSharingCurrent } from "@/share/current"
import { ShareTransport } from "@/share/transport"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const synced: ShareTransport.Data[][] = []
const shared = new Set<string>()
const transport = Layer.succeed(
  ShareTransport.Service,
  ShareTransport.Service.of({
    init: () => Effect.void,
    url: () => Effect.succeed("https://share.example.com"),
    request: () => Effect.die("not used"),
    create: (sessionID) =>
      Effect.sync(() => {
        shared.add(sessionID)
        return { id: "shr_current", url: "https://share.example.com/s/current", secret: "secret" }
      }),
    sync: (sessionID, data) =>
      Effect.sync(() => {
        if (shared.has(sessionID)) synced.push(data)
      }),
    remove: (sessionID) =>
      Effect.sync(() => {
        shared.delete(sessionID)
      }),
  }),
)
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    get: () => Effect.succeed({}),
    getGlobal: () => Effect.succeed({}),
    getConsoleState: () => Effect.die("not used"),
    update: () => Effect.die("not used"),
    updateGlobal: () => Effect.die("not used"),
    invalidate: () => Effect.die("not used"),
    directories: () => Effect.die("not used"),
    waitForDependencies: () => Effect.die("not used"),
  }),
)
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      SessionSharingCurrent.node,
    ]),
    [
      [Config.node, config],
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [ShareTransport.node, transport],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = {
  id: ModelV2.ID.make("model"),
  providerID: ProviderV2.ID.make("provider"),
  variant: ModelV2.VariantID.make("default"),
}

beforeEach(async () => {
  synced.length = 0
  shared.clear()
  await resetDatabase()
})

describe("SessionSharingCurrent", () => {
  it.effect("syncs current history, live updates, and redacts prepared context", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const sharing = yield* SessionSharing.Service
      const session = yield* sessions.create({ title: "current share", location })
      const userID = SessionMessage.ID.create()
      const assistantID = SessionMessage.ID.create()
      const timestamp = DateTime.makeUnsafe(1)

      yield* events.publish(SessionEvent.Prompted, {
        sessionID: session.id,
        messageID: userID,
        timestamp,
        prompt: Prompt.make({ text: "hello current share" }),
        delivery: "steer",
      })
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: session.id,
        assistantMessageID: assistantID,
        timestamp,
        agent: AgentV2.ID.make("build"),
        model,
        systemPrompt: "private system prompt",
        toolDefinitions: "private tool definitions",
      })
      yield* events.publish(SessionEvent.Text.Started, {
        sessionID: session.id,
        assistantMessageID: assistantID,
        timestamp,
        textID: "text-1",
      })
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: session.id,
        assistantMessageID: assistantID,
        timestamp,
        textID: "text-1",
        text: "initial response",
      })

      const info = yield* sharing.share(session.id)

      expect(info.share?.url).toBe("https://share.example.com/s/current")
      expect(synced).toHaveLength(1)
      expect(synced[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session",
            data: expect.objectContaining({ id: session.id, title: "current share" }),
          }),
          expect.objectContaining({
            type: "message",
            data: expect.objectContaining({ id: userID, type: "user", text: "hello current share" }),
          }),
          expect.objectContaining({
            type: "message",
            data: expect.objectContaining({
              id: assistantID,
              type: "assistant",
              content: [expect.objectContaining({ type: "text", text: "initial response" })],
            }),
          }),
        ]),
      )
      const initialAssistant = synced[0]
        ?.find((item) => item.type === "message" && item.data.id === assistantID)
        ?.data as Record<string, unknown>
      expect(initialAssistant.systemPrompt).toBeUndefined()
      expect(initialAssistant.toolDefinitions).toBeUndefined()

      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: session.id,
        assistantMessageID: assistantID,
        timestamp: DateTime.makeUnsafe(2),
        textID: "text-1",
        text: "live response",
      })

      expect(synced).toHaveLength(2)
      const liveAssistant = synced[1]
        ?.find((item) => item.type === "message" && item.data.id === assistantID)
        ?.data as Record<string, unknown>
      expect(liveAssistant.systemPrompt).toBeUndefined()
      expect(liveAssistant.toolDefinitions).toBeUndefined()
      expect(liveAssistant.content).toEqual([
        expect.objectContaining({ type: "text", text: "live response" }),
      ])
    }),
  )
})
