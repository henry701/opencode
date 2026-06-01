/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal } from "solid-js"
import type { QueuedItem } from "@/queue/preview"
import type { RunFooterTheme } from "./theme"

export function RunQueueDock(props: {
  items: () => QueuedItem[]
  theme: () => RunFooterTheme
  disabled?: boolean
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
}) {
  const [collapsed, setCollapsed] = createSignal(false)
  const total = () => props.items().length
  const label = () => (total() === 1 ? "1 message queued" : `${total()} messages queued`)
  const preview = () => props.items()[0]?.text ?? ""

  return (
    <Show when={total() > 0}>
      <box
        id="run-direct-footer-queue-dock"
        width="100%"
        flexDirection="column"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        gap={1}
      >
        <box
          flexDirection="row"
          gap={1}
          onMouseUp={() => setCollapsed((value) => !value)}
        >
          <text id="run-direct-footer-queue-dock-label" fg={props.theme().text} wrapMode="word" flexShrink={0}>
            {label()}
          </text>
          <Show when={collapsed() && preview()}>
            <text id="run-direct-footer-queue-dock-preview" fg={props.theme().muted} flexGrow={1} wrapMode="word">
              {preview()}
            </text>
          </Show>
          <text fg={props.theme().muted} flexShrink={0}>
            {collapsed() ? "▾" : "▴"}
          </text>
        </box>
        <Show when={!collapsed()}>
          <box flexDirection="column" gap={1} maxHeight={6}>
            <For each={props.items()}>
              {(item) => (
                <box flexDirection="row" gap={2} flexShrink={0}>
                  <text fg={props.theme().text} flexGrow={1} wrapMode="word">
                    {item.text}
                  </text>
                  <box
                    flexShrink={0}
                    onMouseUp={() => {
                      if (props.disabled) return
                      props.onSendNow(item.id)
                    }}
                  >
                    <text fg={props.disabled ? props.theme().muted : props.theme().text}>
                      <span style={{ fg: props.theme().muted }}>[</span>
                      send
                      <span style={{ fg: props.theme().muted }}>]</span>
                    </text>
                  </box>
                  <box
                    flexShrink={0}
                    onMouseUp={() => {
                      if (props.disabled) return
                      props.onEdit(item.id)
                    }}
                  >
                    <text fg={props.disabled ? props.theme().muted : props.theme().highlight}>
                      <span style={{ fg: props.theme().muted }}>[</span>
                      edit
                      <span style={{ fg: props.theme().muted }}>]</span>
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
