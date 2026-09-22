import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { assistantMessage, setupTimeline, userMessage, userText } from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"

const draftID = "draft_legacy_new_session"
const directory = "C:/OpenCode/LegacyNewSession"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// Keep historical layout coverage independent of the upstream retirement date.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 8, 1))
})

test("redirects a draft to the legacy new-session route", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_legacy_new_session",
      worktree: directory,
      vcs: "git",
      name: "legacy-new-session",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [],
    currentPageMessages: () => ({ items: [], throughSeq: 0 }),
  })
  await page.addInitScript(
    ({ directory, draftID, server }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false } }))
      localStorage.setItem("app-version.v1", JSON.stringify({ version: "1.17.20" }))
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify([{ type: "draft", draftID, server, directory }]),
      )
    },
    { directory, draftID, server },
  )

  await page.goto(`/new-session?draftId=${draftID}`)

  await expect(page).toHaveURL(`/${base64Encode(directory)}/session`)
  await expect(page.locator("header[data-tauri-drag-region]")).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"]')).toBeVisible()
})

test("renders comment strips and historical diff summary overflow", async ({ page }) => {
  const user = userMessage([
    userText("The user made the following comment regarding lines 4 through 8 of src/a.ts: Keep this stable", {
      id: "prt_comment_only",
      synthetic: true,
      metadata: {
        opencodeComment: {
          path: "src/a.ts",
          selection: { startLine: 4, startChar: 0, endLine: 8, endChar: 0 },
          comment: "Keep this stable",
        },
      },
    }),
    userText("Continue after the comment", { id: "prt_comment_visible" }),
  ])
  const nextUser = userMessage(undefined, { id: "msg_2000_diff_next_user", created: 1700000010000 })
  const nextAssistant = assistantMessage([], {
    id: "msg_2001_diff_next_assistant",
    created: 1700000011000,
  })
  await setupTimeline(page, {
    messages: [
      user,
      assistantMessage([], { snapshot: { diffs: Array.from({ length: 11 }, (_, index) => summaryDiff(index)) } }),
      nextUser,
      nextAssistant,
    ],
    settings: { newLayoutDesigns: false },
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await scroller.evaluate((element) => (element.scrollTop = 0))

  await expect(page.locator('[data-timeline-row="CommentStrip"]')).toBeVisible()
  await expect(page.getByText("Keep this stable", { exact: true })).toBeVisible()
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toBeVisible()
  await expect(page.getByText(/show all/i)).toBeVisible()
})

function summaryDiff(index: number) {
  return {
    file: `src/diff-${index}.ts`,
    additions: 1,
    deletions: 1,
    patch: `@@ -1 +1 @@\n-export const value = ${index}\n+export const value = ${index + 1}`,
  }
}
