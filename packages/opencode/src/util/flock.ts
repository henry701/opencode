import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"
import { Global } from "@/global"
import { Hash } from "@/util/hash"

export namespace Flock {
  const root = path.join(Global.Path.state, "locks")
  const staleMs = 60_000
  const timeoutMs = 5 * 60_000
  const baseDelayMs = 100
  const maxDelayMs = 2_000

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
    dir?: string
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null) return
    if (!("code" in err)) return
    const code = (err as { code?: unknown }).code
    if (typeof code !== "string") return
    return code
  }

  function nowMs() {
    return Date.now()
  }

  function opts(input: Input<unknown>): Opts {
    return {
      staleMs: input.staleMs ?? staleMs,
      timeoutMs: input.timeoutMs ?? timeoutMs,
      baseDelayMs: input.baseDelayMs ?? baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? maxDelayMs,
    }
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: ReturnType<typeof setTimeout> | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, staleMs: number) {
    const now = nowMs()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs > staleMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs > staleMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return false
    }

    return now - dir.mtimeMs > staleMs
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (err) {
      if (code(err) !== "EEXIST") {
        throw err
      }

      if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      try {
        await writeFile(breakerPath, token, { flag: "wx" })
      } catch (claimErr) {
        const errCode = code(claimErr)
        if (errCode === "EEXIST") {
          const breaker = await stats(breakerPath)
          if (breaker && nowMs() - breaker.mtimeMs > opts.staleMs) {
            await rm(breakerPath, { force: true }).catch(() => undefined)
          }
          return { acquired: false }
        }

        if (errCode === "ENOENT" || errCode === "ENOTDIR") {
          return { acquired: false }
        }

        throw claimErr
      }

      try {
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
          return { acquired: false }
        }

        await rm(lockDir, { recursive: true, force: true })

        try {
          await mkdir(lockDir, { mode: 0o700 })
        } catch (retryErr) {
          const errCode = code(retryErr)
          if (errCode === "EEXIST" || errCode === "ENOTEMPTY") {
            return { acquired: false }
          }
          throw retryErr
        }
      } finally {
        await rm(breakerPath, { force: true }).catch(() => undefined)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
    })

    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but meta.json already existed (possible compromise).")
    })

    let timer: ReturnType<typeof setInterval> | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const raw = await readFile(metaPath, "utf8")
      const current = JSON.parse(raw) as { token?: string }
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await rm(lockDir, { recursive: true, force: true })
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(lockDir: string, input: { waitTick?: Wait; signal?: AbortSignal }, opts: Opts) {
    const deadline = nowMs() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (nowMs() > deadline) {
        throw new Error(`Timed out waiting for lock: ${lockDir}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.waitTick?.({
        lockfile: lockDir,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function run<T>(input: Input<T>) {
    input.signal?.throwIfAborted()

    if (!(await input.check())) return

    const cfg = opts(input)
    const dir = input.dir ?? root

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(input.key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        waitTick: input.waitTick,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    try {
      input.signal?.throwIfAborted()
      if (!(await input.check())) return
      return await input.task()
    } finally {
      await lock.release()
    }
  }
}
