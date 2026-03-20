import { mkdir } from "fs/promises"
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

  async function sleep(ms: number, signal?: AbortSignal) {
    abort(signal)
    return new Promise<void>((resolve, reject) => {
      const id = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)

      function onAbort() {
        clearTimeout(id)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      }

      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  export async function run<T>(input: Input<T>) {
    if (!(await input.check())) return

    await mkdir(path.dirname(input.file), { recursive: true })

    let attempt = 0
    let waited = 0

    while (true) {
      abort(input.signal)

      const lock = FileLock.tryAcquire(input.file)
      if (lock) {
        try {
          if (!(await input.check())) return
          return await input.task()
        } finally {
          lock.close()
        }
      }

      attempt += 1
      const ms = delay(attempt)
      waited += ms
      await input.waitTick?.({
        file: input.file,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
    }
  }
}
