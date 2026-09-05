import type { Ref } from "solid-js"

export function isTabCloseTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[data-slot="tab-close"]')
}

export function canStartTabDrag(pointerType: string) {
  return pointerType !== "touch"
}

export function forwardTabRef(ref: Ref<HTMLDivElement> | undefined, element: HTMLDivElement) {
  if (typeof ref === "function") ref(element)
}

export function canOpenTabRename(dragging: boolean | undefined, editing: boolean, pending: boolean) {
  return !dragging && !editing && !pending
}

export function openTabContextMenu(event: KeyboardEvent & { currentTarget: HTMLElement }) {
  if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
  if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return
  event.preventDefault()
  const rect = event.currentTarget.getBoundingClientRect()
  // Firefox does not reliably synthesize contextmenu for keyboard activation.
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }),
  )
}
