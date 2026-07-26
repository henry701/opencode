import { expect, test } from "bun:test"
import { createCurrentClientForServer } from "@/utils/server"

test("current server client preserves server auth and typed queue routing", async () => {
  const requests: Request[] = []
  const client = createCurrentClientForServer({
    server: {
      url: "https://example.test",
      username: "henry",
      password: "secret",
    },
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json({ data: [] })
      },
      { preconnect: () => undefined },
    ),
  })

  expect(await client.sessions.queueList({ sessionID: "ses_test" })).toEqual([])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe("https://example.test/api/session/ses_test/queue")
  expect(requests[0]?.headers.get("authorization")).toBe(`Basic ${btoa("henry:secret")}`)
})
