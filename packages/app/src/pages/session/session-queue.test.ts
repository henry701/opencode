import { describe, expect, test } from "bun:test"
import type {
  SessionsQueueEnqueueInput,
  SessionsQueueEnqueueOutput,
  SessionsQueueListOutput,
  SessionsQueueUpdateInput,
} from "@/utils/current-client"
import type { FollowupDraft } from "@/components/prompt-input/submit"
import { createSessionPayload } from "@/components/prompt-input/session-payload"
import { queuedFollowup, saveQueuedFollowup } from "./session-queue"

const draft = (queueID?: string): FollowupDraft => ({
  sessionID: "ses_test",
  sessionDirectory: "/repo",
  prompt: [
    { type: "text", content: "Review ", start: 0, end: 7 },
    { type: "file", path: "src/main.ts", content: "@src/main.ts", start: 7, end: 19 },
    { type: "text", content: " with ", start: 19, end: 25 },
    { type: "agent", name: "build", content: "@build", start: 25, end: 31 },
    {
      type: "image",
      id: "img_1",
      filename: "diagram.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AA==",
    },
  ],
  context: [{ key: "ctx_1", type: "file", path: "src/context.ts" }],
  agent: "plan",
  model: { providerID: "openai", modelID: "gpt-5" },
  variant: "high",
  queueID,
})

describe("session durable queue payload", () => {
  test("preserves the prompt, context, agent, model, and variant", () => {
    const payload = createSessionPayload(draft())

    expect(payload).toMatchObject({
      version: 1,
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
    })
    expect(payload.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "Review @src/main.ts with @build" }),
        expect.objectContaining({ type: "file", filename: "main.ts" }),
        expect.objectContaining({ type: "agent", name: "build" }),
        expect.objectContaining({ type: "file", filename: "diagram.png", url: "data:image/png;base64,AA==" }),
        expect.objectContaining({ type: "file", filename: "context.ts" }),
      ]),
    )
  })

  test("restores an editable followup from a durable queue item", () => {
    const item: SessionsQueueListOutput[number] = {
      id: "msg_queue",
      sessionID: "ses_test",
      position: 0,
      timeCreated: 1,
      payload: createSessionPayload(draft()),
    }

    const restored = queuedFollowup(item, "/repo", "attachment")

    expect(restored.queueID).toBe("msg_queue")
    expect(restored.agent).toBe("plan")
    expect(restored.model).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(restored.variant).toBe("high")
    expect(restored.prompt.map((part) => ("content" in part ? part.content : part.filename)).join("")).toBe(
      "Review @src/main.ts with @builddiagram.png",
    )
    expect(restored.context).toEqual([
      expect.objectContaining({ type: "file", path: "src/context.ts" }),
    ])
  })

  test("retains hidden parts and execution controls when an item is edited", () => {
    const original = createSessionPayload(draft())
    const payload = createSessionPayload({
      ...draft("msg_queue"),
      prompt: [{ type: "text", content: "Edited", start: 0, end: 6 }],
      context: [],
      queuePayload: {
        ...original,
        tools: { bash: false },
        system: "exact system",
        format: { type: "json_schema", schema: { type: "object" } },
        permissions: [{ permission: "bash", pattern: "*", action: "deny" }],
        parts: [
          { type: "text", text: "hidden", synthetic: true },
          { type: "text", text: "ignored", ignored: true },
          {
            type: "subtask",
            prompt: "delegate",
            description: "delegate work",
            agent: "reviewer",
          },
          ...original.parts,
        ],
      },
    })

    expect(payload).toMatchObject({
      tools: { bash: false },
      system: "exact system",
      format: { type: "json_schema", schema: { type: "object" } },
      permissions: [{ permission: "bash", pattern: "*", action: "deny" }],
    })
    expect(payload.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "hidden", synthetic: true }),
        expect.objectContaining({ type: "text", text: "ignored", ignored: true }),
        expect.objectContaining({ type: "subtask", prompt: "delegate", agent: "reviewer" }),
        expect.objectContaining({ type: "text", text: "Edited" }),
      ]),
    )
  })
})

describe("session durable queue save", () => {
  test("enqueues a new draft without resuming an idle drain", async () => {
    const calls: SessionsQueueEnqueueInput[] = []
    const queued = {
      id: "msg_queue",
      sessionID: "ses_test",
      position: 0,
      timeCreated: 1,
      payload: createSessionPayload(draft()),
    } satisfies SessionsQueueEnqueueOutput

    await saveQueuedFollowup({
      client: {
        queueEnqueue: async (input) => {
          calls.push(input)
          return queued
        },
        queueUpdate: async () => undefined,
        queueDrainResume: async () => undefined,
      },
      draft: draft(),
    })

    expect(calls).toEqual([
      expect.objectContaining({
        sessionID: "ses_test",
        payload: expect.objectContaining({ agent: "plan" }),
      }),
    ])
    expect(calls[0]).not.toHaveProperty("resume")
  })

  test("updates an edited item before resuming the server drain", async () => {
    const calls: Array<SessionsQueueUpdateInput | { sessionID: string; resume: true }> = []

    await saveQueuedFollowup({
      client: {
        queueEnqueue: async () => {
          throw new Error("unexpected enqueue")
        },
        queueUpdate: async (input) => {
          calls.push(input)
        },
        queueDrainResume: async (input) => {
          calls.push({ ...input, resume: true })
        },
      },
      draft: draft("msg_queue"),
    })

    expect(calls).toEqual([
      expect.objectContaining({ sessionID: "ses_test", messageID: "msg_queue" }),
      { sessionID: "ses_test", resume: true },
    ])
  })

  test("expands a recognized queued slash command exactly once through the current command API", async () => {
    const calls: unknown[] = []

    await saveQueuedFollowup({
      client: {
        command: async (input) => {
          calls.push(input)
          return {
            id: "msg_command",
            sessionID: "ses_test",
            prompt: { text: "/review now" },
            payload: createSessionPayload(draft()),
            delivery: "queue",
            admittedSeq: 1,
            timeCreated: 1,
          }
        },
        queueEnqueue: async () => {
          throw new Error("unexpected generic enqueue")
        },
        queueUpdate: async () => undefined,
        queueDrainResume: async () => undefined,
      },
      draft: {
        ...draft(),
        command: { name: "review", arguments: "now" },
      },
    })

    expect(calls).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^msg_/),
        sessionID: "ses_test",
        name: "review",
        arguments: "now",
        delivery: "queue",
      }),
    ])
    expect(calls[0]).not.toHaveProperty("resume")
  })

  test("updates an already-expanded queued command without running command expansion again", async () => {
    const calls: string[] = []

    await saveQueuedFollowup({
      client: {
        command: async () => {
          calls.push("command")
          throw new Error("unexpected command expansion")
        },
        queueEnqueue: async () => {
          calls.push("enqueue")
          throw new Error("unexpected enqueue")
        },
        queueUpdate: async () => {
          calls.push("update")
        },
        queueDrainResume: async () => {
          calls.push("resume")
        },
      },
      draft: {
        ...draft("msg_queue"),
        command: { name: "review", arguments: "now" },
      },
    })

    expect(calls).toEqual(["update", "resume"])
  })
})
