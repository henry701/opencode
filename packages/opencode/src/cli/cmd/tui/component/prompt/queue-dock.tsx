/** @jsxImportSource @opentui/solid */
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import { useCommandShortcut } from "@tui/keymap"
import { QueueDock, type QueuedItem } from "@/queue/queue-dock"

export function PromptQueueDock(props: {
  items: () => QueuedItem[]
  disabled?: boolean
  editing?: () => boolean
  editingMessageID?: () => string | undefined
  onEdit: (id: string) => void
  onSendNow: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { theme } = useTheme()
  const submitShortcut = useCommandShortcut("prompt.submit")
  const queueShortcut = useCommandShortcut("input.queue")
  const cancelShortcut = useCommandShortcut("input.queue.edit.cancel")
  const editShortcut = useCommandShortcut("input.queue.edit")
  const editNextShortcut = useCommandShortcut("input.queue.edit.next")

  return (
    <QueueDock
      items={props.items}
      theme={() => ({
        text: theme.text,
        textMuted: theme.textMuted,
        primary: theme.primary,
        border: theme.border,
      })}
      hints={() => ({
        submit: submitShortcut(),
        queue: queueShortcut(),
        cancel: cancelShortcut(),
        edit: editShortcut(),
        editNext: editNextShortcut(),
      })}
      customBorderChars={SplitBorder.customBorderChars}
      disabled={props.disabled}
      editing={props.editing}
      editingMessageID={props.editingMessageID}
      onEdit={props.onEdit}
      onSendNow={props.onSendNow}
      onRemove={props.onRemove}
    />
  )
}

export type { QueuedItem }
