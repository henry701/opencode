import { expect, test, type Locator } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  assistantMessage,
  directory,
  project,
  session,
  sessionID,
  textPart,
  title,
  userMessage,
} from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"
import { expectAtBottom, scrollToBottom, scrollToHistoryView } from "../utils/scroll"

const messages = Array.from({ length: 80 }, (_, index) => {
  const userID = `msg_history_${index}_user`
  return [
    userMessage([textPart(`prt_history_${index}_user`, `History message ${index}. ${"content ".repeat(40)}`)], {
      id: userID,
      created: 1700000000000 + index * 10_000,
    }),
    assistantMessage([textPart(`prt_history_${index}_assistant`, `Assistant reply ${index}. ${"response ".repeat(40)}`)], {
      id: `msg_history_${index}_assistant`,
      parentID: userID,
      created: 1700000001000 + index * 10_000,
    }),
  ]
}).flat()

const readVisibleTimeline = (scroller: Locator) =>
  scroller.evaluate((element) => {
    const view = element.getBoundingClientRect()
    const parts = [...element.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
    const visible = parts.filter((part) => {
      const rect = part.getBoundingClientRect()
      return rect.bottom > view.top + 8 && rect.top < view.bottom - 8 && rect.width > 0 && rect.height > 0
    })
    const blank = visible.filter((part) => !part.textContent?.trim())
    return {
      scrollTop: element.scrollTop,
      visible: visible
        .map((part) => part.getAttribute("data-timeline-part-id") ?? "")
        .filter(Boolean)
        .sort(),
      blankCount: blank.length,
      rowCount: element.querySelectorAll("[data-timeline-row]").length,
      textSample: visible
        .slice(0, 3)
        .map((part) => (part.textContent ?? "").trim().slice(0, 80))
        .filter(Boolean),
    }
  })

const provider = {
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
        "claude-opus-4-6": {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          limit: { context: 200_000 },
          variants: { max: {}, high: {} },
        },
      },
    },
  ],
  connected: ["opencode"],
  default: { opencode: "big-pickle" },
}

test("keeps scrolled timeline messages visible after switching models", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider,
    sessions: [session()],
    currentPageMessages: () => ({ items: messages.toReversed(), throughSeq: 0 }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const scroller = page
    .locator("[data-timeline-virtual-content]")
    .locator("xpath=ancestor::*[contains(@class,'scroll-view__viewport')][1]")
  await expect(scroller).toBeVisible()

  await scroller.hover()
  await scrollToHistoryView(scroller)
  await page.waitForTimeout(200)

  const before = await readVisibleTimeline(scroller)
  expect(before.visible.length).toBeGreaterThan(2)
  expect(before.blankCount).toBe(0)
  expect(before.textSample.length).toBeGreaterThan(0)

  const composer = page.locator('[data-component="session-prompt-dock"]')
  await composer.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: /DeepSeek V4 Flash Free/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
  await page.waitForTimeout(200)

  const after = await readVisibleTimeline(scroller)

  expect(after.scrollTop, `before=${before.scrollTop} after=${after.scrollTop}`).toBeCloseTo(before.scrollTop, 0)
  expect(after.visible).toEqual(before.visible)
  expect(after.rowCount).toBe(before.rowCount)
  expect(after.blankCount, JSON.stringify(after)).toBe(0)
  expect(after.textSample.length).toBeGreaterThan(0)
})

test("keeps scrolled timeline when model switch does not resize composer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    const Original = window.ResizeObserver
    window.ResizeObserver = class extends Original {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          const filtered = entries.filter((entry) => {
            const target = entry.target
            if (!(target instanceof Element)) return true
            return !target.closest('[data-component="session-prompt-dock"]')
          })
          if (filtered.length === 0) return
          callback(filtered, observer)
        })
      }
    }
  })

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider,
    sessions: [session()],
    currentPageMessages: () => ({ items: messages.toReversed(), throughSeq: 0 }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const scroller = page
    .locator("[data-timeline-virtual-content]")
    .locator("xpath=ancestor::*[contains(@class,'scroll-view__viewport')][1]")
  await expect(scroller).toBeVisible()

  await scroller.hover()
  await scrollToHistoryView(scroller)
  await page.waitForTimeout(200)
  const before = await readVisibleTimeline(scroller)
  expect(before.visible.length).toBeGreaterThan(2)
  expect(before.blankCount).toBe(0)

  const composer = page.locator('[data-component="session-prompt-dock"]')
  await composer.locator('[data-action="prompt-model"]').click()
  await page.getByRole("button", { name: /DeepSeek V4 Flash Free/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
  await page.waitForTimeout(200)

  const after = await readVisibleTimeline(scroller)
  expect(after.scrollTop, `before=${before.scrollTop} after=${after.scrollTop}`).toBeCloseTo(before.scrollTop, 0)
  expect(after.visible).toEqual(before.visible)
  expect(after.rowCount).toBe(before.rowCount)
  expect(after.blankCount, JSON.stringify(after)).toBe(0)
})

test("keeps scrolled timeline when switching between variant and non-variant models", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider,
    sessions: [session()],
    currentPageMessages: () => ({ items: messages.toReversed(), throughSeq: 0 }),
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const scroller = page
    .locator("[data-timeline-virtual-content]")
    .locator("xpath=ancestor::*[contains(@class,'scroll-view__viewport')][1]")
  await expect(scroller).toBeVisible()

  await scroller.hover()
  await scrollToHistoryView(scroller)
  await page.waitForTimeout(200)

  const before = await readVisibleTimeline(scroller)
  expect(before.visible.length).toBeGreaterThan(2)
  expect(before.blankCount).toBe(0)

  const composer = page.locator('[data-component="session-prompt-dock"]')
  const modelDialog = () => page.getByRole("dialog", { name: /Select model/i })

  await composer.locator('[data-action="prompt-model"]').click()
  await modelDialog().getByRole("button", { name: /Big Pickle/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Big Pickle")
  await page.waitForTimeout(200)

  await composer.locator('[data-action="prompt-model"]').click()
  await modelDialog().getByRole("button", { name: /Claude Opus 4.6/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("Claude Opus 4.6")
  await page.waitForTimeout(200)

  const withVariant = await readVisibleTimeline(scroller)
  expect(withVariant.scrollTop).toBeCloseTo(before.scrollTop, 0)
  expect(withVariant.blankCount, JSON.stringify(withVariant)).toBe(0)
  expect(withVariant.visible.length).toBeGreaterThan(2)

  await composer.locator('[data-action="prompt-model"]').click()
  await modelDialog().getByRole("button", { name: /DeepSeek V4 Flash Free/ }).click()
  await expect(composer.locator('[data-action="prompt-model"]')).toContainText("DeepSeek V4 Flash Free")
  await page.waitForTimeout(200)

  const after = await readVisibleTimeline(scroller)
  expect(after.scrollTop).toBeCloseTo(before.scrollTop, 0)
  expect(after.visible).toEqual(before.visible)
  expect(after.blankCount, JSON.stringify(after)).toBe(0)
})
