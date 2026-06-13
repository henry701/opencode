import { expect, test } from "@playwright/test"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"
import { pathKey } from "@/utils/path-key"

const directory = "C:/OpenCode/SessionRollbackQueueRegression"
const projectID = "proj_session_rollback_queue_regression"
const sessionID = "ses_session_rollback_queue_regression"
const queuedText = "queued prompt should survive rollback"

const model = { providerID: "opencode", modelID: "test-model" }
const key = pathKey(directory)
const storageHead = (key.slice(0, 12) || "workspace").replace(/[^a-zA-Z0-9._-]/g, "-")
const followupStorageKey = `opencode.workspace.${storageHead}.${checksum(key)}.dat:workspace:followup`

const session = {
  id: sessionID,
  slug: "session-rollback-queue-regression",
  projectID,
  directory,
  title: "Session rollback queue regression",
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
}

const messages = [
  {
    info: {
      id: "msg_user_0001",
      sessionID,
      role: "user",
      time: { created: 1700000000000 },
      agent: "build",
      model,
    },
    parts: [
      {
        id: "prt_user_0001",
        sessionID,
        messageID: "msg_user_0001",
        type: "text",
        text: "first user prompt",
      },
    ],
  },
  {
    info: {
      id: "msg_assistant_0001",
      sessionID,
      role: "assistant",
      parentID: "msg_user_0001",
      time: { created: 1700000001000, completed: 1700000002000 },
      agent: "build",
      providerID: model.providerID,
      modelID: model.modelID,
      path: { cwd: directory, root: directory },
      cost: 0.01,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "prt_assistant_0001",
        sessionID,
        messageID: "msg_assistant_0001",
        type: "text",
        text: "assistant response",
      },
    ],
  },
  {
    info: {
      id: "msg_user_0002",
      sessionID,
      role: "user",
      time: { created: 1700000003000 },
      agent: "build",
      model,
    },
    parts: [
      {
        id: "prt_user_0002",
        sessionID,
        messageID: "msg_user_0002",
        type: "text",
        text: "second user prompt",
      },
    ],
  },
]

test("preserves visible queued follow-ups when rolling back a message", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-rollback-queue-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "test-model": { id: "test-model", name: "Test Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: model,
    },
    sessions: [session],
    status: { [sessionID]: { type: "busy" } },
    pageMessages: () => ({ items: messages }),
  })

  await page.addInitScript(
    ({ directory, sessionID, queuedText, followupStorageKey }) => {
      localStorage.setItem(
        followupStorageKey,
        JSON.stringify({
          items: {
            [sessionID]: [
              {
                id: "pqu_web_rollback",
                sessionID,
                sessionDirectory: directory,
                prompt: [{ type: "text", content: queuedText }],
                context: [],
                agent: "build",
                model: { providerID: "opencode", modelID: "test-model" },
              },
            ],
          },
          failed: {},
          paused: { [sessionID]: true },
          edit: {},
        }),
      )
    },
    { directory, sessionID, queuedText, followupStorageKey },
  )

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)
  await expectAppVisible(page.locator('[data-component="session-followup-dock"]'))
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(queuedText)

  await page.getByRole("button", { name: "Revert message" }).first().click({ force: true })

  await expectAppVisible(page.locator('[data-component="session-revert-dock"]'))
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(queuedText)
  await expect
    .poll(() =>
      page.evaluate(({ sessionID, queuedText, followupStorageKey }) => {
        const raw = localStorage.getItem(followupStorageKey)
        if (!raw) return false
        const parsed = JSON.parse(raw) as { items?: Record<string, Array<{ id: string; prompt: unknown[] }>> }
        const item = parsed.items?.[sessionID]?.find((entry) => entry.id === "pqu_web_rollback")
        return JSON.stringify(item?.prompt).includes(queuedText)
      }, { sessionID, queuedText, followupStorageKey }),
    )
    .toBe(true)
})
