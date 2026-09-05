import { expect, test } from "bun:test"
import { SessionInput } from "@opencode-ai/core/session/input"
import { Schema } from "effect"
import { pendingInputMessages } from "../src/handlers/pending-inputs"

test("projects admitted inputs without dropping prompt content or changing their identity", () => {
  const input = Schema.decodeUnknownSync(SessionInput.Admitted)({
    id: "msg_pending",
    sessionID: "ses_pending",
    admittedSeq: 3,
    prompt: { text: "Preserve this", files: [{ uri: "data:text/plain;base64,aGk=", mime: "text/plain" }] },
    delivery: "steer",
    timeCreated: 1,
  })
  const [message] = pendingInputMessages([input])
  expect(message).toMatchObject({ id: input.id, type: "user", text: input.prompt.text, files: input.prompt.files })
  expect(message?.time.created).toEqual(input.timeCreated)
  expect(pendingInputMessages([])).toEqual([])
})
