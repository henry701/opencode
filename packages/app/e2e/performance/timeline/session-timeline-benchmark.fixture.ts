import { base64Encode } from "@opencode-ai/core/util/encode"
import type { Page } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../../utils/waits"
import { expect } from "../benchmark"

const directory = "C:/OpenCode/TimelineStateRegression"
const projectID = "proj_timeline_state_regression"
const sessionID = "ses_timeline_state_regression"
const userMessageID = "msg_user_regression"
const assistantMessageID = "msg_assistant_regression"
const editPartID = "prt_0001_edit"
export const textPartID = "prt_9999_text"
const title = "Timeline collapse state regression"
const model = { providerID: "opencode", modelID: "claude-opus-4-6", variant: "max" }
let eventID = 0

type EventPayload = { id: string; type: string; data: Record<string, unknown>; durable?: Record<string, unknown> }

function currentEvent(type: string, data: Record<string, unknown>): EventPayload {
  const id = ++eventID
  return {
    id: `evt_benchmark_${id}`,
    type,
    data,
    ...(type.endsWith(".delta") ? {} : { durable: { aggregateID: sessionID, seq: id, version: 1 } }),
  }
}

const userMessage = {
  id: userMessageID,
  type: "user" as const,
  text: "Please edit the file.",
  files: [],
  agents: [],
  time: { created: 1700000000000 },
  payload: {
    version: 1 as const,
    agent: "build",
    model,
    parts: [{ id: "prt_user_text", type: "text", text: "Please edit the file." }],
  },
}

const editPart = {
  id: editPartID,
  type: "tool",
  name: "edit",
  time: { created: 1700000001000, completed: 1700000002000 },
  state: {
    status: "completed",
    input: { filePath: "src/regression.ts" },
    content: [{ type: "text", text: "Edited src/regression.ts" }],
    result: "Edited src/regression.ts",
    structured: {
      title: "src/regression.ts",
      filediff: {
        file: "src/regression.ts",
        additions: 1,
        deletions: 1,
        before: "export const value = 'before'\n",
        after: "export const value = 'after'\n",
      },
      diff: "diff --git a/src/regression.ts b/src/regression.ts\n-export const value = 'before'\n+export const value = 'after'\n",
    },
  },
}

const streamedTextPart = {
  id: textPartID,
  type: "text",
  text: "Streaming added a later assistant text part.",
}

const assistantMessage = {
  id: assistantMessageID,
  type: "assistant" as const,
  time: { created: 1700000001000 },
  agent: "build",
  model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
  cost: 0.01,
  tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
  content: [editPart],
}

export async function setupTimelineBenchmark(
  page: Page,
  options: {
    historyTurns: number
    eventBatch: number
    newLayoutDesigns?: boolean
    vcsDiff?: unknown[]
    turnDiffs?: unknown[]
  },
) {
  const events: EventPayload[] = []
  let eventBatch = options.eventBatch
  const currentAssistantMessage = options.turnDiffs
    ? { ...assistantMessage, snapshot: { diffs: options.turnDiffs } }
    : assistantMessage
  await mockOpenCodeServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session()],
    vcsDiff: options.vcsDiff,
    currentPageMessages: () => ({
      items: [
        ...Array.from({ length: options.historyTurns }, (_, index) => performanceTurn(index)).flat(),
        userMessage,
        currentAssistantMessage,
      ].toReversed(),
      throughSeq: 0,
    }),
    currentEvents: () => events.splice(0, eventBatch),
    eventRetry: 16,
  })
  await page.addInitScript(
    (input) => {
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({
          general: {
            newLayoutDesigns: input.newLayoutDesigns,
            editToolPartsExpanded: true,
            shellToolPartsExpanded: true,
            showReasoningSummaries: true,
          },
        }),
      )
    },
    { newLayoutDesigns: options.newLayoutDesigns ?? false },
  )
  await page.setViewportSize({ width: 1366, height: 768 })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const text = page.locator(`[data-timeline-part-id="${textPartID}"]`).first()
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  await expectAppVisible(scroller)
  return {
    scroller,
    text,
    transport: {
      enqueue(payload: EventPayload | EventPayload[]) {
        events.push(...(Array.isArray(payload) ? payload : [payload]))
      },
      pendingCount() {
        return events.length
      },
      releaseAll() {
        eventBatch = events.length
      },
    },
    async scrollToBottom() {
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
    },
    async waitForStableGeometry() {
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
        .toBeLessThanOrEqual(1)
      await page.waitForFunction((partID) => {
        const root = [...document.querySelectorAll<HTMLElement>(".scroll-view__viewport")].find((element) =>
          element.querySelector(`[data-timeline-part-id="${partID}"]`),
        )
        if (!root) return false
        return new Promise<boolean>((resolve) => {
          const height = root.scrollHeight
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve(root.scrollHeight === height && root.scrollHeight - root.clientHeight - root.scrollTop <= 1),
            ),
          )
        })
      }, textPartID)
    },
  }
}

export function buildInitialStreamEvent(deltaCount: number): EventPayload {
  return currentEvent("session.next.text.ended", {
    timestamp: 1700000002000,
    sessionID,
    assistantMessageID,
    textID: streamedTextPart.id,
    text: `Streaming${streamChunk(0, deltaCount + 1)}\n\n\`\`\`ts\nconst initial = true\n\`\`\``,
  })
}

export function buildStreamDeltaEvents(deltaCount: number): EventPayload[] {
  return Array.from({ length: deltaCount }, (_, index) =>
    currentEvent("session.next.text.delta", {
      timestamp: 1700000002000 + index,
      sessionID,
      assistantMessageID,
      textID: textPartID,
      delta: streamChunk(index + 1, deltaCount + 1),
    }),
  )
}

function performanceTurn(index: number) {
  const suffix = String(index).padStart(4, "0")
  const userID = `msg_0000_${suffix}_a_user`
  const assistantID = `msg_0000_${suffix}_b_assistant`
  const before = historicalSource(index, false)
  const after = historicalSource(index, true)
  const content = [
    ...(index % 5 === 0
      ? [
          {
            id: `prt_0000_${suffix}_reasoning`,
            type: "reasoning",
            text: `Reviewing the existing implementation. ${"constraint analysis ".repeat(20)}`,
            time: { created: 1690000001000 + index * 2_000, completed: 1690000001200 + index * 2_000 },
          },
        ]
      : []),
    {
      id: `prt_0000_${suffix}_assistant`,
      type: "text",
      text: historicalMarkdown(index),
    },
    ...(index % 8 === 0
      ? [
          {
            id: `prt_0000_${suffix}_edit`,
            type: "tool",
            name: "edit",
            time: { created: 1690000001200 + index * 2_000, completed: 1690000001400 + index * 2_000 },
            state: {
              status: "completed",
              input: { filePath: `src/history-${index}.ts` },
              content: [{ type: "text", text: `Edited src/history-${index}.ts` }],
              result: `Edited src/history-${index}.ts`,
              structured: {
                title: `src/history-${index}.ts`,
                filediff: { file: `src/history-${index}.ts`, additions: 48, deletions: 48, before, after },
              },
            },
          },
        ]
      : []),
    ...(index % 12 === 0
      ? [
          {
            id: `prt_0000_${suffix}_write`,
            type: "tool",
            name: "write",
            time: { created: 1690000001400 + index * 2_000, completed: 1690000001500 + index * 2_000 },
            state: {
              status: "completed",
              input: { filePath: `src/generated-${index}.tsx`, content: after },
              content: [{ type: "text", text: `Wrote src/generated-${index}.tsx` }],
              result: `Wrote src/generated-${index}.tsx`,
              structured: {
                title: `src/generated-${index}.tsx`,
                filediff: { file: `src/generated-${index}.tsx`, additions: 32, deletions: 0, before: "", after },
              },
            },
          },
        ]
      : []),
    ...(index % 16 === 0
      ? [
          {
            id: `prt_0000_${suffix}_patch`,
            type: "tool",
            name: "apply_patch",
            time: { created: 1690000001500 + index * 2_000, completed: 1690000001700 + index * 2_000 },
            state: {
              status: "completed",
              input: { patchText: realisticPatch(index) },
              content: [{ type: "text", text: "Success. Updated src/components/SessionCard.tsx" }],
              result: "Success. Updated src/components/SessionCard.tsx",
              structured: {
                title: "src/components/SessionCard.tsx",
                files: [
                  {
                    filePath: "src/components/SessionCard.tsx",
                    relativePath: "src/components/SessionCard.tsx",
                    type: "update",
                    additions: 8,
                    deletions: 3,
                    patch: realisticPatch(index),
                    before,
                    after,
                  },
                ],
              },
            },
          },
        ]
      : []),
  ]
  return [
    {
      id: userID,
      type: "user" as const,
      text: `Historical prompt ${index}`,
      files: [],
      agents: [],
      time: { created: 1690000000000 + index * 2_000 },
      payload: {
        version: 1 as const,
        agent: "build",
        model,
        parts: [{ id: `prt_0000_${suffix}_user`, type: "text", text: `Historical prompt ${index}` }],
      },
    },
    {
      id: assistantID,
      type: "assistant" as const,
      time: { created: 1690000001000 + index * 2_000, completed: 1690000001500 + index * 2_000 },
      agent: "build",
      model: { providerID: model.providerID, id: model.modelID, variant: model.variant },
      cost: 0.01,
      tokens: { input: 100, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
      content,
    },
  ]
}

function historicalMarkdown(index: number) {
  const code = `import { For, Show, createSignal } from "solid-js"

type SessionRow = { id: string; title: string; active: boolean }

export function SessionList(props: { rows: SessionRow[] }) {
  const [selected, setSelected] = createSignal<string>()
  return (
    <section aria-label="Sessions">
      <For each={props.rows}>{(row) => (
        <button classList={{ active: row.active }} onClick={() => setSelected(row.id)}>
          <Show when={selected() === row.id} fallback={row.title}>{row.title.toUpperCase()}</Show>
        </button>
      )}</For>
    </section>
  )
}`
  return `## Session renderer review ${index}

The active session keeps **semantic row identity** while reconciling measured content. See [Solid documentation](https://docs.solidjs.com/) and the inline \`measureElement(node)\` call.

| Concern | Current behavior | Verification |
| --- | --- | --- |
| streaming | appends Markdown blocks | painted frames |
| geometry | anchors visible rows | DOM coordinates |
| tools | preserves expanded state | keyed remount probe |

> Long sessions combine Markdown, syntax highlighting, tool output, and asynchronously rendered diffs.

${index % 4 === 0 ? `\`\`\`tsx\n${code}\n\`\`\`\n\n\`\`\`bash\nbun typecheck\nbun test --preload ./happydom.ts ./src/pages/session\ngit diff --check\n\`\`\`` : "- preserve the viewport anchor\n- avoid replacing stable Markdown nodes\n- process provider deltas without blocking input"}`
}

function historicalSource(index: number, updated: boolean) {
  const method = updated ? "toLocaleUpperCase(props.locale)" : "toUpperCase()"
  const limit = updated ? 24 : 20
  return `import { createMemo, For } from "solid-js"

type Message = {
  id: string
  role: "user" | "assistant"
  text: string
  tokens: { input: number; output: number }
}

export function MessageSummary(props: { messages: Message[]; locale: string }) {
  const visible = createMemo(() => props.messages.filter((message) => message.text.trim()).slice(-${limit}))
  const total = createMemo(() => visible().reduce((sum, message) => sum + message.tokens.output, 0))
  return (
    <article data-session-index="${index}">
      <header>{total().toLocaleString(props.locale)} output tokens</header>
      <For each={visible()}>{(message) => <p data-role={message.role}>{message.text.${method}}</p>}</For>
    </article>
  )
}
`
}

function realisticPatch(index: number) {
  return `*** Begin Patch
*** Update File: src/components/SessionCard.tsx
@@
-const title = props.session.title.toUpperCase()
-const messages = props.messages.slice(-20)
+const title = props.session.title.toLocaleUpperCase(props.locale)
+const messages = props.messages.filter((message) => message.text.trim()).slice(-24)
+const outputTokens = messages.reduce((sum, message) => sum + message.tokens.output, 0)
@@
-  <h2>{title}</h2>
+  <h2 data-session-index="${index}">{title}</h2>
+  <span>{outputTokens.toLocaleString(props.locale)} output tokens</span>
*** End Patch`
}

export function streamChunk(index: number, count: number) {
  if (index === 0) return `\n\n## Implementation plan\n\nStreaming **bold analysis`
  if (index === count - 1)
    return `\n\`\`\`\n\n## Verification\n\n- **Typecheck:** passed\n- **Timeline geometry:** stable\n- **Streaming output:** benchmark-complete <!-- stream-${index} -->`

  const section = Math.floor(index / 18) + 1
  const fragments = [
    ` continues across three`,
    ` or four word`,
    ` provider deltas and`,
    ` closes in this fragment**. <!-- stream-${index} -->\n\n`,
    `| Concern | State`,
    ` | Verification |\n|`,
    ` --- | ---`,
    ` | --- |\n|`,
    ` markdown | incremental |`,
    ` painted frames | <!-- stream-${index} -->\n\n`,
    `\`\`\`tsx\nconst row: SessionRow`,
    ` = rows[index] ??`,
    ` fallback\nconst title =`,
    ` row.title.toLocaleUpperCase(locale)\n`,
    `const selected = createMemo(()`,
    ` => row.id ===`,
    ` activeID()) // stream-${index}\n`,
    `// stream-${index}\n\`\`\`\n\n### Iteration ${section}\n\nStreaming **bold analysis`,
  ]
  return fragments[(index - 1) % fragments.length]!
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "timeline-state-regression",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session() {
  return {
    id: sessionID,
    slug: "timeline-state-regression",
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
  }
}

function provider() {
  return {
    all: [
      {
        id: "opencode",
        name: "OpenCode",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["opencode"],
    default: { providerID: "opencode", modelID: "claude-opus-4-6" },
  }
}
