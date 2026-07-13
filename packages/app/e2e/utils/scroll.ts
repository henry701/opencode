import { expect, type Locator } from "@playwright/test"

export async function scrollToBottom(locator: Locator) {
  for (let attempt = 0; attempt < 40; attempt++) {
    await locator.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new Event("scroll"))
    })
    await locator.page().waitForTimeout(16)
    const distance = await distanceFromBottom(locator)
    if (distance <= 1) return
  }
}

export async function distanceFromBottom(locator: Locator) {
  return locator.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
}

export async function scrollTimelineUp(locator: Locator, amount?: number) {
  await locator.evaluate((element, step) => {
    const delta = step ?? Math.max(80, Math.round(element.clientHeight * 0.45))
    element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1, deltaMode: 0 }))
    element.scrollTop = Math.max(0, element.scrollTop - delta)
  }, amount)
}

export async function scrollToHistoryView(locator: Locator) {
  for (let attempt = 0; attempt < 120; attempt++) {
    await scrollTimelineUp(locator)
    const jump = locator.page().getByRole("button", { name: /Jump to latest/i })
    if (await jump.isVisible().catch(() => false)) return
  }
  throw new Error("Timed out scrolling away from the timeline bottom")
}

export async function expectAtBottom(locator: Locator, tolerance = 1) {
  await expect
    .poll(() => distanceFromBottom(locator), { timeout: 20_000 })
    .toBeLessThanOrEqual(tolerance)
}
