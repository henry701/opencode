# Alt+Enter Queueing + Web Queue Button — Implementation Plan

> **Superseded** by [PLAN_UNIFIED_PROMPT_QUEUE.md](./PLAN_UNIFIED_PROMPT_QUEUE.md) (SQLite `prompt_queue`, dormant `delivery: "deferred"` on prompt). This file is kept for historical context only.

Based on thorough analysis of the codebase, existing scaffolding, and relevant PRs.

## Current State Summary

The codebase already has significant scaffolding — the pieces just don't connect properly:

| Piece | Where | Status |
|-------|-------|--------|
| FIFO prompt queue | `runtime.queue.ts` | ✅ Works in TUI (for normal Enter submits) |
| `Delivery` type (immediate/deferred) | `v2/session.ts:18-23` | ✅ Schema exists, not differentiated |
| Followup dock UI (queue display) | `app/src/pages/session/composer/session-followup-dock.tsx` | ✅ Full UI, force-disabled |
| Followup queue state (queue items) | `app/src/pages/session.tsx:1437-1444` | ✅ Logic exists but setting forces steer |
| `input_newline` Alt+Enter binding | `keybind.ts:159` | ❌ Conflicts — Alt+Enter = newline |
| Backend prompt delivery | `session/prompt.ts:1215-1234` | ❌ Always calls `loop()` regardless |
| `ensureRunning` for queued messages | `effect/runner.ts:115-138` | ❌ Only handles ShellThenRun, not RunThenRun |
| Web queue-mode toggle button | `prompt-input.tsx` | ❌ Doesn't exist yet |

---

## 1. Backend (`packages/opencode`)

### 1a. Add `delivery` field to `PromptInput` schema

**File:** `src/session/prompt.ts`

Currently `PromptInput` (schema at `1706-1727`) has no delivery field. Add:

```ts
delivery: Schema.optional(DeliverySchema),
```

Where `DeliverySchema` derives from the existing type at `v2/session.ts:18-23`.

### 1b. Branch on `delivery` in `prompt()`

**File:** `src/session/prompt.ts:1215-1234`

Current:
```ts
if (input.noReply === true) return message
return yield* loop({ sessionID: input.sessionID })
```

New:
```ts
if (input.delivery === "deferred") {
  yield* queue.defer(sessionID, message)
  return message
}
if (input.noReply === true) return message
return yield* loop({ sessionID: input.sessionID })
```

### 1c. Add session-level deferred message queue to `SessionRunState`

**File:** `src/session/run-state.ts`

Add a deferred queue to the state:

```ts
type DeferredEntry = { messageID: MessageID; userMsg: MessageV2.WithParts }
type State = {
  runners: Map<SessionID, Runner<MessageV2.WithParts>>
  deferred: Map<SessionID, DeferredEntry[]>  // new
  scope: Scope.Scope
}
```

New methods:
- `defer(sessionID, message)` — pushes to the deferred queue, does not start a turn
- `drainDeferred(sessionID)` — returns all deferred messages for injection into the loop
- `hasDeferred(sessionID)` — checks if there are pending deferred messages

### 1d. Check deferred queue in `runLoop()` before break

**File:** `src/session/prompt.ts:1244-1522`

In `runLoop()`, the loop runs `while (true)` with `break/continue` based on the assistant finish state. Before breaking (around line 1290), check deferred queue:

```ts
if (yield* state.hasDeferred(sessionID)) {
  const deferred = yield* state.drainDeferred(sessionID)
  for (const entry of deferred) {
    entry.userMsg.parts[0].text = [
      "<system-reminder>",
      "The user sent the following message while you were busy:",
      entry.userMsg.parts[0].text,
      "</system-reminder>",
    ].join("\n")
    yield* sessions.updateMessage(entry.userMsg)
  }
  continue
}
```

Reuses the existing multi-user `<system-reminder>` injection pattern at `prompt.ts:1415-1431`.

### 1e. HTTP API: auto-include `delivery`

**File:** `src/server/routes/instance/httpapi/groups/session.ts:66`

`Struct.omit` already forwards unknown keys — `delivery` passes through automatically.

### 1f. HTTP handler passes delivery through

**File:** `src/server/routes/instance/httpapi/handlers/session.ts:286-300`

No change needed; handler already passes `body` fields through to `prompt()`.

---

## 2. TUI (`packages/opencode/src/cli/cmd/run`)

### 2a. Add `input_queue` keybinding + resolve conflict

**File:** `src/cli/cmd/tui/config/keybind.ts:159`

Current:
```ts
input_newline: keybind("shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline in input"),
```

Remove `alt+return` from `input_newline` (the other three already cover newline). The other three (`shift+return`, `ctrl+return`, `ctrl+j`) all work for newline insertion — users of those won't notice.

Add:
```ts
input_queue: keybind("alt+return", "Queue prompt for next turn"),
```

Add the command map entry:
```ts
input_queue: "input.queue",
```

### 2b. Extend `FooterKeybinds` type

**File:** `src/cli/cmd/run/types.ts:270-281`

Add `inputQueue`:
```ts
export type FooterKeybinds = {
  inputSubmit: readonly FooterBinding[]
  inputNewline: readonly FooterBinding[]
  inputQueue: readonly FooterBinding[]  // new
}
```

### 2c. Add `inputQueue` to runtime default keybinds

**File:** `src/cli/cmd/run/runtime.boot.ts:18-29`

```ts
const DEFAULT_KEYBINDS: FooterKeybinds = {
  inputQueue: [{ key: "alt+return" }],
}
```

And in `footerKeybinds()` (line 89-106):
```ts
inputQueue: config.keybinds.get("input.queue"),
```

### 2d. Update prompt-shared action type

**File:** `src/cli/cmd/run/prompt.shared.ts:125`

Change `"submit" | "newline"` to `"submit" | "newline" | "queue"`:

```ts
function mapInputBindings(
  bindings: FooterKeybinds["inputSubmit"],
  leader: string,
  action: "submit" | "newline" | "queue",
): KeyBinding[] { ... }
```

```ts
function textareaBindings(keybinds: FooterKeybinds): KeyBinding[] {
  return [
    ...mapInputBindings(keybinds.inputSubmit, keybinds.leader, "submit"),
    ...mapInputBindings(keybinds.inputNewline, keybinds.leader, "newline"),
    ...mapInputBindings(keybinds.inputQueue, keybinds.leader, "queue"),
  ]
}
```

### 2e. Handle `inputQueue` in footer prompt textarea

**File:** `src/cli/cmd/run/footer.prompt.tsx`

In the `onKeyDown` handler (line 915), intercept `alt+return` before it reaches the textarea's keybinding processor:

```ts
if (key.name === "return" && event.alt && !event.ctrl && !event.shift) {
  event.preventDefault()
  onQueue()
  return
}
```

Thread the `onQueue` callback through `PromptInput` type and `createPromptState`.

### 2f. Queue via runtime.queue.ts

**File:** `src/cli/cmd/run/runtime.queue.ts`

The existing runtime queue already drains one-at-a-time. `Alt+Enter` queues with a `delivery: "deferred"` flag. When a turn finishes, `drain()` dequeues and submits.

The key distinction: **Alt+Enter queues even when the agent is idle** (always defers), unlike Enter which either steers or queues based on followup setting. When Enter is pressed during a running turn, the current behavior is to queue. Alt+Enter explicitly goes to the back of the queue.

### 2g. Show queue depth in TUI footer

When items are queued via Alt+Enter, show a badge in the footer (e.g., `[3 queued]`), similar to the existing `interruptHint` pattern in `footer.tsx`.

---

## 3. Web (`packages/app`)

### 3a. Unforce queue mode in settings

**File:** `src/context/settings.tsx:169-193`

Remove all three force-conversion points:
- `createEffect` that resets "queue" to "steer"
- Getter that converts "queue" to "steer"
- Setter that rejects "queue"

```ts
// Getter — was: === "queue" ? "steer" : store.general?.followup
followup: withFallback(
  () => store.general?.followup,
  defaultSettings.general.followup,
),

// Setter — was: value === "queue" ? "steer" : value
setFollowup(value: "queue" | "steer") {
  setStore("general", "followup", value)
},
```

### 3b. Add queue toggle state to `PromptInput`

**File:** `src/components/prompt-input.tsx`

Add a local `queueMode` signal (default `false`). Toggled by:
- Clicking the new queue-toggle button
- Alt+Enter keypress

`queueMode` resets to `false` after a successful submit.

### 3c. Add queue-toggle button to composer bar

**File:** `src/components/prompt-input.tsx`

Insert a small `IconButton` immediately **left of the send/stop button** in both composer layouts:

**Layout 1 (top bar, ~line 1573):**
```
[attach] [agent] [model]   [queue-toggle] [send/stop]
```

**Layout 2 (inline, ~line 1715):**
```tsx
<div class="flex items-center gap-1 pointer-events-auto">
  [queue-toggle] [send/stop]
</div>
```

Button properties:
- Icon: `list` or `clock` (use existing icon set)
- Ghost variant when inactive (`queueMode === false`), tinted/filled variant when active
- Tooltip: `"Queue message (Alt+Enter)"` when inactive, `"Send directly"` when active
- `aria-label` reflects current mode
- Toggle behavior: clicking switches `queueMode` on/off

### 3d. Dynamic send icon

When `queueMode` is active, the send button shows a queue-like icon (e.g., `list`-type icon) instead of `arrow-up`. When `stopping()` is true, still show `stop` regardless of `queueMode`.

Priority: `stopping` > `queueMode` > default.

### 3e. Handle Alt+Enter in `handleKeyDown`

**File:** `src/components/prompt-input.tsx:1134`

Before the normal Enter handler, check for `event.altKey && event.key === "Enter"`:

```ts
if (event.altKey && event.key === "Enter") {
  event.preventDefault()
  setQueueMode(true)
  handleSubmit()
  return
}
```

### 3f. Wire `delivery: "deferred"` in submit

**File:** `src/components/prompt-input/submit.ts:155-162`

Pass `delivery: "deferred"` in the `promptAsync` call when `queueMode` is true. For normal sends, use `delivery: "immediate"` or omit.

### 3g. Update `queueEnabled` to include toggle state

**File:** `src/pages/session.tsx:1414-1418`

Expand `queueEnabled` (or wire `shouldQueue` prop) to also return true when `queueMode` is active, so the API call includes `delivery: "deferred"` and the followup dock displays queued messages:

```ts
shouldQueue={() => queueEnabled() || queueMode()}
```

### 3h. Web settings: restore followup dropdown queue option

After 3a, the settings page should show a working "Queue" option in the followup mode dropdown so users can make queueing the default behavior (not just per-message via button).

---

## Delivery Flow

```
User presses Alt+Enter (or toggles queue button and presses Enter)
  │
  ├── TUI path:
  │     footer.prompt.tsx onKeyDown detects alt+return
  │     → syncDraft(), set delivery="deferred" on RunPrompt
  │     → input.onQueue(draftWithDeferred)
  │     → runtime.queue.ts enqueue() pushes to state.queue[]
  │     → footer shows queue depth badge
  │     → runtime.ts pipes prompt.delivery → SessionTurnInput.delivery
  │     → stream.transport.ts:1021 includes delivery in req for promptAsync
  │     ├── If agent idle: server treats as immediate (calls loop())
  │     ├── If agent busy: server defers (stores in SessionRunState.deferred)
  │     │   → runLoop picks up deferred between turns via system-reminder wrapping
  │     └── If no loop running: deferred sits until next Enter triggers loop()
  │
  └── Web path:
        PromptInput detects (queue toggle active) or Alt+Enter
        → queueMode signal set to true
        → handleSubmit checks queueMode OR shouldQueue
        → queue path: onQueue(draft) → followup dock
        → sendFollowup() fires with delivery="deferred" in promptAsync
        ├── If agent idle: server treats as immediate
        ├── If agent busy: server defers (stores in SessionRunState.deferred)
        │   → runLoop picks up deferred between turns
        └── queueMode resets to false after submit
```

Key behaviors:
- **`delivery: "deferred"` plus idle session** → treated as immediate (client busy-check or server fallback)
- **`delivery: "deferred"` plus busy session** → stored in deferred queue, injected by `runLoop` before break
- **Alt+Enter always uses `delivery: "deferred"`** (the server decides what to do based on session state)
- **Web queue-toggle button** activates `queueMode` which makes `shouldQueue` return true regardless of idle/busy

---

## Files Changed Summary

### Backend (3 files)
- `packages/opencode/src/session/prompt.ts` — PromptInput schema (delivery field) + delivery branch in `prompt()` + deferred check in `runLoop()`
- `packages/opencode/src/session/run-state.ts` — deferred queue field + defer/drainDeferred/hasDeferred methods
- `packages/opencode/src/v2/session.ts` — no change (Delivery type already exists, prompt interface already accepts delivery)

### TUI (11 files)
- `packages/opencode/src/cli/cmd/tui/config/keybind.ts` — add `input_queue: alt+return`, remove from `input_newline`; add command map entry
- `packages/opencode/src/cli/cmd/run/types.ts` — add `inputQueue` to `FooterKeybinds`; add `delivery` to `RunPrompt`
- `packages/opencode/src/cli/cmd/run/runtime.boot.ts` — add to `DEFAULT_KEYBINDS` and `footerKeybinds()`
- `packages/opencode/src/cli/cmd/run/prompt.shared.ts` — add `"queue"` action type (for keybind display only, not textarea bindings)
- `packages/opencode/src/cli/cmd/run/footer.prompt.tsx` — Add `onQueue` to `PromptInput` type; Alt+Enter handler in `onKeyDown` with shell mode guard
- `packages/opencode/src/cli/cmd/run/runtime.queue.ts` — Add `enqueue()` method (push without drain)
- `packages/opencode/src/cli/cmd/run/runtime.ts` — Pipe `prompt.delivery` to `SessionTurnInput`; provide `onQueue` handler
- `packages/opencode/src/cli/cmd/run/stream.transport.ts` — Add `delivery` to `SessionTurnInput` type and to `req` object
- `packages/opencode/src/cli/cmd/run/footer.tsx` — queue depth indicator badge for queued deferred messages

### Web (8 files)
- `packages/app/src/context/settings.tsx` — unforce queue conversion (3 points: createEffect, getter, setter)
- `packages/app/src/components/prompt-input.tsx` — `queueMode` signal + toggle button in both layouts + Alt+Enter handler + dynamic send icon + shell mode guard
- `packages/app/src/components/prompt-input/submit.ts` — add `delivery` parameter to `sendFollowupDraft`; add `queueMode` to `PromptSubmitInput` and `handleSubmit`
- `packages/app/src/pages/session.tsx` — expand `queueEnabled` or wire `queueMode` callback; pass `delivery: "deferred"` in followup mutation
- `packages/app/src/pages/session/composer/session-composer-region.tsx` — wire `queueMode` prop from session to PromptInput
- `packages/app/src/pages/session/composer/session-followup-dock.tsx` — no change (works as-is)
- Settings UI — show working "Queue" option in followup dropdown

---

## Research Gaps: Delivery Plumbing Walkthrough

### Gap 1: TUI `RunPrompt` lacks delivery field

`RunPrompt` (`types.ts:34-42`) is the prompt data type that flows through the queue. It has no `delivery` field.

```ts
// Add to RunPrompt:
export type RunPrompt = {
  text: string
  parts: RunPromptPart[]
  mode?: "shell"
  command?: { name: string; arguments: string }
  delivery?: "immediate" | "deferred"   // new
}
```

### Gap 2: TUI `SessionTurnInput` lacks delivery field

`SessionTurnInput` (`stream.transport.ts:87-95`) is the transport's input type. Add:

```ts
export type SessionTurnInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: RunPrompt
  files: RunFilePart[]
  includeFiles: boolean
  delivery?: "immediate" | "deferred"   // new
  signal?: AbortSignal
}
```

### Gap 3: TUI `runtime.ts:647` must pipe delivery

The `runPromptTurn` call in `runtime.ts` builds the transport input from `prompt` (a `RunPrompt`). Pipe `prompt.delivery`:

```ts
await next.handle.runPromptTurn({
  agent: state.agent,
  model: state.model,
  variant: state.activeVariant,
  prompt,
  files: input.files,
  includeFiles,
  delivery: prompt.delivery,   // new
  signal,
})
```

### Gap 4: TUI `stream.transport.ts:1021` must include delivery in req

The `req` object passed to `promptAsync` must include `delivery`:

```ts
const req = {
  sessionID: input.sessionID,
  agent: next.agent,
  model: next.model,
  variant: next.variant,
  delivery: next.delivery,     // new — undefined for normal submits
  parts: [
    ...(next.includeFiles ? next.files : []),
    { type: "text" as const, text: next.prompt.text },
    ...next.prompt.parts,
  ],
}
```

The SDK's `prompt()` interface at `v2/session.ts:120` already accepts `delivery?: Delivery`, so the SDK call will forward it correctly.

### Gap 5: TUI `footer.prompt.tsx` needs `onQueue` callback

The `PromptInput` type at line 65 needs:

```ts
type PromptInput = {
  // ...existing...
  onQueue: (input: RunPrompt) => void   // new
}
```

In `onKeyDown` (line 915), intercept Alt+Enter:

```ts
if (key.name === "return" && event.alt && !event.ctrl && !event.shift) {
  event.preventDefault()
  syncDraft()
  const queuePrompt = { ...draft, delivery: "deferred" as const }
  input.onQueue(queuePrompt)
  return
}
```

Also skip Alt+Enter in shell mode and if empty text.

### Gap 6: TUI runtime must provide `onQueue` handler

The runtime caller (wherever `createPromptState` is invoked) must provide the `onQueue` handler. This is in `runtime.ts` or similar — the caller already provides `onSubmit`. The `onQueue` handler should:

1. Push the RunPrompt to the queue (same as `submit()`)
2. NOT call `drain()` (the deferred message stays queued until next normal Enter or turn completion)

The queue already handles this: `submit()` pushes and drains. For queue, we need a different function that only pushes:

```ts
// In runtime.ts, where the queue is created:
onQueue: (prompt: RunPrompt) => {
  // Access the queue's submit but don't drain
  // Alternatively, push directly to the queue's state
}
```

This is the trickiest part: the queue's state is internal to `runtime.queue.ts`. We may need to expose a `pushOnly()` method or let the caller manage the queue directly.

**Recommendation**: Add an `enqueue(prompt)` method alongside `submit(prompt)` in the queue that pushes without draining. Then `drain()` can also check for `delivery === "deferred"` and skip the `input.footer.idle()` wait since the server handles deferral.

### Gap 7: Web `sendFollowupDraft` lacks delivery parameter

`sendFollowupDraft` (`submit.ts:155`) calls `promptAsync` without `delivery`. Add it:

```ts
export async function sendFollowupDraft(input: FollowupSendInput) {
  // ...existing...
  await input.client.session.promptAsync({
    sessionID: input.draft.sessionID,
    agent: input.draft.agent,
    model: input.draft.model,
    messageID,
    delivery: input.delivery ?? "immediate",   // new
    parts: requestParts,
    variant: input.draft.variant,
  })
```

And update `FollowupSendInput` type to include optional `delivery`.

### Gap 8: Web `followupMutation` must pass delivery

`session.tsx:1386` calls `sendFollowupDraft` — the followup dock messages should use `delivery: "deferred"`:

```ts
const ok = await sendFollowupDraft({
  client: sdk.client,
  sync,
  serverSync,
  draft: item,
  delivery: "deferred",   // NEW — queued messages are always deferred
  optimisticBusy: item.sessionDirectory === sdk.directory,
})
```

### Gap 9: Web `handleSubmit` uses both queue and direct send paths

`handleSubmit` (`submit.ts:289`) has two paths:
1. **Queue path** (line 427): If `shouldQueue()` is true, calls `onQueue(draft)` and returns. The `onQueue` handler puts it in the followup dock for later delivery via `sendFollowup()`.
2. **Direct path** (line 557): Calls `sendFollowupDraft` directly for immediate sends.

The queue-toggle button should NOT change `handleSubmit`'s behavior — the queue path already exists. It just activates the queue path even when the session is idle (by making `shouldQueue` return true regardless of `busy(id)`).

However, for the toggle + Alt+Enter to work, `handleSubmit` needs to know about `queueMode`:

```ts
// handleSubmit — add queueMode check:
if (!isNewSession && mode === "normal" && (input.shouldQueue?.() || input.queueMode?.())) {
  input.onQueue?.(draft)
  clearContext()
  clearInput()
  return
}
```

Where `queueMode` is a new input to `createPromptSubmit`:

```ts
type PromptSubmitInput = {
  // ...existing
  shouldQueue?: Accessor<boolean>
  queueMode?: Accessor<boolean>   // new
  onQueue?: (draft: FollowupDraft) => void
  // ...
}
```

### Gap 10: Web `queueEnabled` needs queueMode awareness

Currently `queueEnabled` is:
```ts
queueEnabled = createMemo(() => {
  const id = params.id
  if (!id) return false
  return settings.general.followup() === "queue" && busy(id) && !composer.blocked() && !isChildSession()
})
```

With the toggle button, the session page needs to also check the local `queueMode` state. Since `queueMode` is inside `PromptInput`, it needs to be exposed via a ref or callback prop:

```ts
// In session.tsx, pass queueMode to session-composer-region:
followup={{
  queue: () => queueEnabled() || externalQueueMode(),
  // ...
}}
```

The `externalQueueMode` would come from `PromptInput` via a callback prop like `onQueueModeChange`.

**Simpler alternative**: Don't change `queueEnabled`. Instead, the `PromptInput` component internally handles the toggle: when `queueMode` is true, `shouldQueue` is true regardless of the parent's value. The `PromptInput`'s `handleSubmit` already has access to `queueMode` via `input.queueMode`.

This means:
- `shouldQueue` from parent: based on settings (followup = "queue" + busy)
- `queueMode` local: based on toggle button or Alt+Enter
- `handleSubmit` queues if EITHER is true

### Gap 11: Backend idle-deferred handling

When `delivery: "deferred"` arrives and no turn is running, `prompt()` defers the message but there's no `runLoop` to pick it up. The message sits in the deferred queue indefinitely.

**Two solutions:**

**A) Client-side check**: Only send `delivery: "deferred"` when the agent is busy. When idle, send with `delivery: "immediate"`. The TUI's `drain()` already waits for idle. For the web, the followup dock already gates on `busy(id)`.

**B) Server-side fallback**: In `prompt()`, if `delivery: "deferred"` and no runner exists for this session, treat as immediate (call `loop()`):

```ts
if (input.delivery === "deferred") {
  const hasRunner = yield* state.hasRunner(sessionID)
  if (!hasRunner) {
    return yield* loop({ sessionID: input.sessionID })
  }
  yield* queue.defer(sessionID, message)
  return message
}
```

**Recommendation**: Use **Solution A** — simpler, no extra server logic. The clients should check `busy()` before sending `delivery: "deferred"`. If idle, send immediate.

### Gap 12: Web `queueMode` signal lifecycle

The `queueMode` signal should:
- Be a local `createSignal(false)` inside `PromptInput`
- Default to `false` on mount
- Toggle to `true` when: user clicks queue-toggle button, or user presses Alt+Enter in textarea
- Reset to `false` after a successful submit (message sent)
- NOT be persisted (per-instance state)

```tsx
const [queueMode, setQueueMode] = createSignal(false)

const handleSubmit = async (event: Event) => {
  // ...existing submit logic...
  // On successful send:
  setQueueMode(false)
}
```

### Gap 13: TUI queue behavior for deferred entries

The TUI's `runtime.queue.ts` `submit()` function pushes to queue and calls `drain()`. For deferred messages, we need different behavior:

```ts
// Add to QueueInput type:
export type QueueInput = {
  // ...existing
  enqueue?: (prompt: RunPrompt) => void   // new — push without drain
}
```

The `enqueue()` function:
```ts
const enqueue = (prompt: RunPrompt) => {
  if (!prompt.text.trim() || state.closed) return
  state.queue.push(prompt)
  emit({ type: "queue", queue: state.queue.length }, { queue: state.queue.length })
  // Don't call drain()
}
```

The runtime caller provides `onQueue` which calls `enqueue()`.

### Gap 14: Shell mode guard (both TUI and Web)

Alt+Enter should be ignored in shell mode on both surfaces.

**TUI** (`footer.prompt.tsx`):
```ts
if (key.name === "return" && event.alt && !event.ctrl && !event.shift && !shell()) {
  // ...only fire in normal mode
}
```

**Web** (`prompt-input.tsx:1134`):
```ts
if (event.altKey && event.key === "Enter" && store.mode !== "shell") {
  event.preventDefault()
  setQueueMode(true)
  handleSubmit()
  return
}
```

### Gap 15: Empty text guard (both TUI and Web)

Alt+Enter with empty textarea should be a no-op.

**TUI**: The `enqueue()` function checks `!prompt.text.trim()`.

**Web**: `handleSubmit` already checks `text.trim().length === 0` at line 297 and returns early (or aborts if working).

### Gap 16: Web composer layout specifics for queue-toggle

There are TWO distinct composer layouts in `prompt-input.tsx`:

**Layout 1 — "dock" (top bar, line 1544-1589)**: Used in `DockShellForm` within the first `<Match>` (for existing sessions). The send button is at line 1573-1588. The queue-toggle button goes immediately before it (inside the same flex container at line 1544).

```tsx
<div class="flex h-11 items-center px-2">
  <div class="flex min-w-0 flex-1 items-center gap-0">
    {fileAttachmentInput()}
    <Show when={showAgentControl()}>
      <ComposerAgentControl state={agentControlState()} />
    </Show>
    {/* ... */}
    <ComposerModelControl state={modelControlState()} />
  </div>
  {queueToggleButton()}   {/* ← insert here */}
  <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
    <IconButton data-action="prompt-submit" ... />
  </Tooltip>
</div>
```

**Layout 2 — "inline" (line 1701-1728)**: Used in the second `<Match when>` (new sessions). The send button is inside `pointer-events-none` absolute positioned container. The queue-toggle goes inside the `pointer-events-auto` child:

```tsx
<div class="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2">
  <div class="flex items-center gap-1 pointer-events-auto">
    {queueToggleButton()}   {/* ← insert here */}
    <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
      <IconButton data-action="prompt-submit" ... />
    </Tooltip>
  </div>
</div>
```

### Gap 17: Textarea keybinding handling for "queue" action

The OpenTUI `<textarea>` only supports `action: "submit"` and `action: "newline"` natively. Adding `action: "queue"` entries to `textareaBindings` will be ignored by the textarea (unknown action).

The plan's approach is correct: handle Alt+Enter in `onKeyDown` instead of through the textarea's keybinding system. The `input_queue` keybinding is still defined in the Definitions/CommandMap for:
- Which-key display (so users can see "alt+return → Queue prompt" in the keybind help)
- Config override support (users can rebind it)

The `textareaBindings` should keep only "submit" and "newline" — do NOT add "queue" bindings to the textarea. Instead, the `inputQueue` binding is resolved separately for the onKeyDown handler.

### Edge Cases Summary

| Edge Case | Handling |
|-----------|----------|
| Alt+Enter in shell mode | Ignored (both TUI/web) |
| Alt+Enter with empty text | Ignored (text.trim check) |
| Deferred msg when idle | Client sends immediate instead (busy check) |
| Queue overflow (>50 msgs) | Hard limit, warn user |
| Multiple tabs/sessions | Per-session queue, no cross-contamination |
| `/new` or `/exit` with Alt+Enter | Treated as deferred text message (not a command) |
| TUI queue drain during running turn | `drain()` waits for `footer.idle()` first |
| Web queue-toggle after successful submit | `queueMode` resets to false |
| Queued messages after session close | Dropped (queue clears on close) |
| Concurrent deferred from SDK & queue | Server merges in FIFO order in runLoop |

---

## Testing

- **TUI:** Alt+Enter during active turn → message queues (depth indicator shows). After turn completes → queued message processes. Alt+Enter while idle → message queued, doesn't start turn.
- **Web:** Click queue-toggle button → send icon changes → Enter queues → message appears in followup dock. Alt+Enter → same behavior. Click again → back to normal send.
- **Settings:** Set followup to "queue" → all submits queue by default. Toggle button still works to override.
- **API:** `delivery: "deferred"` in POST body → no new turn starts. `delivery: "immediate"` or absent → normal behavior.
