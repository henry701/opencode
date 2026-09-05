# Fork web compatibility audit

Updated: 2026-09-05.

## Release decision

**Merge authorized with known follow-ups.** On 2026-09-05 the repository owner
explicitly requested committing and pushing every current improvement and merging
production PR #7 and development PR #8, with remaining issues handled in follow-up
PRs. This supersedes the earlier draft/release hold. It does not mean the full
browser suite or hosted CI is green. The checkpoint below records the evidence
and unresolved work without weakening or skipping failing tests.

The owner also confirmed that the CPU was throttled during the slower benchmark.
Those timings are not comparable to the earlier unthrottled baseline and are not
established as a code-induced performance regression.

Integrated upstream remains `70b4ca8c181e4c1ac6d8993b86249d824487ec65`;
newer upstream work is explicitly tracked below. No finite audit establishes that
the entire fork is bug-free.

The deployed service on ports 4096/14096 and its binary were not changed. Tests
used separate worktrees, loopback servers, synthetic sessions and isolated XDG
data. Real-server smoke checks were unauthenticated; they do not establish
Basic-auth deployment parity. The replacement transport has a separate unit
test asserting Basic-auth headers with dummy credentials.

## Comparison boundary

| Ref                                  | Commit                                     |
| ------------------------------------ | ------------------------------------------ |
| Fork production baseline             | `c94eb6133eca258cb06cc30d159aae7a76519d1b` |
| Fork development baseline            | `722450048f`                               |
| Initial upstream production          | `20a7743876`                               |
| Initial upstream development         | `79903a4cf7`                               |
| Upstream integrated in both branches | `70b4ca8c181e4c1ac6d8993b86249d824487ec65` |

The initial production delta was 510 files, 38,512 additions / 7,297 deletions.
The latest upstream merge did not change app/session-ui runtime source relative
to the initial upstream production snapshot. It did bring release, provider and
console changes, so both integration branches received full unit/type validation.

Fork-heavy boundaries remain the current-session model/reducer, timeline
presentation, prompt submit path, session queue, model persistence and shared
message-part rendering. These are intentional features, not candidates for
wholesale upstream replacement. App code still composes a pinned promise client,
a separate pinned current-session client, generated legacy SDK, and compatibility
stores. Regenerating the workspace client alone does not update the pinned clients.

### Functional comparison

Pristine latest upstream passed all 10 selected Chromium tests: reasoning-selector
visibility, eight reasoning/timeline profiles, and review-state persistence.
The fork passes those corresponding contracts with its native-session fixtures,
plus its additional queue/replacement/pending/model-selection regressions.

An attempted identical-fixture comparison was invalid: fork-only payload fields
failed upstream schema validation and the upstream UI did not subscribe to the
fork's native session-event endpoint. Those failures are **not** counted as
upstream product bugs. Compare observable contracts using each protocol's valid
fixtures; do not silently rewrite either runtime to fit the other's mocks.

## Reproduced defects and fixes

### 1. Admitted steering disappeared after reload

Admission is durable but transcript promotion occurs later at a runner boundary.
The web snapshot lacked pending admissions; replay starts at the snapshot's
watermark, so already-admitted input could not be reconstructed from later events.

The message endpoint now includes an optional pending-user projection, selected
from unpromoted, undiscarded steering rows. Queue inputs remain separate. The
current-session model hydrates that projection and ignores stale pending snapshots
that would resurrect discarded input. Neither this query nor stop promotes or
resumes input. New mapping logic is isolated in `pending-inputs.ts`.

Evidence: database selection/interrupt tests, reducer stale-snapshot test, model
hydration test, cross-browser reload test, and an isolated real-server interrupt
followed by browser reload. Admitted text remained visible and Stop was absent
when execution was idle.

### 2. Rollback editing disagreed with upstream revert semantics

Upstream revert retains its boundary message. The fork web editor hides that
message and means to replace it. Pending admissions also are not projected
message boundaries. Passing an extra flag to the pinned promise client was not
sufficient: its encoder omitted the unknown field.

Inclusive replacement is now explicit and opt-in. Default upstream behavior is
unchanged. Staging captures an admission cutoff without deleting input. Commit
removes the selected original and subsequent pre-cutoff steering, preserves
explicit pending queues, and preserves the replacement admitted after staging.
The runner still commits before promoting new input. The focused persistence
logic lives in `revert-replacement.ts`; `server-revert.ts` bridges only the opt-in
request through the generated SDK. Clients were regenerated by repository scripts.

The current-session projection is also updated optimistically and refreshed after
commit. Rollback no longer continues after an interruption error; it restores the
draft and shows a request-failed notification. Both composer implementations send
the explicit replacement flag on Enter.

Evidence: 106 runner/projector/replacement tests passed, including default upstream
boundary retention. The live API check staged a pending original, admitted an
edited replacement, committed, and returned only the edited pending message.
Cross-browser tests cover Enter replacement, retained queue, and interruption
failure. Multi-client concurrent stage/resume remains a coverage gap.

### 3. Review metadata and diff routes drifted across clients

Current-session protocol detection did not imply support for `/api/vcs`. The
isolated server returned UI HTML for that unsupported path, and bootstrap skipped
legacy branch metadata on V2. The fix reuses the existing VCS compatibility adapter
and loads branch metadata from the supported endpoint. No new parallel VCS
implementation was introduced.

Evidence: transport tests assert `/vcs/diff`, working-to-git mode translation,
directory placement and returned content; bootstrap tests assert branch metadata;
review persistence passes in both browsers. Review-line fixtures were corrected
to observe the actual compatibility endpoint rather than a nonexistent V2 route.

### 4. Switching models reset timeline scroll

The recent-model resource used a suspending read. A selection changed recent
models and briefly detached the session subtree, resetting the same scroll node
to zero. Browser instrumentation confirmed removal/reinsertion under `main`,
rather than a new session or new scroll node. The resource code is shared with
upstream; this is not evidence that every upstream UI configuration exhibits it.

A one-line read of the resource's latest value prevents that suspension without
restructuring the layout. All six Chromium/Firefox model-switch scroll regressions
pass, including variant/no-variant changes and unchanged composer dimensions.

### 5. Test and CI drift obscured regressions

Mocks dropped model variants, assigned obsolete release dates, ignored configured
agents, lacked context/pending snapshots, and left rename responses non-mutating.
Several tests imported a removed pagination helper or asserted legacy part IDs
against normalized native rendering. Other fixtures hardcoded the local server
port, defeating isolated-port runs. Corrected fixtures retain semantic assertions;
no failing tests were skipped or weakened to force a green result.

Three HTTP API exerciser assertions expected raw project values while the declared
Effect API uses located envelopes. Assertions now validate location/project and
the nested data explicitly. Coverage/auth/effect runs each passed 236 scenarios,
with no missing or skipped route scenarios.

Fork CI previously selected upstream-only Blacksmith runners. It now selects
GitHub-hosted runners on the fork, checks production as well as dev, and typechecks
the addressed browser fixtures. Scheduled upstream sync now runs validation before
pushing because its GITHUB_TOKEN push does not trigger normal push workflows.
Actionlint syntax validation passed; optional shellcheck still reports existing
SC2129 style findings in the sync script, not new syntax errors.

### 6. Firefox could not open the tab context menu with Shift+F10

A focused tab received both keydown events but no native `contextmenu` event.
The Kobalte trigger handles `contextmenu` and pointer events, not these keyboard
keys. The tab now explicitly routes Shift+F10 and ContextMenu to that existing
trigger, anchored below the focused tab. The helper is isolated in the existing
fork tab-gesture module; editing/dragging guards stay at the integration point.
Preventing the default avoids duplicate native synthesis on other browsers.

Evidence: repeated Firefox failure before the fix, keyboard-event instrumentation,
three new unit cases, and all 16 rename tests passing in Chromium/Firefox. The
keyboard assertion was not replaced with a pointer click or skipped.

### 7. Context circle counted messages hidden by staged rollback

The message prop fix resolved the always-zero circle, but a second discrepancy
remained: the detail screen selects context through the staged revert boundary;
the circle used the full context snapshot. Staging does not delete that snapshot.
The circle now reuses `selectSessionContextMessages`, the same existing helper as
the detail screen. This is one import and one targeted call-site integration.

Evidence: a schema-validated browser fixture records 50,000 of 100,000 tokens before
rollback and 25,000 after rollback. The rollback circle failed at 50% before this
fix. All four Chromium/Firefox cases now assert the SVG's numeric progress,
tooltip token count, and detail-screen total/percentage against explicit values.

## Validation record

- Both latest-upstream integration branches: **30/30 typecheck tasks and 10/10
  full unit-test tasks passed**. Each core suite: 1,142 tests. Each opencode suite:
  3,650 tests. Latest app suite: 793 tests. Generated-client check passed.
- Focused fork browser run: **32/32 passed** across Chromium and Firefox; separate
  model-switch scroll run: **6/6 passed**.
- Initial full browser run: **135 passed, 96 failed, 3 pre-existing skips**.
  Latest full rerun: **178 passed, 55 failed, 3 pre-existing skips** (236 cases,
  6.3 minutes). This rerun includes keyboard/remote-fixture fixes and precedes the
  final context-selection fix; the latter separately passed all four new cases.
  Neither run is an all-green result.
- Rename tests: **16/16 passed** across browsers after correcting native rename
  fixtures and keyboard menu activation. Remote settings/auto-accept tests:
  **4/4 passed**, including unfocused parent/child sessions on a different server.
  The actual current request query is `location[directory]`, not `directory`;
  current replies are session-addressed and use `{ reply: "once" }`.
- CI is not green. Windows development jobs failed before tests during Bun 1.3.14
  patch installation (`ENOTEMPTY` for patched `@ai-sdk/openai-compatible`), even
  with no restored cache. Linux development unit CI hit subprocess timeouts in
  `run-process.test.ts`; local full runs passed. Production typechecking was
  cancelled, not a demonstrated compiler error. These require investigation and
  successful reruns; no timeouts or assertions have been weakened.
- Manual browser against isolated source backend: edited pending message visible,
  original absent, no Stop while idle; Muse Spark 1.3 Free offered Default,
  Minimal, Low, Medium, High and Xhigh reasoning choices. No paid inference used.
- Production tab-switch benchmark: both before/after runs passed. V2 median stable
  times, milliseconds:

  | Scenario            | Before | After |
  | ------------------- | -----: | ----: |
  | Review closed, cold |  136.2 | 142.8 |
  | Review closed, hot  |  103.7 | 115.1 |
  | Review open, cold   |  120.6 | 120.4 |
  | Review open, hot    |  112.6 | 113.4 |

  Five local samples per scenario, not a statistical performance guarantee. The
  final after run includes latest integrated upstream, the recent-model fix, and
  the context-selection fix. These samples include concurrent local browser work;
  the increases are not established as code-induced regressions or dismissed as
  harmless. Repeat isolated performance measurements before release.
  No wrong-destination or review-host replacement samples were observed.

## Historical full-suite failure inventory (before checkpoint)

These are failing test cases, not 55 confirmed product bugs. Several fixtures still
send mutation arrays as one SSE event or assert obsolete part IDs. Repair invalid
fixtures without weakening observable behavior assertions; investigate failures
that remain against valid data.

| Area                               | Cases |
| ---------------------------------- | ----: |
| Native timeline transport          |    14 |
| Timeline projection                |     6 |
| Smoke pagination/timeline          |     6 |
| Collapse state                     |     4 |
| History-root transitions           |     4 |
| Subagent navigation                |     4 |
| Context resize                     |     3 |
| Lifecycle/retry                    |     3 |
| Request docks                      |     2 |
| Reducer projection                 |     2 |
| Shell outline                      |     2 |
| Todo navigation                    |     2 |
| New-project model-selection story  |     2 |
| Review/terminal stacking (Firefox) |     1 |

## Historical work plan (superseded by checkpoint backlog)

1. [x] Correct remote settings fixtures and verify cross-server auto-accept,
       including unfocused parent/child sessions. This was fixture protocol drift,
       not evidence of a runtime permissions defect.
2. [x] Resolve Firefox keyboard context-menu opening while retaining the keyboard
       assertion. Rename, tab close and focus restoration pass on both browsers.
3. Migrate remaining timeline transport fixtures to individual native events and
   native normalized part identities. Audit actual render behavior for collapse,
   retry, context resize, history root, comments, attachments and subagent cards.
4. Finish request-dock, todo, smoke pagination and new-project/model user-story
   validation. All configured test ports must be honored. Extend e2e typechecking
   to the remaining regression files; current coverage is intentionally enumerated,
   not a claim that every e2e file typechecks.
5. Audit keyboard undo/redo interruption-error handling and compatibility-store
   reads. Main rollback is fixed; other entrypoints must receive equivalent tests.
   Add multi-client replacement/cutoff tests. Basic and staged-rollback context
   usage browser parity is now covered; live usage updates remain to be audited.
6. Run the complete browser suite and final benchmark on both integration heads;
   inspect Linux and Windows CI. Update the PR validation record with final results.
7. Re-fetch upstream, validate any additional commits, then merge both PRs and
   verify upstream ancestry on dev and production.
   Do not deploy or reinstall the user's running service as an incidental step.

## Mergeability rule

Keep fork behavior behind focused modules and optional protocol fields. Prefer
small call-site adapters over editing vendored client archives or broadly rewriting
upstream UI. Preserve upstream defaults. Every future sync must validate these
boundaries, not merely resolve textual merge conflicts.

## Saved-work checkpoint — 2026-09-05

This is a reviewed **checkpoint with known unresolved issues**. The owner has
authorized merging it and deferring the remaining work to follow-up PRs. No runtime features were removed to make the upstream diff smaller.
The changes use existing adapters and optional call-site callbacks; they do not
replace the session architecture. The user's live service and installed binary
remain untouched.

### Additional underlying fixes saved

- **Stop before a provider turn:** interruption could succeed before any assistant
  step existed, leaving no step-ended event to clear the composer's busy state.
  After a successful interrupt, both composers now refresh the current session.
  Queue draining is paused first. Admitted steering is neither deleted nor
  resubmitted. The new browser case failed before this change and passes after it,
  including reload. The submit test asserts pause → interrupt → refresh ordering.
- **Native user projection:** compatibility conversion now preserves native file
  URIs, agent mentions and original typed payload parts, including synthetic
  comment context. Native rich prompts no longer depend on lossy legacy fields.
- **Child-task navigation:** native task metadata uses `sessionID`, while legacy
  cards read `sessionId`. The adapter supplies the alias without replacing an
  existing legacy value, and reads native structured metadata. Child headings
  resolve descriptions from the parent's cached parts, not the child-only current
  message accessor.
- **Retry display:** the current-to-compatibility status bridge now includes retry
  metadata and updates attempts even when the status tag has not changed. Native
  retry → recovery → idle browser coverage asserts both attempts.
- **Supported shared endpoints:** V2 session detection no longer forces empty
  todos or path metadata. The existing todo endpoint remains authoritative for
  persisted tasks; live updates and forced refresh retain their existing behavior.
  Path lookup retains an empty fallback only when unavailable on a V2 server.
- **Keyboard rollback integration:** Undo/Redo now receive current user messages,
  including pending steering, and delegate to the same rollback/restore mutations
  as the timeline. Completion is guarded against session navigation. Undo reaches
  the correct pending draft in the new regression; the full Redo interaction is
  still blocked by the failure below and is not claimed fixed end-to-end.
- **Provider discovery:** onboarding choices come from the integration catalogue,
  separately from the connected-model catalogue. Missing/offline responses are
  tolerated; models and connected/default selections are not invented. This fixes
  the discovery boundary but exposes a remaining connection-dialog hydration
  defect; the whole onboarding flow is still incomplete.
- **Replacement consistency:** two independent current-session clients converge
  after a committed replacement. Persistence tests cover a steer exactly at the
  admission cutoff, a later replacement, explicit queues, and an unrelated session.

### Test-fixture and CI improvements saved

Native timeline fixtures now send individual events with the correct aggregate
ID, durable sequence, normalized text/reasoning IDs and current endpoint envelopes.
Reconnect tests assert the durable `after` cursor. Pagination distinguishes the
current 100-message page from compatibility hydration. Browser assertions still
check behavior, ordering, geometry, caret restoration and error absence; failing
cases were not skipped or given relaxed assertions. Expanded e2e typechecking is
explicitly enumerated, not comprehensive coverage of every Playwright file.

The shared Bun setup action now honors its caller's Node version, so the existing
Playwright Node 24.15 pin is no longer silently overwritten. Fork CI uses lower
concurrency; upstream workflow concurrency is retained. CLI tests cap concurrent
subprocess tests at two without increasing their timeouts. Windows fixtures use
portable paths and shell syntax, ripgrep is preinstalled, and Turbo forwards the
existing isolated-home/file-watcher environment into core tests.

The earlier GitHub failures were **not established as quota exhaustion**:

- Typecheck jobs exited 137 or were cancelled without TypeScript diagnostics.
  Resource pressure is plausible, but OOM was not proven.
- Linux subprocess timeout failures reproduced locally with cold concurrent
  compilation. Pinned Bun 1.3.14 with concurrency two passed all 14 CLI cases with
  the same deadlines (49 assertions).
- Windows showed real portability/download issues as well as a distinct patched
  Bun dependency installation `ENOTEMPTY` failure. The portability changes are
  tested on Linux; a clean Windows pass is still required. A stock Windows smoke
  VM was used for investigation, but its attempted install is not a passing result.

### Checkpoint verification

Commands below run from the named package directory, never root `bun test`.

| Validation                                                                                        | Observed result                                                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| App `bun run test`                                                                                | 800 unit + 51 browser-environment unit tests passed; zero failures                             |
| App `bun typecheck` and `bun run typecheck:e2e`                                                   | Both passed                                                                                    |
| Core `bun test test/command.test.ts test/session-prompt.test.ts test/session-replacement.test.ts` | 38 passed, 100 assertions                                                                      |
| Timeline fixture unit test                                                                        | 4 passed, 8 assertions                                                                         |
| Workflow `actionlint` (test and typecheck)                                                        | Passed                                                                                         |
| Full pinned-Bun Linux Turbo unit run before the final focused additions                           | 10/10 tasks passed, uncached, 14m43s; core 1,142 tests; opencode 3,627 pass / 22 skip / 1 todo |
| Seven timeline projection/lifecycle/geometry specs, Chromium + Firefox                            | 43 passed; 3 existing Firefox CDP skips                                                        |
| Stop, pending reload, rollback and native transport focused run                                   | 24 passed, 2 failed; only command Undo/Redo failed                                             |
| Recorded, rolled-back and live context usage                                                      | 6 passed across Chromium + Firefox                                                             |
| Fresh request/todo/child/review/onboarding/smoke run                                              | 18 passed, 8 failed across Chromium + Firefox                                                  |

These are separate runs with some overlapping cases, not an aggregate full-suite
pass. The fresh 26-case run confirms request-dock caret, todo lifecycle, child
navigation, prepend anchoring and cold-tab paint behavior. Its eight failures are
listed below. A final full browser run on both exact branch heads remains follow-up work.

### Actionable backlog for follow-up PRs

| ID / priority   | Evidence and likely boundary                                                                                                                                                                                                                                                                                                            | Required next step / exit criterion                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WEB-01 / P1     | New-project OpenCode Go discovery succeeds, but selecting it throws `Cannot read properties of undefined (reading 'name')` in `ProviderConnection` / `MethodSelection`, before the API-key field appears (both browsers). `provider()` assumes that a new hook instance already has either integration choices or a connected provider. | Make connection rendering safe during catalogue hydration without inventing connected models. Add a delayed-catalogue regression and complete key submission, refresh and model selection in both browsers.                                            |
| WEB-02 / P1     | Command Undo selects/stages the pending message correctly; the subsequent Ctrl+P for Redo never produces a dialog textbox in either browser. No error page in the clean repro.                                                                                                                                                          | Separate command-dialog/focus teardown from a runtime hotkey defect; retain real keyboard activation. Require stage, clear, empty draft and restored single message assertions to pass.                                                                |
| WEB-03 / P2     | Review/terminal stacking times out waiting for a tree to have positive height in both browsers in the fresh run. Native lifecycle events are now used.                                                                                                                                                                                  | Inspect layout readiness and fixture review mode before changing runtime. Verify tree/terminal geometry, scrolling, detail refresh and remount invariants, without fixed sleep inflation.                                                              |
| WEB-04 / P2     | Cached-tab smoke reports one removed first-paint plain text `<span>` in both browsers; latest-message and bottom placement assertions already pass. Probe currently tracks every descendant, including `HighlightedText` leaves rebuilt during hydration.                                                                               | Establish whether a user-visible row/part remount occurs. Preserve semantic row identity and first-frame assertions; distinguish incidental leaf updates from structural replacement with a dedicated repro rather than blindly relaxing zero-removal. |
| WEB-05 / P2     | Full-history smoke reaches its final error audit, then fails: Chromium logs a current-context transport error; Firefox logs a global event-stream failure. No forbidden text or error toast was observed.                                                                                                                               | Determine mock coverage/reconnect or cancellation logging versus a real transport failure; preserve the no-console-errors contract and full ordering checks.                                                                                           |
| CI-01 / P1      | Windows patched dependency install failed with `ENOTEMPTY`; clean Windows validation is not established.                                                                                                                                                                                                                                | Reproduce using pinned Bun in the stock smoke VM or hosted runner, resolve install failures, then run affected core/MCP/ripgrep/LSP/CLI suites and Windows browser gates. Do not call this quota without evidence.                                     |
| CI-02 / P1      | Both old PR heads have red GitHub checks. Local Linux full tests pass, but that does not establish hosted or Windows parity.                                                                                                                                                                                                            | Inspect new-head jobs and logs. Require compiler, unit and browser failures to be fixed; document decent local equivalents only for demonstrated infrastructure/config/quota problems.                                                                 |
| SYNC-01 / P1    | Latest fetched upstream dev and production are `e2894562f8ba943d72172d10b727c24d5f650c16`; integration branches contain `70b4ca8c181e4c1ac6d8993b86249d824487ec65`. The extra commit changes console usage normalization/tier configuration, not the web session fixes.                                                                 | Merge this and any later upstream changes into both integration branches with affected console validation; recheck ancestry before merge. This checkpoint does not claim latest-upstream completion.                                                   |
| RELEASE-01 / P1 | Owner-authorized merge accepts the documented failures; Basic-auth deployed-browser parity and final exact-head full browser validation remain outstanding.                                                                                                                                                                             | Complete the backlog in follow-up PRs and rerun both branches. Reinstall/deploy separately when explicitly requested.                                                                                                                                  |

### Reproduction commands

From `packages/app`, against the task-owned mock-test Vite server (currently
14449, backend request origin 14999):

```sh
PLAYWRIGHT_BASE_URL=http://127.0.0.1:14449 PLAYWRIGHT_PORT=14449 \
PLAYWRIGHT_SERVER_PORT=14999 PLAYWRIGHT_WORKERS=2 bun run test:e2e \
  e2e/regression/session-rollback-queue.spec.ts \
  e2e/regression/review-terminal-stacked.spec.ts \
  e2e/user-story/model-selection-flow.spec.ts \
  e2e/smoke/session-timeline.spec.ts
```

The tests install synthetic API routes; these ports are not the deployed service.
If no task server is listening, use the repository Playwright configuration's own
server lifecycle on an unused port. Never restart the user's service for this.

Production benchmark (builds its own temporary preview; run without other test
workloads):

```sh
PLAYWRIGHT_PORT=14448 PLAYWRIGHT_WORKERS=1 bun run test:e2e \
  --config e2e/performance/playwright.config.ts --project=chromium \
  e2e/performance/timeline/session-tab-switch-benchmark.spec.ts
```

### Checkpoint performance result — CPU-throttled comparison

The final production-build benchmark passed its two structural test cases, but
**did not establish performance parity**. V2 median stable times (five samples per
scenario) increased relative to the earlier baseline:

| Scenario            | Earlier baseline (ms) | Checkpoint (ms) |
| ------------------- | --------------------: | --------------: |
| Review closed, cold |                 136.2 |           406.0 |
| Review closed, hot  |                 103.7 |           314.0 |
| Review open, cold   |                 120.6 |           354.2 |
| Review open, hot    |                 112.6 |           324.0 |

No wrong-destination or review-file-host replacement samples were observed. The
owner subsequently confirmed that CPU throttling caused the slower timings.
The focused browser run finished before benchmark sampling; its tail overlapped
the benchmark build startup. Because CPU conditions differed, these measurements
cannot establish either performance parity or a code-induced regression.

**PERF-01 / P2 (follow-up):** rerun baseline and checkpoint alternately with matching
CPU throttling and machine load. Retain first-frame/latest-message and review-host
identity checks. Investigate code only if a slowdown reproduces under comparable
conditions; the throttled comparison is not a merge blocker.
