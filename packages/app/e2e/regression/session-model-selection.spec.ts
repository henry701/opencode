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
