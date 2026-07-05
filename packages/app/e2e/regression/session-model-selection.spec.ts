import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"
import { PersistTesting } from "@/utils/persist"
import { pathKey } from "@/utils/path-key"

const directory = "C:/OpenCode/SessionModelSelectionRegression"
const projectID = "proj_session_model_selection_regression"
const sessionID = "ses_session_model_selection_regression"
const staleModel = { providerID: "opencode", modelID: "big-pickle" }
const historyModel = { providerID: "anthropic", modelID: "claude-sonnet-4" }

const session = {
  id: sessionID,
  slug: "session-model-selection-regression",
  projectID,
  directory,
  title: "Session model selection regression",
  version: "dev",
  time: { created: 1700000000000, updated: 1700000000000 },
}

test("uses the latest message model instead of a stale saved default until the picker is changed", async ({ page }) => {
  const storage = PersistTesting.workspaceStorage(pathKey(directory))
  const promptRequests: string[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/session/${sessionID}/prompt_async` && request.method() === "POST") {
      promptRequests.push(request.postData() ?? "")
    }
  })

  await page.addInitScript(
    ({ storage, sessionID, staleModel }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        `${storage}:workspace:model-selection`,
        JSON.stringify({
          session: {
            [sessionID]: {
              agent: "build",
              model: staleModel,
              variant: null,
            },
          },
        }),
      )
    },
    { storage, sessionID, staleModel },
  )

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-model-selection-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200_000 } },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "claude-sonnet-4": { id: "claude-sonnet-4", name: "Claude Sonnet 4", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode", "anthropic"],
      default: { opencode: "big-pickle" },
    },
    sessions: [session],
    pageMessages: () => ({
      items: [
        {
          info: {
            id: "msg_user_model_history",
            sessionID,
            role: "user",
            time: { created: 1700000000000 },
            agent: "build",
            model: historyModel,
          },
          parts: [
            {
              id: "prt_user_model_history",
              sessionID,
              messageID: "msg_user_model_history",
              type: "text",
              text: "history selected another model",
            },
          ],
        },
      ],
    }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)

  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Claude Sonnet 4")

  await composer.locator('[data-action="prompt-model"]').click()
  await page.getByRole("menuitemradio", { name: "Big Pickle" }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Big Pickle")

  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("keep the selected model after submit")
  await input.press("Enter")

  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]).toContain('"providerID":"opencode"')
  expect(promptRequests[0]).toContain('"modelID":"big-pickle"')
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Big Pickle")
})

test("keeps a manually selected model when submitting a brand-new web session", async ({ page }) => {
  const draftID = "draft_new_session_model_selection"
  const createdSessionID = "ses_new_session_model_selection"
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  const project = {
    id: "proj_new_session_model_selection",
    worktree: directory,
    vcs: "git",
    name: "new-session-model-selection-regression",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
  const sessions: Array<typeof session> = []
  const promptRequests: unknown[] = []
  const events: Array<{ directory: string; payload: Record<string, unknown> }> = []
  let selectedModelUnavailable = false

  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
      localStorage.setItem("opencode.window.browser.dat:tabs.recent", JSON.stringify({ key: `draft:${draftID}` }))
    },
    { directory, draftID, server },
  )

  await mockOpenCodeServer(page, {
    directory,
    project,
    provider: () => ({
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: selectedModelUnavailable
            ? {
                "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200_000 } },
              }
            : {
                "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200_000 } },
                "deepseek-v4-flash-free": {
                  id: "deepseek-v4-flash-free",
                  name: "DeepSeek V4 Flash Free",
                  limit: { context: 200_000 },
                },
              },
        },
      ],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    }),
    agents: [
      {
        name: "Sisyphus - ultraworker",
        mode: "primary",
        model: { providerID: "opencode", modelID: "big-pickle" },
      },
      { name: "build", mode: "primary" },
    ],
    sessions,
    createSession: () => {
      const created = {
        id: createdSessionID,
        slug: "new-session-model-selection-regression",
        projectID: project.id,
        directory,
        title: "New session model selection regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      }
      sessions.push(created)
      return created
    },
    onPromptAsync: ({ body }) => {
      promptRequests.push(body)
      const request = body as {
        messageID?: string
        agent?: string
        model?: { providerID: string; modelID: string }
      }
      events.push({
        directory,
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: request.messageID ?? "msg_new_session_model_selection",
              sessionID: createdSessionID,
              role: "user",
              time: { created: 1700000000001 },
              agent: request.agent ?? "Sisyphus - ultraworker",
              model: request.model ?? { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
            },
          },
        },
      })
    },
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
  })

  await page.goto(`/new-session?draftId=${draftID}`)

  const draftComposer = page.locator('[data-component="session-new-composer"]')
  const draftInput = draftComposer.locator('[data-component="prompt-input"]')
  await expectAppVisible(draftComposer)
  await expect(draftComposer.locator('[data-action="prompt-model"]')).toContainText("Big Pickle")

  await draftInput.fill("hi")
  await draftComposer.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: /DeepSeek V4 Flash Free/ }).click()
  await expect(draftComposer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
  await expect(draftInput).toContainText("hi")
  selectedModelUnavailable = true

  await draftComposer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]).toMatchObject({
    agent: "Sisyphus - ultraworker",
    model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
  })

  await expectSessionTitle(page, "New session model selection regression")
  const sessionComposer = page.locator('[data-component="session-composer"]')
  await expect(sessionComposer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
  await page.waitForTimeout(750)
  await expect(sessionComposer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")

  const sessionInput = sessionComposer.locator('[data-component="prompt-input"]')
  await sessionInput.fill("second prompt should keep the selected model")
  await sessionComposer.locator('[data-action="prompt-submit"]').click()

  await expect.poll(() => promptRequests.length).toBe(2)
  expect(promptRequests[1]).toMatchObject({
    agent: "Sisyphus - ultraworker",
    model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
  })
  await expect(sessionComposer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
})

test("keeps a manually selected model when submitting with Enter on a Sisyphus session", async ({ page }) => {
  const storage = PersistTesting.workspaceStorage(pathKey(directory))
  const promptRequests: string[] = []

  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/session/${sessionID}/prompt_async` && request.method() === "POST") {
      promptRequests.push(request.postData() ?? "")
    }
  })

  await page.addInitScript(
    ({ storage, sessionID }) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: true }, visibility: { customAgents: true } }),
      )
      localStorage.setItem(
        `${storage}:workspace:model-selection`,
        JSON.stringify({
          session: {
            [sessionID]: {
              agent: "Sisyphus - ultraworker",
              model: { providerID: "opencode", modelID: "big-pickle" },
              variant: null,
            },
          },
        }),
      )
    },
    { storage, sessionID },
  )

  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-model-selection-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200_000 } },
            "deepseek-v4-flash-free": {
              id: "deepseek-v4-flash-free",
              name: "DeepSeek V4 Flash Free",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { opencode: "big-pickle" },
    },
    agents: [
      {
        name: "Sisyphus - ultraworker",
        mode: "primary",
        model: { providerID: "opencode", modelID: "big-pickle" },
      },
    ],
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, session.title)

  const composer = page.locator('[data-component="session-composer"]')
  await expectAppVisible(composer)
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Big Pickle")

  await composer.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: /DeepSeek V4 Flash Free/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")

  const input = composer.locator('[data-component="prompt-input"]')
  await input.fill("keep deepseek after enter submit")
  await input.press("Enter")

  await expect.poll(() => promptRequests.length).toBe(1)
  expect(promptRequests[0]).toContain('"agent":"Sisyphus - ultraworker"')
  expect(promptRequests[0]).toContain('"modelID":"deepseek-v4-flash-free"')
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
})
