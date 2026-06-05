/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js"
import { QueueDock, type QueuedItem } from "@/queue/queue-dock"
import type { RunFooterTheme } from "./theme"
import { printableBinding } from "./prompt.shared"
import type { FooterKeybinds } from "./types"

export function RunQueueDock(props: {
  items: () => QueuedItem[]
  theme: () => RunFooterTheme
  keybinds: FooterKeybinds
  disabled?: boolean
  editing?: () => boolean
  editingMessageID?: () => string | undefined
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
}) {
  const hints = createMemo(() => ({
    submit: printableBinding(props.keybinds.inputSubmit, props.keybinds.leader) || "return",
    queue: printableBinding(props.keybinds.inputQueue, props.keybinds.leader) || "ctrl+shift+return",
    cancel: printableBinding(props.keybinds.inputEditQueueCancel, props.keybinds.leader) || "escape",
    edit: printableBinding(props.keybinds.inputEditQueue, props.keybinds.leader) || "alt+up",
    editNext: printableBinding(props.keybinds.inputEditQueueNext, props.keybinds.leader) || "alt+down",
  }))

  return (
    <QueueDock
      items={props.items}
      theme={() => ({
        text: props.theme().text,
        textMuted: props.theme().muted,
        primary: props.theme().highlight,
        border: props.theme().border,
      })}
      hints={hints}
      disabled={props.disabled}
      editing={props.editing}
      editingMessageID={props.editingMessageID}
      onEdit={props.onEdit}
      onSendNow={props.onSendNow}
    />
  )
}

export type { QueuedItem }
