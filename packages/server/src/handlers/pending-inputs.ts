import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"

// This is a UI projection only. The runner still owns transcript promotion.
export function pendingInputMessages(inputs: readonly SessionInput.Admitted[]) {
  return inputs.map((input) =>
    SessionMessage.User.make({
      id: input.id,
      type: "user",
      text: input.prompt.text,
      files: input.prompt.files,
      agents: input.prompt.agents,
      payload: input.payload,
      time: { created: input.timeCreated },
    }),
  )
}
