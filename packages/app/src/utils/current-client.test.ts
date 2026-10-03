import { expect, test } from "bun:test"
import { OpenCode } from "./current-client"

test("the browser V2 client releases queue edits without waking inference", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        expect(url.pathname).toBe("/api/session/ses_test/queue/drain-resume")
        expect(url.searchParams.get("wake")).toBe("false")
        return new Response(null, { status: 204 })
      },
      { preconnect: () => {} },
    ),
  })
  await client.sessions.queueDrainResume({ sessionID: "ses_test", wake: false })
})

test("the browser V2 client retains inclusive rollback intent", async () => {
  const client = OpenCode.make({
    baseUrl: "http://localhost:3000",
    fetch: Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({ messageID: "msg_test", inclusive: true })
        return Response.json({ data: {} })
      },
      { preconnect: () => {} },
    ),
  })
  await client.sessions.stage({ sessionID: "ses_test", messageID: "msg_test", inclusive: true })
})
