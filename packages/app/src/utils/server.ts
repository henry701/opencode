import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { withReplacementRevert } from "./server-revert"
import { OpenCode } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

function headers(server: ServerConnection.HttpBase, input?: HeadersInit | Record<string, unknown>) {
  const values =
    input instanceof Headers || Array.isArray(input)
      ? Object.fromEntries(new Headers(input).entries())
      : Object.fromEntries(
          Object.entries(input ?? {}).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])),
        )
  return {
    ...values,
    ...(server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({
            username: server.username,
            password: server.password,
          })}`,
        }
      : {}),
  }
}

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  return createOpencodeClient({
    ...config,
    headers: headers(server, config.headers),
    baseUrl: server.url,
  })
}

export function createApiForServer(input: { server: ServerConnection.HttpBase; fetch?: typeof globalThis.fetch }) {
  return withReplacementRevert(
    OpenCode.make({
      baseUrl: input.server.url,
      fetch: input.fetch,
      headers: input.server.password
        ? {
            Authorization: `Basic ${authTokenFromCredentials({
              username: input.server.username,
              password: input.server.password,
            })}`,
          }
        : undefined,
    }),
    createSdkForServer(input),
  )
}

export { createCurrentClientForServer } from "./current-client"
export type ServerApi = ReturnType<typeof createApiForServer>
