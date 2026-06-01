/** @jsxImportSource @opentui/solid */
import { For, Show, createMemo, createSignal } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { useCommandShortcut } from "@tui/keymap"
import type { QueuedItem } from "@/queue/preview"

export function PromptQueueDock(props: {
  items: () => QueuedItem[]
  disabled?: boolean
  editing?: () => boolean
  editingMessageID?: () => string | undefined
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
}) {
  const { theme } = useTheme()
  const [collapsed, setCollapsed] = createSignal(false)
  const queueShortcut = useCommandShortcut("input.queue")
  const editShortcut = useCommandShortcut("input.queue.edit")
  const editNextShortcut = useCommandShortcut("input.queue.edit.next")
  const submitShortcut = useCommandShortcut("prompt.submit")
  const cancelShortcut = useCommandShortcut("input.queue.edit.cancel")
  const total = () => props.items().length
  const label = createMemo(() => (total() === 1 ? "1 message queued" : `${total()} messages queued`))
  const preview = () => props.items()[0]?.text ?? ""

  const editingHint = createMemo(() => {
    if (!props.editing?.()) return undefined

    const submit = submitShortcut()
    const queue = queueShortcut()
    const cancel = cancelShortcut()
    const edit = editShortcut()
    const next = editNextShortcut()

    const parts = [
      submit ? `${submit} send now` : "Return send now",
      queue ? `${queue} save to queue` : "Ctrl+Shift+Enter save to queue",
    ]
    if (cancel) parts.push(`${cancel} cancel`)
    if (edit && next && total() > 1) parts.push(`${edit}/${next} switch`)
    return parts.join(" · ")
  })

  const footerHint = createMemo(() => {
    if (props.editing?.()) return editingHint()

    const edit = editShortcut()
    const queue = queueShortcut()
    if (edit && queue) return `${edit} edit oldest · ${queue} queue`
    if (edit) return `${edit} edit oldest`
    if (queue) return `${queue} queue`
    return undefined
  })

  return (
    <Show when={total() > 0 || props.editing?.()}>
      <box
        flexDirection="column"
        flexShrink={0}
        marginBottom={1}
        width="100%"
        border={["top"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={props.editing?.() ? theme.primary : theme.border}
        paddingTop={1}
      >
        <Show when={props.editing?.() && editingHint()}>
          <box flexDirection="column" paddingBottom={1} gap={1}>
            <text fg={theme.primary} flexShrink={0}>
              Editing queued message
            </text>
            <text fg={theme.textMuted} wrapMode="word">
              {editingHint()}
            </text>
          </box>
        </Show>
        <Show when={total() > 0}>
          <box flexDirection="row" gap={1} onMouseUp={() => setCollapsed((value) => !value)}>
            <text fg={theme.text} flexShrink={0}>
              {label()}
            </text>
            <Show when={collapsed() && preview()}>
              <text fg={theme.textMuted} flexGrow={1} wrapMode="word">
                {preview()}
              </text>
            </Show>
            <text fg={theme.textMuted} flexShrink={0}>
              {collapsed() ? "▾" : "▴"}
            </text>
          </box>
          <Show when={!collapsed()}>
            <box flexDirection="column" gap={1} maxHeight={8} paddingTop={1}>
              <For each={props.items()}>
                {(item, index) => (
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <text
                      fg={
                        props.editingMessageID?.() === item.id
                          ? theme.primary
                          : index() === 0 && !props.editing?.()
                            ? theme.primary
                            : theme.textMuted
                      }
                      flexShrink={0}
                    >
                      {index() + 1}.
                    </text>
                    <text
                      fg={props.editingMessageID?.() === item.id ? theme.text : theme.textMuted}
                      flexGrow={1}
                      wrapMode="word"
                    >
                      {item.text}
                    </text>
                    <box
                      flexShrink={0}
                      onMouseUp={() => {
                        if (props.disabled) return
                        props.onSendNow(item.id)
                      }}
                    >
                      <text fg={props.disabled ? theme.textMuted : theme.text}>
                        <span style={{ fg: theme.textMuted }}>[</span>
                        send now
                        <span style={{ fg: theme.textMuted }}>]</span>
                      </text>
                    </box>
                    <box
                      flexShrink={0}
                      onMouseUp={() => {
                        if (props.disabled) return
                        props.onEdit(item.id)
                      }}
                    >
                      <text fg={props.disabled ? theme.textMuted : theme.primary}>
                        <span style={{ fg: theme.textMuted }}>[</span>
                        edit
                        <span style={{ fg: theme.textMuted }}>]</span>
                      </text>
                    </box>
                  </box>
                )}
              </For>
            </box>
          </Show>
          <Show when={footerHint() && !props.editing?.()}>
            <text fg={theme.textMuted} paddingTop={1} wrapMode="word">
              {footerHint()}
            </text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}
