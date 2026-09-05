import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  directory,
  messageUpdated,
  project,
  session,
  sessionID,
  status,
  textPart,
  title,
  userID,
  userMessage,
  type TimelineEvent,
} from "../performance/timeline-stability/fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

const initialPageSize = 100
const historyPageSize = 100
const latestAssistants = Array.from({ length: initialPageSize - 1 }, (_, index) =>
  assistantMessage([textPart(`prt_history_root_${index}`, `Assistant response ${index}`)], {
    id: `msg_${String(index + 1001).padStart(4, "0")}_history_root_assistant`,
    created: 1700000001000 + index * 1_000,
    completed: index < initialPageSize - 2,
  }),
)
const olderUser = userMessage(undefined, { id: "msg_0001_history_root_user", created: 1699999998000 })
const olderAssistant = assistantMessage([textPart(`prt_history_root_99`, "Earlier assistant response")], {
  id: "msg_0002_history_root_assistant",
  created: 1699999999000,
})
const messages = [olderUser, olderAssistant, userMessage(), ...latestAssistants]
const lastAssistant = latestAssistants.at(-1)!
const lastPartID = `${lastAssistant.id}:text:0`
const olderPartID = `${olderAssistant.id}:text:0`
const completed = {
  ...lastAssistant,
  time: { ...lastAssistant.time, completed: lastAssistant.time.created + 15_000 },
}
const scenarios = [
  { name: "completion", message: completed, idleFirst: false, interrupted: false },
  {
    name: "interruption",
    message: { ...completed, error: { type: "interrupted" as const, message: "Stopped" } },
    idleFirst: true,
    interrupted: true,
  },
] as const

test.use({ viewport: { width: 646, height: 1385 } })

for (const scenario of scenarios) {
  test(`keeps visible timeline content visible through ${scenario.name}`, async ({ page }) => {
    const requests: { cursor?: string; phase: "start" | "end" }[] = []
    const pages: { cursor?: string; limit: number }[] = []
    const sequence: string[] = []
    const history = Promise.withResolvers<void>()
    const transport = await installSseTransport<TimelineEvent>(page, {
      server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
      path: `/api/session/${sessionID}/event`,
      retry: 20,
    })
    const active: Record<string, { type: "busy" | "idle" }> = { [sessionID]: { type: "busy" } }
    await mockOpenCodeServer(page, {
      directory,
      project: project(),
      provider: {
        all: [
          {
            id: "opencode",
            name: "OpenCode",
            models: {
              "claude-opus-4-6": {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                limit: { context: 200_000 },
              },
            },
          },
        ],
        connected: ["opencode"],
        default: { providerID: "opencode", modelID: "claude-opus-4-6" },
      },
      sessions: [session()],
      status: active,
      currentPageMessages: (_, limit, cursor) => {
        if (limit === historyPageSize) pages.push({ cursor, limit })
        const end = cursor ? Number(cursor) : messages.length
        const start = Math.max(0, end - limit)
        return {
          items: messages.slice(start, end).toReversed(),
          cursor: start > 0 ? { next: String(start) } : undefined,
          throughSeq: 0,
        }
      },
    })
    await page.route(`**/api/session/${sessionID}/message?**`, async (route) => {
      const url = new URL(route.request().url())
      if (Number(url.searchParams.get("limit")) !== historyPageSize) return route.fallback()
      const cursor = url.searchParams.get("cursor") ?? undefined
      const label = cursor ?? "latest"
      requests.push({ cursor, phase: "start" })
      sequence.push(`messages:start:${label}`)
      if (cursor) await history.promise
      await route.fallback()
      requests.push({ cursor, phase: "end" })
      sequence.push(`messages:end:${label}`)
    })
    await page.addInitScript(() => {
      const visibleParts = () => {
        const virtual = document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
        const viewport = virtual?.closest<HTMLElement>(".scroll-view__viewport")
        const view = viewport?.getBoundingClientRect()
        if (!viewport || !view) return []
        return [...viewport.querySelectorAll<HTMLElement>("[data-timeline-part-id]")]
          .filter((part) => {
            const rect = part.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
          })
          .flatMap((part) => (part.dataset.timelinePartId ? [part.dataset.timelinePartId] : []))
      }
      const state = {
        armed: false,
        hidden: false,
        visibleParts: [] as string[],
        samples: 0,
        stop: false,
        arm() {
          state.visibleParts = visibleParts()
          state.armed = true
        },
      }
      ;(window as Window & { __historyRootProbe?: typeof state }).__historyRootProbe = state
      const sample = () => {
        if (state.armed) {
          const virtual = document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
          const viewport = virtual?.closest<HTMLElement>(".scroll-view__viewport")
          const view = viewport?.getBoundingClientRect()
          const visible = (partID: string) => {
            const part = viewport?.querySelector<HTMLElement>(`[data-timeline-part-id="${CSS.escape(partID)}"]`)
            const rect = part?.getBoundingClientRect()
            return (
              !!rect && !!view && rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
            )
          }
          if (!virtual || state.visibleParts.length === 0 || state.visibleParts.some((partID) => !visible(partID)))
            state.hidden = true
          state.samples++
        }
        if (!state.stop) requestAnimationFrame(() => setTimeout(sample, 0))
      }
      requestAnimationFrame(() => setTimeout(sample, 0))
    })

    await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
    await transport.waitForConnection()
    await expectSessionTitle(page, title)
    await expect(page.locator(`[data-timeline-part-id="${lastPartID}"]`)).toBeVisible()
    await expect.poll(() => requests.filter((request) => request.phase === "start").length).toBe(1)
    expect(requests.filter((request) => request.phase === "end")).toHaveLength(1)
    expect(sequence).toEqual(["messages:start:latest", "messages:end:latest"])
    const viewport = page
      .locator(".scroll-view__viewport")
      .filter({ has: page.locator("[data-timeline-virtual-content]") })
    await viewport.evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
      element.scrollTop = 0
      element.dispatchEvent(new Event("scroll"))
    })
    await expect.poll(() => requests.filter((request) => request.phase === "start").length).toBe(2)
    expect(requests.filter((request) => request.phase === "end")).toHaveLength(1)
    const root = page.locator(`[data-message-id="${userID}"]`).first()
    await expect(root).toBeVisible()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const virtual = document.querySelector<HTMLElement>("[data-timeline-virtual-content]")
          const viewport = virtual?.closest<HTMLElement>(".scroll-view__viewport")
          const view = viewport?.getBoundingClientRect()
          if (!viewport || !view) return 0
          return [...viewport.querySelectorAll<HTMLElement>("[data-timeline-part-id]")].filter((part) => {
            const rect = part.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
          }).length
        }),
      )
      .toBeGreaterThan(0)
    await page.evaluate(() => {
      ;(
        window as Window & {
          __historyRootProbe?: { arm(): void }
        }
      ).__historyRootProbe!.arm()
    })
    await waitForProbeSamples(page, 0)
    await expect.poll(async () => visibleContentHidden(page), { timeout: 5_000 }).toBe(false)
    const beforeHistory = await probeSamples(page)
    history.resolve()
    await expect(root).toBeVisible()
    await expect.poll(() => requests.filter((request) => request.phase === "end").length).toBe(2)
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible()
    await waitForProbeSamples(page, beforeHistory)
    expect(pages).toEqual([
      { cursor: undefined, limit: historyPageSize },
      { cursor: String(messages.length - historyPageSize), limit: historyPageSize },
    ])

    const idle = status("idle")
    const events = scenario.idleFirst
      ? [idle, messageUpdated(scenario.message)]
      : [messageUpdated(scenario.message), idle]
    for (const event of events) {
      const beforeEvent = await probeSamples(page)
      if (event === idle) active[sessionID] = { type: "idle" }
      await transport.burst(Array.isArray(event) ? event : [event])
      if (event === events.at(-1)) await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
      await waitForProbeSamples(page, beforeEvent)
      const current = await timelineState(page)
      expect(current, JSON.stringify(current)).toMatchObject({ virtual: true })
      expect(current.rows, JSON.stringify(current)).toBeGreaterThan(0)
    }

    expect(requests[0]).toEqual({ cursor: undefined, phase: "start" })
    expect(requests[1]).toEqual({ cursor: undefined, phase: "end" })
    await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="bottom-spacer"]')).toBeVisible()
    expect(
      await page.evaluate(() => {
        const state = (window as Window & { __historyRootProbe?: { hidden: boolean; stop: boolean } })
          .__historyRootProbe!
        state.stop = true
        return state.hidden
      }),
    ).toBe(false)
    if (scenario.interrupted) {
      // History paging leaves the live turn; jump back after the stability probe finishes.
      await page.getByRole("button", { name: "Jump to latest" }).click()
      await expect(page.getByText("Interrupted", { exact: true })).toBeVisible()
    }
    await expect
      .poll(async () => {
        await viewport.evaluate((element) => {
          element.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }))
          element.scrollTop = 0
          element.dispatchEvent(new Event("scroll"))
        })
        return page.locator(`[data-timeline-part-id="${olderPartID}"]`).count()
      })
      .toBeGreaterThan(0)
    await expect(page.locator(`[data-timeline-part-id="${olderPartID}"]`)).toBeVisible()
  })
}

function timelineState(page: Page) {
  return page.evaluate(() => ({
    virtual: !!document.querySelector("[data-timeline-virtual-content]"),
    rows: document.querySelectorAll("[data-timeline-key]").length,
  }))
}

function probeSamples(page: Page) {
  return page.evaluate(
    () => (window as Window & { __historyRootProbe?: { samples: number } }).__historyRootProbe!.samples,
  )
}

async function waitForProbeSamples(page: Page, after: number) {
  await page.waitForFunction(
    (after) =>
      (window as Window & { __historyRootProbe?: { samples: number } }).__historyRootProbe!.samples >= after + 3,
    after,
  )
}

function visibleContentHidden(page: Page) {
  return page.evaluate(
    () => (window as Window & { __historyRootProbe?: { hidden: boolean } }).__historyRootProbe!.hidden,
  )
}
