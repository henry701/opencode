import type { SessionMessageUser } from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../../prompt/history"

export function currentPrompt(message: SessionMessageUser): PromptInfo {
  const input =
    message.payload?.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
      .join("") || message.text
  const parts =
    message.payload?.parts.flatMap((part): PromptInfo["parts"] => {
      if (part.type !== "file" && part.type !== "agent") return []
      const { id: _id, ...value } = part
      return [value]
    }) ?? []
  return { input, parts }
}
