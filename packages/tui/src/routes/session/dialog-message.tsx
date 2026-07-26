import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useClipboard } from "../../context/clipboard"
import type { PromptInfo } from "../../component/prompt/history"
import { currentPrompt } from "./current-prompt"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const data = useData()
  const sdk = useSDK()
  const message = createMemo(() =>
    data.session.message.list(props.sessionID)?.find((message) => message.id === props.messageID),
  )
  const route = useRoute()
  const clipboard = useClipboard()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
            const msg = message()
            if (!msg) return

            void sdk.next.sessions.stage({
              sessionID: props.sessionID,
              messageID: msg.id,
              files: true,
            })

            if (props.setPrompt && msg.type === "user") props.setPrompt(currentPrompt(msg))

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const text =
              msg.type === "user"
                ? currentPrompt(msg).input
                : msg.type === "assistant"
                  ? msg.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                  : ""

            await clipboard.write?.(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.next.sessions.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg?.type === "user" ? currentPrompt(msg) : undefined
            route.navigate({
              sessionID: result.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
