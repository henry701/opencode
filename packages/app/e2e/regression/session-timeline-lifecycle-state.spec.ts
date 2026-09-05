import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partUpdated,
  reasoningPart,
  setupTimeline,
  shell,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

for (const expanded of [false, true]) {
  test(`preserves shell user intent from a ${expanded ? "expanded" : "collapsed"} default`, async ({ page }) => {
    const id = `prt_shell_default_${expanded}`
    const timeline = await setupTimeline(page, {
      messages: [userMessage(), assistantMessage([shell(id, "completed", lines(3))])],
      settings: { shellToolPartsExpanded: expanded },
    })
    const trigger = page.locator(`[data-timeline-part-id="${id}"] [data-slot="collapsible-trigger"]`)
    await expect(trigger).toHaveAttribute("aria-expanded", String(expanded))
    await trigger.click()
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))

    await timeline.send(partUpdated(shell(id, "completed", lines(6))), 180)
    await timeline.send(partUpdated(textPart(`prt_sibling_${expanded}`, "Sibling content")), 180)
    await timeline.sendStatus("busy", 100)
    await timeline.sendStatus("idle", 250)
    await expect(trigger).toHaveAttribute("aria-expanded", String(!expanded))
  })
}

test("shows and expands a running shell command without shimmering it", async ({ page }) => {
  const id = "prt_shell_running_command"
  const command = "sleep 10 && echo done"
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([shell(id, "running", "still running", command)], { completed: false })],
    settings: { shellToolPartsExpanded: false },
  })

  const tool = page.locator(`[data-timeline-part-id="${id}"]`)
  await expect(tool.locator('[data-component="text-shimmer"]')).toHaveAttribute("data-active", "true")
  await expect(tool.locator('[data-component="shell-submessage"]')).toHaveText(command)
  await expect(tool.locator('[data-component="shell-submessage"] [data-component="text-shimmer"]')).toHaveCount(0)
  await tool.locator('[data-slot="collapsible-trigger"]').click()
  await expect(tool.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "true")
  await expect(tool.locator('[data-slot="bash-pre"]')).toContainText("still running")
})

test("transitions thinking and hidden reasoning through busy to idle", async ({ page, browserName }) => {
  const reasoningID = "msg_1001_timeline_assistant:reasoning:0"
  const assistant = assistantMessage([reasoningPart(reasoningID, "## Inspecting stability")], { completed: false })
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistant],
    settings: { showReasoningSummaries: false },
    cpuRate: browserName === "chromium" ? 4 : undefined,
  })
  await timeline.sendStatus("busy", 150)

  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await expect(page.getByText("Inspecting stability", { exact: true })).toBeVisible()
  await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(0)
  await timeline.send(partUpdated(shell("prt_reasoning_shell", "running")), 160)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await timeline.send(partUpdated(shell("prt_reasoning_shell", "completed", "done")), 180)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant)), 100)
  await timeline.sendStatus("idle", 300)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${reasoningID}"]`)).toHaveCount(0)
})

test("moves busy through retry and recovery to final idle content", async ({ page }) => {
  const assistant = assistantMessage([], {
    completed: false,
    snapshot: {
      diffs: [
        {
          file: "src/retry.ts",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-export const retry = false\n+export const retry = true",
        },
      ],
    },
  })
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistant],
  })
  await timeline.sendStatus("busy", 140)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toHaveCount(0)
  await timeline.sendStatus("retry", 180)
  await expect(page.locator('[data-timeline-row="Retry"]')).toContainText("Rate limited")
  await expect(page.locator('[data-timeline-row="Retry"]')).toContainText("attempt #1")
  await timeline.sendStatus("retry", 100, 2)
  await expect(page.locator('[data-timeline-row="Retry"]')).toContainText("attempt #2")
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await timeline.sendStatus("busy", 180, 2)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toBeVisible()
  await timeline.send(partUpdated(textPart("prt_recovered", "Recovered response")), 140)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant)), 100)
  await timeline.sendStatus("idle", 350)
  await expect(page.locator('[data-timeline-row="Retry"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator('[data-timeline-row="DiffSummary"]')).toBeVisible()
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}
