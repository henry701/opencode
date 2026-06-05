// Prints mock LLM base URL on stdout for ad-hoc QA drivers (one line, no banner).
import { Effect } from "effect"
import { TestLLMServer } from "../test/lib/llm-server"

const program = Effect.gen(function* () {
  const llm = yield* TestLLMServer
  yield* llm.text("mock-ok")
  process.stdout.write(`${llm.url}\n`)
  yield* Effect.never
}).pipe(Effect.provide(TestLLMServer.layer))

Effect.runPromise(program).catch((error) => {
  console.error(error)
  process.exit(1)
})
