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
  const prompts: unknown[] = []
  const stages: unknown[] = []
  page.on("request", (request) => {
    if (request.url().endsWith("/revert/stage")) stages.push(request.postDataJSON())
  })
  await mockOpenCodeServer(page, {
    onPrompt: ({ body }) => prompts.push(body),
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
    sessions: [{ ...session }],
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
  await expect(page.locator('[data-component="session-revert-dock"]')).toContainText("first user prompt")
  const input = page.locator('[data-component="prompt-input"]')
  await expect(input).toContainText("first user prompt")
  await input.fill("edited first user prompt")
  await input.press("Enter")
  await expect.poll(() => prompts.length).toBe(1)
  expect(stages).toEqual([
    { messageID: "msg_user_0001", inclusive: true },
    { messageID: "msg_user_0001", inclusive: true },
  ])
  expect(prompts[0]).toMatchObject({
    payload: { parts: [expect.objectContaining({ type: "text", text: "edited first user prompt" })] },
  })
  await expect(page.locator('[data-component="session-followup-dock"]')).toContainText(queuedText)
})

test("does not stage rollback when inference interruption fails", async ({ page }) => {
  let staged = 0
  await mockOpenCodeServer(page, {
    directory,
    project: { id: projectID, worktree: directory, time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "test-model": { id: "test-model", name: "Test Model" } } }],
      connected: ["opencode"],
      default: model,
    },
    sessions: [{ ...session }],
    status: { [sessionID]: { type: "busy" } },
    currentPageMessages: () => ({ items: messages.toReversed(), throughSeq: 0 }),
  })
  page.on("request", (request) => {
    if (request.url().endsWith("/revert/stage")) staged++
  })
  await page.route(/\/interrupt(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "UnknownError", message: "Cannot interrupt", ref: "test" }),
    }),
  )
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)
  const input = page.locator('[data-component="prompt-input"]')
  await input.fill("Keep my existing draft")
  await page.getByRole("button", { name: "Revert message", exact: true }).first().click({ force: true })
  await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
  expect(staged).toBe(0)
  await expect(input).toContainText("Keep my existing draft")
  await expect(page.locator('[data-component="session-revert-dock"]')).toHaveCount(0)
})

test("command undo and redo use the current pending input and replacement draft", async ({ page }) => {
  const stages: unknown[] = []
  let cleared = 0
  await mockOpenCodeServer(page, {
    directory,
    findFiles: () => [],
    fileList: () => [],
    project: { id: projectID, worktree: directory, time: { created: 1, updated: 1 }, sandboxes: [] },
    provider: {
      all: [{ id: "opencode", name: "OpenCode", models: { "test-model": { id: "test-model", name: "Test Model" } } }],
      connected: ["opencode"],
      default: model,
    },
    sessions: [{ ...session }],
    currentPageMessages: () => ({
      items: messages.slice(0, 2).toReversed(),
      throughSeq: 5,
      pending: [messages[2]!],
    }),
  })
  page.on("request", (request) => {
    if (request.url().endsWith("/revert/stage")) stages.push(request.postDataJSON())
    if (request.url().endsWith("/revert/clear")) cleared++
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)
  await expect(page.getByText("second user prompt", { exact: true })).toHaveCount(1)
  const select = async (command: string) => {
    await page.keyboard.press("Control+p")
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("textbox").fill(command)
    await dialog.getByText(command, { exact: true }).click()
  }
  const input = page.locator('[data-component="prompt-input"]')
  await select("Undo")
  await expect(input).toContainText("second user prompt")
  await expect(page.locator('[data-component="session-revert-dock"]')).toContainText("second user prompt")
  expect(stages).toEqual([{ messageID: "msg_user_0002", inclusive: true }])
  await select("Redo")
  await expect.poll(() => cleared).toBe(1)
  await expect(input).toHaveText("")
  await expect(page.locator('[data-component="session-revert-dock"]')).toHaveCount(0)
  await expect(page.getByText("second user prompt", { exact: true })).toHaveCount(1)
})
