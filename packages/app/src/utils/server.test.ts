import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createApiForServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

describe("replacement revert transport", () => {
  test("sends opt-in replacement through the generated SDK with server authentication", async () => {
    const requests: Request[] = []
    const fetcher = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init)
        requests.push(request)
        return Response.json({
          data: {
            messageID: "msg_original",
            files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 1, patch: "patch" }],
          },
        })
      },
      { preconnect: () => {} },
    )
    const api = createApiForServer({ server: { url: "http://localhost:4096", password: "test-only" }, fetch: fetcher })
    const result = await api.session.revert.stage({ sessionID: "ses_test", messageID: "msg_original", inclusive: true })
    expect(requests[0]?.headers.get("authorization")).toBe(`Basic ${btoa("opencode:test-only")}`)
    expect(await requests[0]?.json()).toEqual({ messageID: "msg_original", inclusive: true })
    expect(result.files?.[0]?.file).toBe("a.ts")
  })
})
