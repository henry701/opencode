import { useServerSDK } from "@/context/server-sdk"
import { useSDK } from "@/context/sdk"
import { createResource } from "solid-js"

export function useCurrentCommands() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [commands] = createResource(
    () => [serverSDK().currentClient, sdk().directory] as const,
    ([client, directory]) => client.commands.list({ location: { directory } }).then((result) => result.data),
  )
  return () => commands() ?? []
}
