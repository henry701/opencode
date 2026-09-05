// Subprocess smoke: mocked LLM via `opencode serve`, deferred queue through the
// HTTP API (same path as TUI attach), plus optional `script` capture of
// `opencode attach` for a real terminal frame.
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Scope } from "effect"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import stripAnsi from "strip-ansi"
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

describe.each([false, true])("prompt queue TUI smoke (skipAttach=%s)", (skipAttach) => {
  cliIt.live(
    "queues three deferred prompts in fifo via serve API and attach screencap",
    ({ llm, home, opencode }) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>()
        yield* llm.hold("open", deferredAsPromise(gate))
        yield* llm.text("queue-1-done")
        yield* llm.text("queue-2-done")
        yield* llm.text("queue-3-done")

        yield* Effect.tryPromise(() =>
          Bun.write(
            path.join(home, "opencode.json"),
            JSON.stringify({
              providers: {
                test: {
                  name: "Test",
                  env: [],
                  api: {
                    type: "aisdk",
                    package: "@ai-sdk/openai-compatible",
                    url: llm.url,
                  },
                  request: { body: { apiKey: "test-key" } },
                  models: {
                    "test-model": {
                      api: { id: "test-model" },
                      capabilities: {
                        tools: true,
                        input: ["text"],
                        output: ["text"],
                      },
                      limit: { context: 100_000, output: 10_000 },
                    },
                  },
                },
              },
            }),
          ),
        )
        const serve = yield* opencode.serve({
          readyTimeoutMs: 30_000,
          env: { OPENCODE_PRINT_LOGS: "1" },
        })
        const artifactDir = path.join(home, "queue-tui-smoke")
        yield* Effect.tryPromise(() => mkdir(artifactDir, { recursive: true }))

        const sessionRes = yield* Effect.tryPromise(() =>
          fetch(`${serve.url}/api/session`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": home,
            },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", id: testModelID.split("/")[1] },
              location: { directory: home },
            }),
          }),
        )
        expect(sessionRes.ok).toBe(true)
        const session = (yield* Effect.tryPromise(() => sessionRes.json())) as { data: { id: string } }
        const sessionID = session.data.id

        const opened = yield* Effect.tryPromise(() =>
          fetch(`${serve.url}/api/session/${sessionID}/prompt`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": home,
            },
            body: JSON.stringify({
              payload: {
                version: 1,
                agent: "build",
                model: { providerID: "test", modelID: testModelID.split("/")[1] },
                parts: [{ type: "text", text: "open turn" }],
              },
            }),
          }),
        )
        if (!opened.ok) throw new Error(`failed to open current turn: ${opened.status} ${yield* Effect.promise(() => opened.text())}`)

        yield* Effect.sleep("150 millis")

        const script = yield* Effect.tryPromise(async () => {
          const child = Bun.spawn(["bash", scriptPath], {
            cwd: home,
            env: {
              ...process.env,
              OPENCODE_SERVER_URL: serve.url,
              OPENCODE_DIRECTORY: home,
              OPENCODE_SESSION_ID: sessionID,
              OPENCODE_ARTIFACT_DIR: artifactDir,
              OPENCODE_QUEUE_ONLY: "1",
              OPENCODE_EDIT_FIRST: "1",
              OPENCODE_SKIP_ATTACH: skipAttach ? "1" : "0",
              OPENCODE_CLI_ENTRY: path.join(opencodeRoot, "src/index.ts"),
            },
            stdout: "pipe",
            stderr: "pipe",
          })
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          return { exitCode, stdout, stderr }
        })
        yield* Deferred.succeed(gate, void 0)
        if (script.exitCode !== 0) {
          const capture = yield* Effect.promise(() =>
            readFile(path.join(artifactDir, "tui-attach.txt"), "utf8").catch(() => "attach capture unavailable"),
          )
          throw new Error(
            `queue smoke failed\nstderr=${script.stderr}\nstdout=${script.stdout}\nserver=${serve.stderr()}\nattach=${stripAnsi(capture).slice(-4_000)}`,
          )
        }
        expect(script.exitCode).toBe(0)

        const drained = yield* pollWithTimeout(
          llm.calls.pipe(Effect.map((n) => (n >= 4 ? true : undefined))),
          "timed out waiting for four mocked LLM calls",
          30_000,
        ).pipe(
          Effect.map(() => undefined),
          Effect.catch((error) => Effect.succeed(error)),
        )
        if (drained instanceof Error) {
          const calls = yield* llm.calls
          const queue = yield* Effect.tryPromise(() =>
            fetch(`${serve.url}/api/session/${sessionID}/queue`).then((response) => response.text()),
          )
          const active = yield* Effect.tryPromise(() =>
            fetch(`${serve.url}/api/session/active`).then((response) => response.text()),
          )
          const context = yield* Effect.tryPromise(() =>
            fetch(`${serve.url}/api/session/${sessionID}/context`).then((response) => response.text()),
          )
          const history = yield* Effect.tryPromise(() =>
            fetch(`${serve.url}/api/session/${sessionID}/history`).then((response) => response.text()),
          )
          throw new Error(
            `${drained.message}; calls=${calls}; queue=${queue}; active=${active}; context=${context}; history=${history}; stderr=${serve.stderr()}`,
          )
        }

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(4)
        expect(JSON.stringify(inputs[1]?.messages)).toContain("queue-one-edited")
        expect(JSON.stringify(inputs[1]?.messages)).not.toContain("queue-two")
        expect(JSON.stringify(inputs[2]?.messages)).toContain("queue-two")
        expect(JSON.stringify(inputs[2]?.messages)).not.toContain("queue-three")
        expect(JSON.stringify(inputs[3]?.messages)).toContain("queue-three")

        const queued = yield* Effect.tryPromise(() => readFile(path.join(artifactDir, "queued.txt"), "utf8"))
        expect(queued.trim()).toBe("queued")

        const edited = yield* Effect.tryPromise(() => readFile(path.join(artifactDir, "edited.txt"), "utf8"))
        expect(edited.trim()).toBe("queue-one-edited")

        const attach = yield* Effect.tryPromise(() =>
          readFile(path.join(artifactDir, "tui-attach.txt"), "utf8").catch(() => "attach skipped"),
        )
        expect(attach.length).toBeGreaterThan(0)
        if (skipAttach) expect(attach).toContain("queue edit exercised through API, not terminal")
      }),
    120_000,
  )
})
