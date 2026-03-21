import path from "path"
import { FileLock } from "@opentui/core"
import { Global } from "@/global"
import { Hash } from "@/util/hash"

export namespace Flock {
  const root = path.join(Global.Path.state, "locks")

  export type Tick = {
    file: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: Tick) => void | Promise<void>

  type Input<T> = {
    file: string
    check: () => Promise<boolean>
    task: () => Promise<T>
    waitTick?: Wait
    signal?: AbortSignal
  }

  export function file(key: string) {
    return path.join(root, Hash.fast(key) + ".lock")
  }

  function abort(signal?: AbortSignal) {
    if (!signal?.aborted) return
    throw signal.reason ?? new DOMException("Aborted", "AbortError")
  }

  function delay(attempt: number) {
    return Math.min(50 * attempt, 250)
  }

  export async function run<T>(input: Input<T>) {
    abort(input.signal)

    if (!(await input.check())) return

    const lock = await FileLock.tryAcquireWithTimeout(input.file, {
      tickTime: delay,
      waitTick: input.waitTick,
      signal: input.signal,
    })
    if (!lock) return

    try {
      abort(input.signal)
      if (!(await input.check())) return
      return await input.task()
    } finally {
      lock.close()
    }
  }
}
