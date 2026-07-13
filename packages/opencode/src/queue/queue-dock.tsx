/** @jsxImportSource @opentui/solid */
import type { ColorInput } from "@opentui/core"
import { For, Show, createMemo, createSignal } from "solid-js"
import type { QueuedItem } from "@/queue/preview"
import { truncateQueueLine } from "@/queue/preview"

export type { QueuedItem }

export type QueueDockTheme = {
  text: ColorInput
  textMuted: ColorInput
  primary: ColorInput
  border: ColorInput
}

export type QueueDockHints = {
  edit?: string
  queue?: string
  submit?: string
  cancel?: string
  editNext?: string
}

const DEFAULT_BORDER = {
  topLeft: "┏",
  topRight: "┓",
  bottomLeft: "┗",
  bottomRight: "┛",
  horizontal: "━",
  vertical: "┃",
  bottomT: "┻",
  topT: "┳",
  cross: "╋",
  leftT: "┣",
  rightT: "┫",
}

const IDLE_VISIBLE_ITEMS = 2
const EDIT_VISIBLE_ITEMS = 3

export function queueDockVisibleItems(input: {
  items: QueuedItem[]
  editing: boolean
  editingID?: string
}): Array<{ item: QueuedItem; ordinal: number }> {
  if (!input.editing) {
    return input.items.slice(0, IDLE_VISIBLE_ITEMS).map((item, index) => ({ item, ordinal: index + 1 }))
  }

  if (input.items.length <= EDIT_VISIBLE_ITEMS) {
    return input.items.map((item, index) => ({ item, ordinal: index + 1 }))
  }

  const activeIndex = Math.max(
    0,
    input.items.findIndex((item) => item.id === input.editingID),
  )
  const start = Math.min(Math.max(activeIndex - 1, 0), input.items.length - EDIT_VISIBLE_ITEMS)
  return input.items
    .slice(start, start + EDIT_VISIBLE_ITEMS)
    .map((item, index) => ({ item, ordinal: start + index + 1 }))
}

/** Terminal rows reserved above the prompt textarea (run footer height sync). */
export function queueDockRows(input: { count: number; editing: boolean; collapsed?: boolean }) {
  if (input.count === 0 && !input.editing) return 0
  if (input.collapsed) return 3

  let rows = 1
  if (input.editing) rows += 2
  const itemRows = input.editing
    ? Math.min(Math.max(input.count, 1), EDIT_VISIBLE_ITEMS)
    : Math.min(input.count, IDLE_VISIBLE_ITEMS)
  rows += itemRows
  if (!input.editing && input.count > IDLE_VISIBLE_ITEMS) rows += 1
  if (!input.editing && input.count > 0) rows += 2
  if (input.count > 0) rows += 1
  return rows
}

export function QueueDock(props: {
  items: () => QueuedItem[]
  theme: () => QueueDockTheme
  hints?: () => QueueDockHints | undefined
  customBorderChars?: typeof DEFAULT_BORDER
  disabled?: boolean
  editing?: () => boolean
  editingMessageID?: () => string | undefined
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
  onRemove: (id: string) => void
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const total = () => props.items().length
  const label = createMemo(() => (total() === 1 ? "1 message queued" : `${total()} messages queued`))
  const preview = () => props.items()[0]?.text ?? ""
  const border = () => props.customBorderChars ?? DEFAULT_BORDER
  const hiddenCount = createMemo(() => {
    if (props.editing?.()) return 0
    return Math.max(0, total() - IDLE_VISIBLE_ITEMS)
  })
  const visibleItems = createMemo(() => {
    return queueDockVisibleItems({
      items: props.items(),
      editing: !!props.editing?.(),
      editingID: props.editingMessageID?.(),
    })
  })

  const editingHint = createMemo(() => {
    if (!props.editing?.()) return undefined

    const hints = props.hints?.()
    const parts = [
      hints?.submit ? `${hints.submit} send now` : "Return send now",
      hints?.queue ? `${hints.queue} save to queue` : "Ctrl+Shift+Enter save to queue",
    ]
    if (hints?.cancel) parts.push(`${hints.cancel} go back`)
    if (hints?.edit && hints?.editNext && total() > 1) parts.push(`${hints.edit}/${hints.editNext} switch`)
    return parts.join(" · ")
  })

  const idleHint = createMemo(() => {
    if (props.editing?.()) return undefined

    const hints = props.hints?.()
    if (hints?.edit && hints?.queue) return `${hints.edit} edit oldest · ${hints.queue} queue`
    if (hints?.edit) return `${hints.edit} edit oldest`
    if (hints?.queue) return `${hints.queue} queue`
    return undefined
  })

  const itemText = (item: QueuedItem) => truncateQueueLine(item.text)

  return (
    <Show when={total() > 0 || props.editing?.()}>
      <box
        flexDirection="column"
        flexShrink={0}
        width="100%"
        border={["top"]}
        customBorderChars={border()}
        borderColor={props.editing?.() ? props.theme().primary : props.theme().border}
      >
        <Show when={props.editing?.() && editingHint()}>
          <box flexDirection="column" flexShrink={0} gap={1}>
            <text fg={props.theme().primary} flexShrink={0}>
              Editing queued message
            </text>
            <text fg={props.theme().textMuted} flexShrink={0} wrapMode="word">
              {editingHint()}
            </text>
          </box>
        </Show>
        <Show when={total() > 0}>
          <box flexDirection="row" flexShrink={0} gap={1} onMouseUp={() => setCollapsed((value) => !value)}>
            <text fg={props.theme().text} flexShrink={0}>
              {label()}
            </text>
            <Show when={collapsed() && preview()}>
              <text fg={props.theme().textMuted} flexGrow={1} flexShrink={1} wrapMode="none">
                {truncateQueueLine(preview())}
              </text>
            </Show>
            <text fg={props.theme().textMuted} flexShrink={0}>
              {collapsed() ? "▾" : "▴"}
            </text>
          </box>
          <Show when={!collapsed()}>
            <box flexDirection="column" flexShrink={0} gap={1}>
              <For each={visibleItems()}>
                {(entry, index) => (
                  <box flexDirection="row" flexShrink={0} gap={1}>
                    <text
                      fg={
                        props.editingMessageID?.() === entry.item.id
                          ? props.theme().primary
                          : index() === 0 && !props.editing?.()
                            ? props.theme().primary
                            : props.theme().textMuted
                      }
                      flexShrink={0}
                    >
                      {entry.ordinal}.
                    </text>
                    <text
                      fg={props.editingMessageID?.() === entry.item.id ? props.theme().text : props.theme().textMuted}
                      flexGrow={1}
                      flexShrink={1}
                      wrapMode="none"
                    >
                      {itemText(entry.item)}
                    </text>
                    <box
                      flexShrink={0}
                      onMouseUp={() => {
                        if (props.disabled) return
                        props.onSendNow(entry.item.id)
                      }}
                    >
                      <text fg={props.disabled ? props.theme().textMuted : props.theme().text}>
                        <span style={{ fg: props.theme().textMuted }}>[</span>
                        send now
                        <span style={{ fg: props.theme().textMuted }}>]</span>
                      </text>
                    </box>
                    <box
                      flexShrink={0}
                      onMouseUp={() => {
                        if (props.disabled) return
                        props.onEdit(entry.item.id)
                      }}
                    >
                      <text fg={props.disabled ? props.theme().textMuted : props.theme().primary}>
                        <span style={{ fg: props.theme().textMuted }}>[</span>
                        edit
                        <span style={{ fg: props.theme().textMuted }}>]</span>
                      </text>
                    </box>
                    <box
                      flexShrink={0}
                      onMouseUp={() => {
                        if (props.disabled) return
                        props.onRemove(entry.item.id)
                      }}
                    >
                      <text fg={props.disabled ? props.theme().textMuted : props.theme().text}>
                        <span style={{ fg: props.theme().textMuted }}>[</span>
                        remove
                        <span style={{ fg: props.theme().textMuted }}>]</span>
                      </text>
                    </box>
                  </box>
                )}
              </For>
              <Show when={hiddenCount() > 0}>
                <text fg={props.theme().textMuted} flexShrink={0}>
                  +{hiddenCount()} more queued
                </text>
              </Show>
              <Show when={idleHint()}>
                <text fg={props.theme().textMuted} flexShrink={0} wrapMode="word">
                  {idleHint()}
                </text>
              </Show>
            </box>
          </Show>
        </Show>
        <Show when={total() > 0}>
          <box height={1} flexShrink={0} />
        </Show>
      </box>
    </Show>
  )
}
