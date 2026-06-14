// Subprocess smoke: mocked LLM via `opencode serve`, deferred queue through the
// HTTP API (same path as TUI attach), plus optional `script` capture of
// `opencode attach` for a real terminal frame.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Scope } from "effect"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { cliIt, testModelID } from "../../lib/cli-process"
import { pollWithTimeout } from "../../lib/effect"

const opencodeRoot = path.resolve(import.meta.dir, "../../..")
const scriptPath = path.resolve(opencodeRoot, "../tui/test/cli/tui/scripts/prompt-queue-tui-smoke.sh")

test("prompt queue TUI smoke script exists", async () => {
  expect(await Bun.file(scriptPath).exists()).toBe(true)
})

const deferredAsPromise = <A>(deferred: Deferred.Deferred<A>): PromiseLike<A> => ({
  then: (onfulfilled, onrejected) => {
    Effect.runFork(
      Deferred.await(deferred).pipe(
        Effect.match({
          onFailure: (error) => {
            onrejected?.(error)
          },
          onSuccess: (value) => {
            onfulfilled?.(value)
          },
        }),
      ),
    )
    return deferredAsPromise(deferred) as PromiseLike<never>
  },
})

describe("prompt queue TUI smoke (serve + script)", () => {
  cliIt.live(
    "queues three deferred prompts in fifo via serve API and attach screencap",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("open", deferredAsPromise(gate))
        yield* llm.text("queue-1-done")
        yield* llm.text("queue-2-done")
        yield* llm.text("queue-3-done")

        const serve = yield* opencode.serve({ readyTimeoutMs: 30_000 })
        const artifactDir = path.join(home, "queue-tui-smoke")
        yield* Effect.tryPromise(() => mkdir(artifactDir, { recursive: true }))

        const sessionRes = yield* Effect.tryPromise(() =>
          fetch(`${serve.url}/session`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": home,
            },
            body: JSON.stringify({ title: "prompt-queue-tui-smoke" }),
          }),
        )
        expect(sessionRes.ok).toBe(true)
        const session = (yield* Effect.tryPromise(() => sessionRes.json())) as { id: string }
        const sessionID = session.id

        yield* Effect.tryPromise(() =>
          fetch(`${serve.url}/session/${sessionID}/prompt_async`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": home,
            },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: testModelID.split("/")[1] },
              parts: [{ type: "text", text: "open turn" }],
            }),
          }),
        )

        yield* Effect.sleep("150 millis")

        const script = yield* Effect.tryPromise(() =>
          Bun.spawn(["bash", scriptPath], {
            cwd: home,
            env: {
              ...process.env,
              OPENCODE_SERVER_URL: serve.url,
              OPENCODE_DIRECTORY: home,
              OPENCODE_SESSION_ID: sessionID,
              OPENCODE_ARTIFACT_DIR: artifactDir,
              OPENCODE_QUEUE_ONLY: "1",
              OPENCODE_CLI_ENTRY: path.join(opencodeRoot, "src/index.ts"),
            },
            stdout: "pipe",
            stderr: "pipe",
          }).exited,
        )
        expect(script).toBe(0)

        yield* Deferred.succeed(gate, void 0)

        yield* pollWithTimeout(
          llm.calls.pipe(Effect.map((n) => (n >= 4 ? true : undefined))),
          "timed out waiting for four mocked LLM calls",
          30_000,
        )

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(4)
        expect(JSON.stringify(inputs[1]?.messages)).toContain("queue-one")
        expect(JSON.stringify(inputs[1]?.messages)).not.toContain("queue-two")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("queue-two")
        expect(JSON.stringify(inputs[2]?.messages)).not.toContain("queue-three")
        expect(JSON.stringify(inputs[3]?.messages)).toContain("queue-three")

        const queued = yield* Effect.tryPromise(() => readFile(path.join(artifactDir, "queued.txt"), "utf8"))
        expect(queued.trim()).toBe("queued")

        const attach = yield* Effect.tryPromise(() =>
          readFile(path.join(artifactDir, "tui-attach.txt"), "utf8").catch(() => "attach skipped"),
        )
        expect(attach.length).toBeGreaterThan(0)
      }),
    120_000,
  )
})
