import type { OpenCodeClient } from "@opencode-ai/client/promise"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"

export type ReplacementApi = Omit<OpenCodeClient, "session"> & {
  session: Omit<OpenCodeClient["session"], "revert"> & {
    revert: Omit<OpenCodeClient["session"]["revert"], "stage"> & {
      stage: (
        input: Parameters<OpenCodeClient["session"]["revert"]["stage"]>[0] & { inclusive?: boolean },
      ) => ReturnType<OpenCodeClient["session"]["revert"]["stage"]>
    }
  }
}

// The pinned promise client predates replacement mode. Use the generated SDK
// for this opt-in request until upstream exposes the field in that client.
export function withReplacementRevert(api: OpenCodeClient, sdk: OpencodeClient): ReplacementApi {
  return {
    ...api,
    session: {
      ...api.session,
      revert: {
        ...api.session.revert,
        stage: async (input: Parameters<OpenCodeClient["session"]["revert"]["stage"]>[0] & { inclusive?: boolean }) => {
          if (!input.inclusive) return api.session.revert.stage(input)
          const result = await sdk.v2.session.revert.stage(input, { throwOnError: true })
          return { ...result.data.data, files: result.data.data.files?.map((file) => ({ ...file, file: file.path })) }
        },
      },
    },
  }
}
