import { describe, expect, test } from "bun:test"
import {
  canOpenTabRename,
  canStartTabDrag,
  forwardTabRef,
  isTabCloseTarget,
  openTabContextMenu,
} from "./titlebar-tab-gesture"

describe("titlebar tab gestures", () => {
  test("excludes close controls from tab gestures", () => {
    const close = document.createElement("div")
    const button = document.createElement("button")
    const link = document.createElement("a")
    close.dataset.slot = "tab-close"
    close.append(button)
    expect(isTabCloseTarget(close)).toBe(true)
    expect(isTabCloseTarget(button)).toBe(true)
    expect(isTabCloseTarget(link)).toBe(false)
  })

  test("forwards component refs", () => {
    const element = document.createElement("div")
    let received: HTMLDivElement | undefined
    forwardTabRef((value) => (received = value), element)
    expect(received).toBe(element)
  })

  test("does not reopen rename while a save is pending", () => {
    expect(canOpenTabRename(false, false, false)).toBe(true)
    expect(canOpenTabRename(false, false, true)).toBe(false)
  })

  test("preserves native panning for touch pointers", () => {
    expect(canStartTabDrag("mouse")).toBe(true)
    expect(canStartTabDrag("pen")).toBe(true)
    expect(canStartTabDrag("touch")).toBe(false)
  })
})

describe("tab keyboard context menu", () => {
  for (const key of ["ContextMenu", "F10"]) {
    test(`opens from ${key} without relying on browser native synthesis`, () => {
      const tab = document.createElement("a")
      const menus: Event[] = []
      tab.addEventListener("contextmenu", (event) => menus.push(event))
      tab.addEventListener("keydown", (event) =>
        openTabContextMenu(event as KeyboardEvent & { currentTarget: HTMLElement }),
      )
      const event = new KeyboardEvent("keydown", { key, shiftKey: key === "F10", cancelable: true })
      tab.dispatchEvent(event)
      expect(menus).toHaveLength(1)
      expect(event.defaultPrevented).toBe(true)
    })
  }

  test("leaves unrelated or already-handled keys alone", () => {
    const tab = document.createElement("a")
    const menus: Event[] = []
    tab.addEventListener("contextmenu", (event) => menus.push(event))
    tab.addEventListener("keydown", (event) =>
      openTabContextMenu(event as KeyboardEvent & { currentTarget: HTMLElement }),
    )
    for (const init of [{ key: "F10" }, { key: "Enter" }, { key: "F10", shiftKey: true, ctrlKey: true }]) {
      const event = new KeyboardEvent("keydown", { ...init, cancelable: true })
      tab.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    const event = new KeyboardEvent("keydown", { key: "ContextMenu", cancelable: true })
    event.preventDefault()
    tab.dispatchEvent(event)
    expect(menus).toHaveLength(0)
  })
})
