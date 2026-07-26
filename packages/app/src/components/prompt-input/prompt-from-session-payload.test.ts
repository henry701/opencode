import { describe, expect, test } from "bun:test"
import type { SessionInputPayload } from "@opencode-ai/schema/session-input-payload"
import { promptFromSessionPayload } from "./prompt-from-session-payload"

describe("promptFromSessionPayload", () => {
  test("restores native text, file, agent, and image parts without an SDK message adapter", () => {
    const payload = {
      version: 1,
      agent: "reviewer",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [
        { type: "text", text: "Review @src/main.ts with @build" },
        {
          type: "file",
          mime: "text/plain",
          filename: "main.ts",
          url: "file:///repo/src/main.ts",
          source: {
            type: "file",
            path: "/repo/src/main.ts",
            text: { value: "@src/main.ts", start: 7, end: 19 },
          },
        },
        {
          type: "agent",
          name: "build",
          source: { value: "@build", start: 25, end: 31 },
        },
        {
          id: "img_1",
          type: "file",
          mime: "image/png",
          filename: "diagram.png",
          url: "data:image/png;base64,AA==",
        },
      ],
    } as unknown as SessionInputPayload.Payload

    const prompt = promptFromSessionPayload(payload, { directory: "/repo", attachmentName: "attachment" })

    expect(prompt.map((part) => ("content" in part ? part.content : part.filename)).join("")).toBe(
      "Review @src/main.ts with @builddiagram.png",
    )
    expect(prompt).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", path: "src/main.ts", content: "@src/main.ts" }),
        expect.objectContaining({ type: "agent", name: "build", content: "@build" }),
        expect.objectContaining({ type: "image", filename: "diagram.png" }),
      ]),
    )
  })

  test("ignores synthetic, ignored, and subtask parts when restoring editable text", () => {
    const payload = {
      version: 1,
      agent: "reviewer",
      model: { providerID: "openai", modelID: "gpt-5" },
      parts: [
        { type: "text", text: "hidden", synthetic: true },
        { type: "text", text: "ignored", ignored: true },
        { type: "subtask", prompt: "delegate", description: "delegate work", agent: "reviewer" },
        { type: "text", text: "Visible" },
      ],
    } as unknown as SessionInputPayload.Payload

    expect(promptFromSessionPayload(payload)).toEqual([{ type: "text", content: "Visible", start: 0, end: 7 }])
  })
})
