import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/PendingReload"
const sessionID = "ses_pending_reload"

test("keeps stopped steering visible across page reload without resuming inference", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_pending",
      worktree: directory,
      name: "Pending reload",
      time: { created: 1, updated: 1 },
      sandboxes: [],
    },
    provider: {
      all: [
        { id: "opencode", name: "OpenCode", models: { test: { id: "test", name: "Test", variants: { high: {} } } } },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        projectID: "proj_pending",
        directory,
        title: "Stopped steering",
        time: { created: 1, updated: 1 },
      },
    ],
    currentPageMessages: () => ({
      items: [],
      throughSeq: 2,
      pending: [{ id: "msg_pending", type: "user", text: "Keep this admitted steering input", time: { created: 1 } }],
    }),
  })
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, "Stopped steering")
  await expect(page.getByText("Keep this admitted steering input", { exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Keep this admitted steering input", { exact: true })).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
})
