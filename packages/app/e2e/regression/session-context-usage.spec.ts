import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import { installSseTransport } from "../utils/sse-transport"
import { event, type TimelineEvent } from "../performance/timeline-stability/fixture"

const directory = "C:/OpenCode/ContextUsageRegression"
const sessionID = "ses_context_usage"
const model = { providerID: "opencode", modelID: "test" }
const messages = [0, 1].flatMap<typeof SessionMessage.Message.Encoded>((index) => [
  {
    id: `msg_${index * 2 + 1}_user`,
    type: "user" as const,
    text: `Prompt ${index}`,
    files: [],
    agents: [],
    time: { created: index * 2 + 1 },
    payload: { version: 1, agent: "build", model, parts: [{ type: "text", text: `Prompt ${index}` }] },
  },
  {
    id: `msg_${index * 2 + 2}_assistant`,
    type: "assistant" as const,
    agent: "build",
    model: { providerID: model.providerID, id: model.modelID },
    time: { created: index * 2 + 2, completed: index * 2 + 3 },
    cost: 1.25,
    tokens: { input: 20_000 * (index + 1), output: 5_000 * (index + 1), reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ id: `txt_${index}`, type: "text" as const, text: `Answer ${index}` }],
  },
])
Schema.decodeUnknownSync(Schema.Array(SessionMessage.Message))(messages, { onExcessProperty: "error" })

for (const newLayoutDesigns of [false, true]) {
  for (const mode of ["recorded", "rollback", "live"] as const) {
    test(`context circle and detail agree with ${mode} usage (${newLayoutDesigns ? "v2" : "legacy"})`, async ({
      page,
    }) => {
      await page.addInitScript((newLayoutDesigns) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns } }))
      }, newLayoutDesigns)
      const reverted = mode === "rollback"
      let settled = mode !== "live"
      const transport = await installSseTransport<TimelineEvent>(page, {
        server: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
        path: `/api/session/${sessionID}/event`,
      })
      await mockOpenCodeServer(page, {
        directory,
        project: { id: "proj_context_usage", worktree: directory, time: { created: 1, updated: 1 }, sandboxes: [] },
        provider: {
          all: [
            {
              id: "opencode",
              name: "OpenCode",
              models: { test: { id: "test", name: "Test", limit: { context: 100_000 } } },
            },
          ],
          connected: ["opencode"],
          default: model,
        },
        sessions: [
          {
            id: sessionID,
            directory,
            title: "Context usage regression",
            cost: 2.5,
            time: { created: 1, updated: 5 },
            ...(reverted ? { revert: { messageID: "msg_3_user", inclusive: true } } : {}),
          },
        ],
        currentPageMessages: () => ({
          items: messages
            .map((message) =>
              !settled && message.type === "assistant" && message.id === "msg_4_assistant"
                ? {
                    ...message,
                    time: { created: 4 },
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  }
                : message,
            )
            .toReversed(),
          throughSeq: 0,
        }),
      })
      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
      await expectSessionTitle(page, "Context usage regression")
      const usage = page.getByRole("button", { name: "View context usage", exact: true }).first()
      const percentage = reverted ? 25 : 50
      const expectPercentage = (value: number) =>
        expect
          .poll(async () =>
            usage.locator('circle[data-slot$="-progress"]').evaluate((circle) => {
              const total = Number(circle.getAttribute("stroke-dasharray"))
              return Math.round(100 * (1 - Number(circle.getAttribute("stroke-dashoffset")) / total))
            }),
          )
          .toBe(value)
      await expectPercentage(mode === "live" ? 25 : percentage)
      if (mode === "live") {
        settled = true
        await transport.send(
          event("session.next.step.ended", {
            sessionID,
            timestamp: 10,
            assistantMessageID: "msg_4_assistant",
            finish: "stop",
            cost: 1.25,
            tokens: { input: 40_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
        )
        await expectPercentage(50)
      }
      await usage.hover()
      await expect(page.getByRole("tooltip")).toContainText(`${percentage}%`)
      await expect(page.getByRole("tooltip")).toContainText((percentage * 1_000).toLocaleString("en-US"))
      await usage.click()
      await expect(page.getByText("Total Tokens", { exact: true }).locator("..")).toContainText(
        (percentage * 1_000).toLocaleString("en-US"),
      )
      await expect(page.getByText("Usage", { exact: true }).last().locator("..")).toContainText(`${percentage}%`)
    })
  }
}
