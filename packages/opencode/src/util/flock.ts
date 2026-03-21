import path from "path"
import { FileLock } from "@opentui/core"
import { Global } from "@/global"
import { Hash } from "@/util/hash"

export namespace Flock {
  const root = path.join(Global.Path.state, "locks")

  type WaitTick = {
    lockfile: string
    attempt: number
    delay: number
    waited: number
  }

  type Wait = (input: WaitTick) => void | Promise<void>

  type Input<T> = {
    key: string
    check: () => Promise<boolean>
    task: () => Promise<T>
    waitTick?: Wait
    signal?: AbortSignal
  }

  function delay(attempt: number) {
    return Math.min(50 * attempt, 250)
  }

  export async function run<T>(input: Input<T>) {
    input.signal?.throwIfAborted()

    if (!(await input.check())) return

    const lockfile = path.join(root, Hash.fast(input.key) + ".lock")
    const lock = await FileLock.tryAcquireWithTimeout(lockfile, {
      tickTime: delay,
      waitTick: input.waitTick,
      signal: input.signal,
    })
    if (!lock) return

    try {
      input.signal?.throwIfAborted()
      if (!(await input.check())) return
      return await input.task()
    } finally {
      lock.close()
    }
  }
}
