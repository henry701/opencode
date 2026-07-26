export { OpenCode } from "@opencode-ai/current-client"
export type {
  MessagesListOutput,
  SessionsCommandInput,
  SessionsCommandOutput,
  SessionsEventsOutput,
  SessionsGetOutput,
  SessionsPromptInput,
  SessionsQueueEnqueueInput,
  SessionsQueueEnqueueOutput,
  SessionsQueueListOutput,
  SessionsQueueUpdateInput,
} from "@opencode-ai/current-client"

import { OpenCode } from "@opencode-ai/current-client"
import type { ServerConnection } from "@/context/server"

export type CurrentClient = ReturnType<typeof OpenCode.make>

export function createCurrentClientForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}) {
  return OpenCode.make({
    baseUrl: input.server.url,
    fetch: input.fetch,
    headers: input.server.password
      ? { Authorization: `Basic ${btoa(`${input.server.username ?? "opencode"}:${input.server.password}`)}` }
      : undefined,
  })
}
