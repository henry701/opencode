import { For, Show, createSignal } from "solid-js"
import { useTheme } from "@tui/context/theme"
import type { QueuedItem } from "@/queue/preview"

export function PromptQueueDock(props: {
  items: () => QueuedItem[]
  disabled?: boolean
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
}) {
  const { theme } = useTheme()
  const [collapsed, setCollapsed] = createSignal(false)
  const total = () => props.items().length
  const label = () => (total() === 1 ? "1 message queued" : `${total()} messages queued`)
  const preview = () => props.items()[0]?.text ?? ""

  return (
    <Show when={total() > 0}>
      <box flexDirection="column" flexShrink={0} marginBottom={1} width="100%">
        <box
          flexDirection="row"
          gap={1}
          paddingBottom={collapsed() ? 0 : 1}
          onMouseUp={() => setCollapsed((value) => !value)}
        >
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
          <box flexDirection="column" gap={1} maxHeight={6}>
            <For each={props.items()}>
              {(item) => (
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <text fg={theme.text} flexGrow={1} wrapMode="word">
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
                      send
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
      </box>
    </Show>
  )
}
