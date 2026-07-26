import type { SessionMessage, SessionMessageAssistant, SessionMessageUser } from "@opencode-ai/sdk/v2"

export function currentTimelineMessages(input: readonly SessionMessage[]) {
  return input
    .filter(
      (message): message is SessionMessageUser | SessionMessageAssistant =>
        message.type === "user" || message.type === "assistant",
    )
    .toSorted(
      (left, right) => Number(left.time.created) - Number(right.time.created) || left.id.localeCompare(right.id),
    )
}
