import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SessionRollbackQueueRegression"
const projectID = "proj_session_rollback_queue_regression"
const sessionID = "ses_session_rollback_queue_regression"
const queuedText = "queued prompt should survive rollback"

const model = { providerID: "opencode", modelID: "test-model" }

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
    id: "msg_user_0001",
    type: "user" as const,
    text: "first user prompt",
    files: [],
    agents: [],
    time: { created: 1700000000000 },
    payload: {
      version: 1 as const,
      agent: "build",
      model,
      parts: [{ id: "prt_user_0001", type: "text" as const, text: "first user prompt" }],
    },
  },
  {
    id: "msg_assistant_0001",
    type: "assistant" as const,
    time: { created: 1700000001000, completed: 1700000002000 },
    agent: "build",
    model: { providerID: model.providerID, id: model.modelID },
    cost: 0.01,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ id: "prt_assistant_0001", type: "text" as const, text: "assistant response" }],
  },
  {
    id: "msg_user_0002",
    type: "user" as const,
    text: "second user prompt",
    files: [],
    agents: [],
    time: { created: 1700000003000 },
    payload: {
      version: 1 as const,
      agent: "build",
      model,
      parts: [{ id: "prt_user_0002", type: "text" as const, text: "second user prompt" }],
    },
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
    queue: { [sessionID]: [{ id: "msg_queue_web_rollback", text: queuedText }] },
    currentPageMessages: () => ({ items: messages.toReversed(), throughSeq: 0 }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)
  await expectAppVisible(page.locator('[data-component="session-followup-dock"]'))
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(queuedText)

  await page.getByRole("button", { name: "Revert message", exact: true }).first().click({ force: true })

  await expectAppVisible(page.locator('[data-component="session-revert-dock"]'))
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(queuedText)
})
