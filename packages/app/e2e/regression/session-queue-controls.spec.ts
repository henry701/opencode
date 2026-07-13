import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/SessionQueueControlsRegression"
const projectID = "proj_session_queue_controls_regression"
const sessionID = "ses_session_queue_controls_regression"
const queuedText = "queue this via alt enter"
const model = { providerID: "opencode", modelID: "test-model" }

const session = {
  id: sessionID,
  slug: "session-queue-controls-regression",
  projectID,
  directory,
  title: "Session queue controls regression",
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
}

test("shows explicit queue controls and queues with Alt+Enter", async ({ page }) => {
  const queueRequests: string[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/session/${sessionID}/queue` && request.method() === "POST") {
      queueRequests.push(request.postData() ?? "")
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-queue-controls-regression",
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
    pageMessages: () => ({ items: [] }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)

  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  const queue = composer.getByRole("button", { name: "Queue" })
  await expect(queue).toBeVisible()
  await queue.hover()
  await expect(page.getByText("Alt", { exact: true })).toBeVisible()
  await expect(page.getByText("Enter", { exact: true })).toBeVisible()

  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill(queuedText)
  await input.press("Alt+Enter")

  await expect.poll(() => queueRequests.length).toBe(1)
  expect(queueRequests[0]).toContain(queuedText)
})

test("sends queued follow-ups with an explicit JSON body", async ({ page }) => {
  const sends: Array<{ sessionID: string; queueID: string; raw: string | null; body: unknown }> = []

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-queue-controls-regression",
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
    queue: { [sessionID]: [{ id: "pqu_send_now", text: "send this queued prompt now" }] },
    pageMessages: () => ({ items: [] }),
    onQueueSend: (input) => sends.push(input),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)

  const followupDock = page.locator('[data-component="session-followup-dock"]')
  await expectAppVisible(followupDock)
  await followupDock.getByRole("button", { name: "Send now" }).click()

  await expect.poll(() => sends.length).toBe(1)
  expect(sends[0]).toEqual({
    sessionID,
    queueID: "pqu_send_now",
    raw: "null",
    body: null,
  })
})
