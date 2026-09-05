import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export function virtualScrollElement(root: HTMLElement | undefined) {
  if (!root?.isConnected) return null
  return root.closest<HTMLDivElement>(".scroll-view__viewport")
}

export function observeVirtualScrollElement(root: HTMLElement, update: (element: HTMLDivElement | null) => void) {
  let current = virtualScrollElement(root)
  update(current)
  // Cached panels can mount or move after Solid's onMount without changing their props.
  const observer = new MutationObserver(() => {
    const next = virtualScrollElement(root)
    if (next === current) return
    current = next
    update(next)
  })
  observer.observe(root.ownerDocument, { childList: true, subtree: true })
  return () => observer.disconnect()
}

export function createVirtualScrollElement(root: Accessor<HTMLElement | undefined>) {
  const [element, setElement] = createSignal<HTMLDivElement | null>(null)
  createEffect(() => {
    const current = root()
    setElement(null)
    if (current) onCleanup(observeVirtualScrollElement(current, setElement))
  })
  return element
}
