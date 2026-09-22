import { expect, test } from "bun:test"
import { observeVirtualScrollElement, virtualScrollElement } from "./virtual-scroll-element"

test("resolves the connected viewport that owns the virtual root", () => {
  const stale = document.createElement("div")
  stale.className = "scroll-view__viewport"
  const viewport = document.createElement("div")
  viewport.className = "scroll-view__viewport"
  const root = document.createElement("div")
  viewport.append(root)
  document.body.append(viewport)

  expect(virtualScrollElement(root)).toBe(viewport)
  expect(virtualScrollElement(root)).not.toBe(stale)

  viewport.remove()
  expect(virtualScrollElement(root)).toBeNull()
})

test("tracks late mounting, cached-panel reparenting, and disconnection", async () => {
  const first = document.createElement("div")
  const second = document.createElement("div")
  first.className = second.className = "scroll-view__viewport"
  const root = document.createElement("div")
  first.append(root)
  const updates: Array<HTMLDivElement | null> = []
  const dispose = observeVirtualScrollElement(root, (element) => updates.push(element))
  try {
    expect(updates).toEqual([null])
    document.body.append(first, second)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updates.at(-1)).toBe(first)
    second.append(root)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updates.at(-1)).toBe(second)
    root.remove()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updates).toEqual([null, first, second, null])
    dispose()
    first.append(root)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(updates).toHaveLength(4)
  } finally {
    dispose()
    first.remove()
    second.remove()
  }
})
