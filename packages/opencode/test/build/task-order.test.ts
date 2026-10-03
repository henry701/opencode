import { expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "node:url"
import { z } from "zod"

test("plugin compilation waits for SDK generation", async () => {
  const graph = z
    .object({
      tasks: z.array(
        z.object({ taskId: z.string(), dependencies: z.array(z.string()), outputs: z.array(z.string()).nullable() }),
      ),
    })
    .parse(
      await $`${process.execPath} x turbo run build --filter=@opencode-ai/plugin --dry=json`
        .cwd(fileURLToPath(new URL("../../../..", import.meta.url)))
        .quiet()
        .json(),
    )
  expect(graph.tasks.find((task) => task.taskId === "@opencode-ai/plugin#build")?.dependencies).toContain(
    "@opencode-ai/sdk#build",
  )
  expect(graph.tasks.find((task) => task.taskId === "@opencode-ai/plugin#build")?.outputs).toEqual(["dist/**"])
}, 30_000)
