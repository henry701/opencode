import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  textPart,
  timelineEvents,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("keeps one connection open while delivering multiple events", async ({ page }) => {
  const timeline = await setupTimeline(page)

  const first = await timeline.transport.burst(
    timelineEvents(partUpdated(textPart("prt_transport_first", "first event"))),
  )
  const second = await timeline.transport.burst(
    timelineEvents(partUpdated(textPart("prt_transport_second", "second event"))),
  )

  await expect(page.getByText("first event", { exact: true })).toBeVisible()
  await expect(page.getByText("second event", { exact: true })).toBeVisible()
  expect(first[0]!.connectionID).toBe(second[0]!.connectionID)
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
  expect(await timeline.transport.acknowledgements()).toHaveLength(4)
})

test("delivers a burst from one stream chunk", async ({ page }) => {
  const timeline = await setupTimeline(page)
  const acknowledgements = await timeline.transport.burst([
    ...timelineEvents(partUpdated(textPart("prt_transport_burst_a", "burst a"))),
    ...timelineEvents(partUpdated(textPart("prt_transport_burst_b", "burst b"))),
  ])

  await expect(page.getByText("burst a", { exact: true })).toBeVisible()
  await expect(page.getByText("burst b", { exact: true })).toBeVisible()
  expect(acknowledgements.map((item) => item.chunkCount)).toEqual([1, 1, 1, 1])
  expect(new Set(acknowledgements.map((item) => item.deliveryID)).size).toBe(4)
})

test("parses split JSON and a split multibyte code point", async ({ page }) => {
  const timeline = await setupTimeline(page)
  const events = timelineEvents(partUpdated(textPart("prt_transport_split", "split snowman \u2603\u2603\u2603")))
  await timeline.transport.send(events[0]!)
  const payload = events[1]!
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
  const snowman = new TextEncoder().encode("\u2603")[0]!
  const multibyte = encoded.indexOf(snowman)

  const acknowledgement = await timeline.transport.split(payload, [9, multibyte + 1, multibyte + 2])

  await expect(page.getByText("split snowman \u2603\u2603\u2603", { exact: true })).toBeVisible()
  expect(acknowledgement.chunkCount).toBe(4)
})

test("delivers server heartbeat without mutating the timeline", async ({ page }) => {
  const sentinelID = "prt_transport_heartbeat_sentinel"
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([textPart("prt_transport_steady", "steady")])],
  })
  await expect(page.locator('[data-component="markdown"]').getByText("steady", { exact: true })).toBeVisible()
  const before = await stableTimelineRows(page)

  await timeline.transport.writeRaw(": heartbeat\n\n")
  expect(await stableTimelineRows(page)).toEqual(before)

  // A real append may move the assistant footer; check heartbeat stability before it.
  await timeline.send(partUpdated(textPart(sentinelID, "heartbeat processed")))
  await expect(page.getByText("heartbeat processed", { exact: true })).toBeVisible()

  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
})

test("reconnects after a clean close", async ({ page }) => {
  const timeline = await setupTimeline(page)
  const first = await timeline.transport.waitForConnection()

  await timeline.transport.close()
  const second = await timeline.transport.waitForConnection({ after: first.id })
  await timeline.send(partUpdated(textPart("prt_transport_close", "after close")))

  await expect(page.getByText("after close", { exact: true })).toBeVisible()
  expect(second.id).toBeGreaterThan(first.id)
  expect((await timeline.transport.connections())[0]?.endedBy).toBe("close")
})

test("reconnects after a stream error", async ({ page }) => {
  const timeline = await setupTimeline(page)
  const first = await timeline.transport.waitForConnection()

  await timeline.transport.error("contract failure")
  const second = await timeline.transport.waitForConnection({ after: first.id })
  await timeline.send(partUpdated(textPart("prt_transport_error", "after error")))

  await expect(page.getByText("after error", { exact: true })).toBeVisible()
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(2)
  expect(second.id).toBeGreaterThan(first.id)
  expect((await timeline.transport.connections())[0]?.endedBy).toBe("error")
})

test("resumes the durable session stream after its last received sequence", async ({ page }) => {
  const timeline = await setupTimeline(page, { protocol: "v2" })
  const events = timelineEvents(partUpdated(textPart("prt_transport_id", "event with id")))
  await timeline.transport.send(events[0]!)
  const first = await timeline.transport.send(events[1]!, { id: "timeline-event-7" })
  await expect(page.getByText("event with id", { exact: true })).toBeVisible()

  await timeline.transport.error("retry with event id")
  const connection = await timeline.transport.waitForConnection({ after: first.connectionID })

  expect(new URL(connection.url).searchParams.get("after")).toBe(String(events[1]!.durable?.seq))
  expect(first.eventID).toBe("timeline-event-7")
  expect(connection.headers["last-event-id"]).toBeUndefined()
})

test("passes through non-event fetches", async ({ page }) => {
  const timeline = await setupTimeline(page)

  const health = await page.evaluate(async () => {
    const response = await fetch("/global/health")
    return response.json()
  })

  expect(health).toEqual({ healthy: true })
  await expect.poll(async () => (await timeline.transport.connections()).length).toBe(1)
})

async function stableTimelineRows(page: Page) {
  let previous: Awaited<ReturnType<typeof timelineRows>> | undefined
  let stable = 0
  await expect
    .poll(
      async () => {
        const next = await timelineRows(page)
        stable = JSON.stringify(next) === JSON.stringify(previous) ? stable + 1 : 0
        previous = next
        return stable
      },
      { intervals: [50, 50, 100] },
    )
    .toBeGreaterThanOrEqual(2)
  return previous!
}

function timelineRows(page: Page) {
  return page.locator("[data-timeline-key]").evaluateAll((elements) =>
    elements.map((element) => ({
      key: element.getAttribute("data-timeline-key"),
      row: element.querySelector("[data-timeline-row]")?.getAttribute("data-timeline-row"),
      parts: Array.from(element.querySelectorAll("[data-timeline-part-id]"), (part) =>
        part.getAttribute("data-timeline-part-id"),
      ),
      text: (element as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
    })),
  )
}
