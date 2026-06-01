# Alt+Enter Queueing + Web Queue Button — Implementation Plan

## Overview

Add deferred message queueing to opencode: Alt+Enter queues a message (defers it to the next turn) on all three surfaces (backend, TUI, web). On web, also add a visible queue-toggle button next to the send/stop button so users can queue without memorizing a shortcut.

---

## 1. Backend (`packages/opencode`)

### 1a. Add `delivery` field to `PromptInput` schema
**File:** `src/session/prompt.ts:1706-1727`

Add optional `delivery` field to the `PromptInput` struct schema using the existing `Delivery` type from `v2/session.ts`.

```ts
// PromptInput already has other fields; add:
delivery: Schema.optional(DeliverySchema),
```

### 1b. Branch on `delivery` in `prompt()`
**File:** `src/session/prompt.ts:1215-1234`

After building the message and session state, check `input.delivery`:
- If `"deferred"`: skip `loop()` and `ensureRunning`, push the message onto `SessionRunState.deferred` queue, return early.
- If `"immediate"` or absent: current behavior (call `loop()`).

### 1c. Add deferred queue to `SessionRunState`
**File:** `src/session/run-state.ts`

Add a field:
```ts
deferred: Message[]
```
Initialize as empty array.

### 1d. Check deferred queue in `runLoop()` before break
**File:** `src/session/prompt.ts:1244-1522`

In the `runLoop` function, before breaking on completion, check if `SessionRunState.deferred` has items. If so, wrap them in `<system-reminder>` (reusing the multi-user pattern at lines 1415-1431) and continue the loop instead of breaking. Drain the queue in FIFO order.

### 1e. HTTP API: auto-include `delivery`
**File:** `src/server/routes/instance/httpapi/groups/session.ts:66`

`Struct.omit` already forwards unknown keys — `delivery` passes through automatically.

### 1f. HTTP handler passes delivery through
**File:** `src/server/routes/instance/httpapi/handlers/session.ts:286-300`

No change needed; handler already passes `body` fields through to `prompt()`.

---

## 2. TUI (`packages/opencode/src/cli/cmd/run`)

### 2a. Add `input_queue` keybinding
**File:** `src/cli/cmd/tui/config/keybind.ts:159`

Remove `alt+return` from `input_newline` (keeping `shift+return`, `ctrl+return`, `ctrl+j`). Add `alt+return → input_queue`.

### 2b. Add `"queue"` to `FooterKeybinds` type
**File:** `src/cli/cmd/run/types.ts:270-281`

Change from `"submit" | "newline"` to `"submit" | "newline" | "queue"`.

### 2c. Add `inputQueue` to runtime
**File:** `src/cli/cmd/run/runtime.boot.ts:18-29`

Add `alt+return` → `inputQueue` mapping in `DEFAULT_KEYBINDS`.

### 2d. Update prompt-shared type
**File:** `src/cli/cmd/run/prompt.shared.ts:125`

Extend keybinding action type union to include `"queue"`.

### 2e. Handle `inputQueue` in footer prompt
**File:** `src/cli/cmd/run/footer.prompt.tsx`

In `onKeyDown`, check for `input_queue` action. When triggered, call `onQueue` with the current prompt content instead of `onSubmit`.

### 2f. Queue through runtime.queue.ts
**File:** `src/cli/cmd/run/runtime.queue.ts`

The existing runtime queue already holds prompts before SDK submission. `Alt+Enter` adds to this queue with a `delivery: "deferred"` flag. On subsequent Enter (when idle), the runtime drains the queue and submits with `delivery: "immediate"`.

### 2g. Show queue depth in TUI footer
When items are queued, show a small badge/indicator in the footer (e.g., `[3 queued]`).

---

## 3. Web (`packages/app`)

### 3a. Unforce queue setting
**File:** `src/context/settings.tsx:169-193`

Remove the force-conversion of `"queue"` → `"steer"` at all three points (getter guard, `createEffect`, setter override).

### 3b. Add queue toggle state to `PromptInput`
**File:** `src/components/prompt-input.tsx`

Add local `queueMode` signal (default `false`). Toggled by:
- Clicking the new queue-toggle button
- Alt+Enter keypress

### 3c. Add queue-toggle button to composer bar
**File:** `src/components/prompt-input.tsx`

Insert a small `IconButton` immediately **left of the send/stop button** in both layouts:

**Layout 1 (top bar, ~line 1573):**
```
[attach] [agent] [model]   [queue-toggle] [send/stop]
```

**Layout 2 (inline, ~line 1715):**
```
<div class="flex items-center gap-1 pointer-events-auto">
  [queue-toggle] [send/stop]
</div>
```

- Icon: `list` or `clock` (use existing icon set; fallback to `circle` if neither exists)
- Ghost variant when inactive, tinted/filled variant when active
- Tooltip: `"Queue message (Alt+Enter)"` / `"Send directly"`
- `aria-label` reflects current mode

### 3d. Dynamic send icon
When `queueMode` is active, the send button shows a queue-like icon instead of `arrow-up`. When `stopping()` is true, still show `stop`.

### 3e. Handle Alt+Enter in `handleKeyDown`
**File:** `src/components/prompt-input.tsx:1134`

Before the normal Enter handler, check for `event.altKey && event.key === "Enter"`:
- Set `queueMode` to true
- Trigger submit (which will read `queueMode` and queue)

### 3f. Wire `delivery: "deferred"` in `sendFollowupDraft`
**File:** `src/components/prompt-input/submit.ts:155-162`

Pass `delivery: "deferred"` in the `promptAsync` call when the message was queued. For normal sends, use `delivery: "immediate"` or omit.

### 3g. Update `queueEnabled` to include toggle state
**File:** `src/pages/session.tsx:1414-1418`

The `queueEnabled` memo currently checks `settings.general.followup() === "queue"`. With the toggle button, expand to also check local `queueMode` state (passed via `shouldQueue` prop).

Alternatively, pass `queueMode` directly as a separate prop that overrides `shouldQueue`:
```ts
shouldQueue={() => queueEnabled() || queueMode()}
```

### 3h. Settings page: restore followup mode toggle
**File:** `src/context/settings.tsx` + settings UI

After unforcing the conversion, the settings page should show a working "Queue" option in the followup dropdown so users can make queueing the default behavior (not just per-message via button).

---

## Files Changed (27 total)

### Backend (6)
- `packages/opencode/src/session/prompt.ts` — schema + branching + runLoop check
- `packages/opencode/src/session/run-state.ts` — deferred queue field
- `packages/opencode/src/v2/session.ts` — (already has Delivery type, no change needed)

### TUI (7)
- `packages/opencode/src/cli/cmd/tui/config/keybind.ts`
- `packages/opencode/src/cli/cmd/run/types.ts`
- `packages/opencode/src/cli/cmd/run/runtime.boot.ts`
- `packages/opencode/src/cli/cmd/run/prompt.shared.ts`
- `packages/opencode/src/cli/cmd/run/footer.prompt.tsx`
- `packages/opencode/src/cli/cmd/run/runtime.queue.ts`
- `packages/opencode/src/cli/cmd/run/footer.tsx` (queue depth indicator)

### Web (14)
- `packages/app/src/context/settings.tsx` — unforce conversion
- `packages/app/src/components/prompt-input.tsx` — toggle state + button + Alt+Enter + dynamic icon
- `packages/app/src/components/prompt-input/submit.ts` — delivery field
- `packages/app/src/pages/session.tsx` — queueEnabled includes toggle
- `packages/app/src/pages/session/composer/session-composer-region.tsx` — pass queueMode prop
- `packages/app/src/pages/session/composer/session-followup-dock.tsx` — (no change, works as-is)
- `packages/app/src/context/settings.tsx` — settings UI followup dropdown

---

## Testing

- **TUI:** Alt+Enter during active turn → message queues (depth indicator shows). After turn completes → queued message processes. Alt+Enter while idle → message queued, doesn't start turn.
- **Web:** Click queue-toggle button → send icon changes → Enter queues → message appears in followup dock. Alt+Enter → same behavior. Settings followup mode → queue as default.
- **API:** `delivery: "deferred"` → no new turn. `delivery: "immediate"` or absent → normal behavior.
