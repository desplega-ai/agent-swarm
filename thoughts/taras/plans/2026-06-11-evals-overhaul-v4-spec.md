---
date: 2026-06-11T23:45:00Z
topic: "Evals overhaul round 4 — cancel fix, live attempt progress, ConfigChip/ConfirmDialog, UI polish"
status: ready
branch: feat/evals-subproject
supersedes-sections-of: thoughts/taras/plans/2026-06-11-evals-overhaul-v3-spec.md
tags: [evals, cancel, live-progress, config-chip, confirm-dialog, ui, round-4]
---

# Evals round 4 — QA-feedback spec

Taras's round-4 QA items (every numbered clause is LAW):

1. Judge-model select dropdown overflows and makes the new-run modal scrollable — fix for good.
2. "i" InfoTip with a helpful tooltip on EVERY field in the new-run dialog.
3. Runs table, Scenarios cell: hover shows a per-scenario × config matrix breakdown (glyphs).
4. Truncated run names: hover reveals the WHOLE name via a rich Tooltip (not a flaky title attr).
5. Run details: tabs pin to the very top of the content area; only tab CONTENT scrolls.
6. Phase timings visible WHILE the attempt runs (live waterfall growing as phases complete).
7. Double animation on running runs — exactly ONE animated indicator per context.
8. Transcript genuinely nice: markdown for assistant text, distinct blocks per event type.
9. Checks/judgments as a TABLE with row expansion.
10. New "Logs" tab in run details: pretty worker/api logs (and the new runner log).
11. Checks tab label must scale to several judges without clutter.
12. Cancel DOES NOT WORK (root cause + fix), and confirmation must be an in-app modal.
13. `ConfigChip` — `<HarnessIcon> <pretty model name>` + hover popover; used everywhere.
14. Per-attempt debug log of what the runner actually does — captured, persisted, streamed live.

Wave 0 (W40, this spec's author) has ALREADY LANDED everything marked IMPLEMENTED below:
the live attempt-progress module, shared types (backend + UI mirrors + API client), the
`ConfigChip` / `ConfirmDialog` / `Markdown` components, the `useConfigs()` hook, the
`StatusBadge.activeLabel` single-animation API, `Tooltip.block`, `DataTable` cell-tooltips +
row expansion, the `Matrix` mini variant, and all shared CSS. Wave-1 packages implement
against the ACTUAL CODE in those files and MUST NOT edit them.

Global invariants carry over from rounds 1–3: old DB rows keep rendering (all new fields
nullable, "Not captured (older run)" fallbacks, nothing 500s), capitalized UI copy, unicode
glyphs over chips, single-line ellipsis cells, portal tooltips, plain CSS, no new deps,
biome-clean (double quotes, 100-char lines, no `any`), Bun APIs server-side.

---

## 1. Cancel bug — ROOT CAUSE (item 12, investigated end to end)

The endpoint and the UI wiring are fine (`POST /api/runs/:id/cancel` → `controller.abort()`
+ `killRunStacks(runId)`; vite proxies `/api` in dev). The run nevertheless keeps
"executing" for 10–15 more minutes because **nothing inside a running attempt ever observes
the abort signal, and the swarm-client polling loops swallow the errors that the sandbox
kill produces**. Four concrete defects, in causal order:

**RC-1 — in-flight attempts ignore the signal.** `executeRun` (evals/src/runner/index.ts)
uses the signal in exactly two places: `pool`'s `shouldStop` (checked only BETWEEN
attempts, line ~767) and `runAttemptWithRetry`'s `catch` (line ~683). `runAttemptOnce`
never receives the signal; no phase boundary checks it. Cancel therefore only prevents NEW
attempts from starting.

**RC-2 — `SwarmClient.waitForTask` swallows the kill.** After `killRunStacks` destroys the
sandboxes, every poll against the dead `apiUrl` throws — and `waitForTask`
(evals/src/swarm/client.ts, line ~95) catches it as `// transient API blip — keep polling
until the deadline`. The attempt sits in this loop for the FULL task budget (default
10 min per task), then proceeds with `timedOut: true` through `getStableSessionLogs`
(30 s, errors → `[]`), `waitForSessionCostRows` (60 s, errors → `null`), and the judges —
real LLM spend on a cancelled run — before persisting a bogus failed result. This is the
observed "cancel does nothing".

**RC-3 — boot-phase race: stacks are registered for kill only AFTER boot completes.**
`trackStack(attempt.runId, stack)` runs after `bootStack` returns (runner/index.ts ~219).
Boot takes minutes (two sandbox creations + readiness waits). Cancel during boot →
`killRunStacks` finds an empty set, kills nothing, and the freshly booted stack then runs
the whole attempt (and burns E2B money) with zero kill on record.

**RC-4 — the "leave it pending" path needs a throw to trigger.** `runAttemptWithRetry`
marks an attempt `pending` on abort only inside its `catch`. Because of RC-2 the post-kill
attempt often does NOT throw — so the cancelled attempt persists as `failed` with garbage
judgments instead of staying pending for resume.

### 1.1 Fix — WP-RUNNER4 (owns `runner/index.ts`, `swarm/client.ts`, `swarm/sandbox.ts`)

Frozen contracts (additive, all optional params — existing tests/CLI keep working):

```ts
// swarm/client.ts — every polling helper gains an optional signal and FAILS FAST on abort:
waitForTask(id, { timeoutMs, intervalMs?, onStatus?, signal? })   // each iteration:
getStableSessionLogs(taskId, timeoutMs?, signal?)                 //   if (signal?.aborted)
waitForSessionCostRows(taskId, timeoutMs?, signal?)               //     throw new Error("aborted")

// swarm/sandbox.ts — bootStack gains `signal?: AbortSignal`; call signal.throwIfAborted()
// before/after each createSandbox / waitForHttpOk / waitForAgentRegistration /
// waitForAgentReady step INSIDE the try (the existing catch already runs `kill()` —
// this closes RC-3 with zero new teardown code).

// runner/index.ts — runAttemptOnce gains `signal?: AbortSignal`:
//   - pass it to bootStack and to every SwarmClient polling call;
//   - `signal?.throwIfAborted()` at each phase boundary (before seed, before each task,
//     before log capture, before cost wait, before judging, before artifacts);
//   - runAttemptWithRetry passes opts.signal through (its existing aborted→pending catch
//     then actually fires — closes RC-4; RC-1 closes by construction).
```

After this, the observable cancel behavior (frozen): POST /cancel returns 202; in-flight
attempts fail their current await within seconds; aborted attempts go back to `pending`
(resumable); `executeRun` exits its pool, sets the run `cancelled`; `/api/runs/:id` shows
`active: false`. No judge calls run after the abort.

### 1.2 Fix — WP-API4 (owns `api/server.ts`)

The cancel handler itself is correct — keep `controller.abort()` + `await killRunStacks()`
→ 202 / 409 / 404 exactly as today. WP-API4's round-4 work is §3 (progress endpoint).

### 1.3 Fix — UI wiring (WP-RUNS4 + WP-RUNDETAIL4)

- Replace BOTH `window.confirm("Cancel this run?")` call sites (RunsPage `RunDetailPane.act`,
  RunDetailsPage title row) with the shared `useConfirm()` modal (§5):
  `confirm({ title: "Cancel This Run?", message: "In-flight attempts are torn down and go
  back to Pending — Resume continues them later.", confirmLabel: "Cancel Run",
  cancelLabel: "Keep Running", danger: true })`.
- Cancelling state: after the POST resolves keep the button disabled with label
  "Cancelling…" until the polled `active` flips false (local `cancelRequested` state,
  reset when `active === false`). Surface action errors as today.

---

## 2. Live attempt progress (items 6 + 14) — `evals/src/live/attempt-progress.ts` (IMPLEMENTED)

In-memory registry, same philosophy as the judge live-registry. Backend types live in
`evals/src/types.ts` (IMPLEMENTED — read-only for wave 1):

```ts
export type AttemptPhase =
  | "boot" | "seed" | "tasks" | "log-capture" | "cost"
  | "checks" | "llm-judge" | "agentic-judge" | "artifacts";

export type ProgressLogLevel = "info" | "warn" | "error";
export interface ProgressLogLine { ts: string; level: ProgressLogLevel; line: string }

export interface AttemptProgressSnapshot {
  active: boolean;                      // executing in THIS server process
  startedAt: string | null;
  currentPhase: AttemptPhase | null;
  currentPhaseStartedAt: string | null; // drives the live waterfall's growing bar
  phases: Partial<PhaseTimings>;        // filled as phases complete
  log: ProgressLogLine[];               // ring buffer, cap 2000 (PROGRESS_LOG_CAP)
}
```

Module API (IMPLEMENTED — `evals/src/live/attempt-progress.ts`, unit-tested):

```ts
beginAttemptProgress(attemptId)                    // top of runAttemptOnce; resets on retry
setAttemptPhase(attemptId, phase | null)           // at each phase start
recordAttemptTimings(attemptId, partialTimings)    // after each phase completes (merge;
                                                   //   null fields never clobber numbers —
                                                   //   passing the runner's whole `timings`
                                                   //   object after each phase is the
                                                   //   intended usage)
pushAttemptLog(attemptId, level, line)             // live ring buffer + full capture
logLevelFor(line): ProgressLogLevel                // "[error]…"→error, "[retry]"/warn→warn
getAttemptProgress(attemptId): AttemptProgressSnapshot  // unknown → { active:false, …empty }
finishAttemptProgress(attemptId): ProgressLogLine[]     // FULL capture + deletes the entry
formatRunnerLog(lines): string                          // "ISO [level] line" per row
```

### 2.1 Runner wiring — WP-RUNNER4 (normative)

Inside `runAttemptOnce`:

1. Top of the function: `beginAttemptProgress(attempt.id)`. Wrap the log fn ONCE:
   `const log = (msg: string) => { opts.log(msg); pushAttemptLog(attempt.id, logLevelFor(msg), msg); };`
   and use it everywhere `opts.log`/the local `log` is used today — EVERY runner line for
   the attempt flows into the registry (boot, seed cmds, task creation/status, log capture,
   cost, checks, judges, artifacts, sweep messages from `runAttemptWithRetry` may stay out).
2. Around each phase: `setAttemptPhase(attempt.id, "boot")` before `bootStack`, then after
   the phase completes `recordAttemptTimings(attempt.id, timings)` (the whole object) — and
   the next `setAttemptPhase(…)`. Phase keys ↔ PhaseTimings fields:
   boot→bootMs, seed→seedMs, tasks→tasksMs/perTask, log-capture→logCaptureMs, cost→costMs,
   checks→checksMs, llm-judge→llmJudgeMs, agentic-judge→agenticJudgeMs, artifacts→artifactsMs.
3. In `runAttemptOnce`'s `finally` (after `clearJudging`, best-effort try/catch):
   ```ts
   const progressLog = finishAttemptProgress(attempt.id);
   if (progressLog.length > 0) {
     await insertArtifact(db, {
       id: crypto.randomUUID(), attemptId: attempt.id,
       kind: "log", name: "runner.log",            // kind "log" — DECIDED (new ArtifactRow kind,
       content: stack.redact(formatRunnerLog(progressLog)),  // already in types.ts)
     });
   }
   ```
   `stack` exists in the finally (boot failures throw before the try). For terminal errors
   persisted by `runAttemptWithRetry` the artifact has already been written by this finally.
   `clearAttemptResults` wipes it on retry — each try gets a fresh runner.log.
4. **Leak guard (boot failures)**: when `bootStack` throws, the inner try/finally never
   runs — so `runAttemptWithRetry`'s `catch` MUST also call
   `finishAttemptProgress(attempt.id)` (idempotent: returns `[]` once cleared) and, on the
   TERMINAL error path only, best-effort persist those lines as the runner.log artifact
   (no `stack.redact` available — the boot log carries no secrets beyond the throwaway
   sandbox ids). The registry must never outlive the attempt.

### 2.2 The runner.log artifact (FROZEN)

- `kind: "log"`, `name: "runner.log"`, content = `formatRunnerLog(fullCapture)` (redacted).
- Old attempts simply lack it → Logs tab renders "Runner log not captured (older run)".

## 3. Progress endpoint (FROZEN — implemented by WP-API4 in `api/server.ts`)

```
GET /api/attempts/:id/progress
→ 200 AttemptProgressSnapshot (JSON)
```

- ALWAYS 200, registry-only, no DB lookup — same philosophy as judge-live. Unknown id,
  finished attempt, restarted server → `{ "active": false, "startedAt": null,
  "currentPhase": null, "currentPhaseStartedAt": null, "phases": {}, "log": [] }`.
- Handler body is exactly `json(getAttemptProgress(req.params.id))` with
  `import { getAttemptProgress } from "../live/attempt-progress.ts"`.
- UI mirrors + client (IMPLEMENTED): `AttemptProgressResponse` in `evals/ui/src/types.ts`,
  `getAttemptProgress(attemptId)` in `evals/ui/src/api.ts`.

---

## 4. ConfigChip (item 13 — IMPLEMENTED, `evals/ui/src/components/ConfigChip.tsx`)

```tsx
export function ConfigChip(props: {
  configId: string;
  link?: boolean;   // wrap the name in a link to #/configs/:id
  dim?: boolean;
}): ReactNode;
```

- Data source: `useConfigs()` (IMPLEMENTED in `evals/ui/src/hooks.ts`) — one
  `/api/configs` fetch per session, `{ configs, byId(id), loaded }`; plus `useModels()` for
  the pretty model name.
- Renders `<HarnessIcon plain> <name>` where name = models.dev display name of
  `config.model`, falling back to the raw model id, falling back (model-less configs) to
  `label ?? "Default Model"`. Hover = wide portal card: Id, Label, Provider (icon+label),
  Model (code / "Harness default"), Tier, Env Keys (names only), Default ✓/—.
- Unknown config id (removed / older run): raw `<code>` id + tooltip "Not in the current
  config registry (removed, or an older run)". Never throws, never 500s.
- `HarnessIcon` gained a `plain` prop (no own Tooltip) for nesting inside chip tooltips —
  use it whenever an icon sits inside another tooltip trigger.

**Adoption map (wave 1):** RunsPage By-Config breakdown rows + Configs filter options
(WP-RUNS4); ScenariosPage attempts-table Config column + its filter options (WP-RUNS4,
secondary ownership); NewRunDialog config check-list labels (WP-RUNS4 — keep the checkbox,
label content becomes `<ConfigChip configId={c.id} />`); RunDetailsPage AttemptSummary
Config row (WP-RUNDETAIL4, with `link`). ConfigsPage's own table/detail stays as-is (it IS
the popover's long form). Matrix axis headers stay short config-id links (space).

## 5. ConfirmDialog (item 12 — IMPLEMENTED, `evals/ui/src/components/ConfirmDialog.tsx`)

```tsx
const { confirm, confirmDialog } = useConfirm();
// render {confirmDialog} once in the component; then:
if (await confirm({ title, message?, confirmLabel?, cancelLabel?, danger? })) { … }
```

Promise-based `<dialog>` modal in the app style (`.confirm-dialog`, `dialog-actions`
buttons). Esc, backdrop click, and the dismiss button resolve `false`; a second `confirm()`
while one is pending resolves the previous `false`. Confirm button autofocuses; `danger`
renders it `btn-danger`. Exact copy for run cancellation is frozen in §1.3.

## 6. Single-animation rule (item 7 — screenshot: run name + TWO braille spinners + "Live")

The double animation = `<StatusBadge status="running" />` (which already renders a spinner
for live statuses) PLUS a separate `<Spinner label="Live" />` right next to it.

**Rule (frozen): a status indicator and a "live/executing" affordance MUST be the same
element.** `StatusBadge` (IMPLEMENTED) now takes `activeLabel?: string` and renders exactly
ONE spinner + static dim text. Pages MUST NEVER render a standalone `<Spinner>` adjacent to
a StatusBadge/StatusScore.

Per-context decisions:

| Context | Renders | Owner |
|---|---|---|
| RunDetailsPage title row | `<StatusBadge status={r.status} activeLabel={run.active ? "Live" : undefined} />`; DELETE the separate `<Spinner label="Live" />` | WP-RUNDETAIL4 |
| RunsPage detail-pane head | `<StatusBadge status={run.status} activeLabel={active ? "Executing" : undefined} />`; DELETE the separate `<Spinner label="Executing" />` | WP-RUNS4 |
| Runs table Status cell | `StatusScore` spinner only (already single) — unchanged | — |
| Matrix running cell | one `Spinner` + `Elapsed` (Elapsed is ticking text, not an animation) — unchanged | — |
| Checks tab label while judging | the tab-label spinner is the ONLY animated element in the tab bar (§7) | WP-RUNDETAIL4 |

`Elapsed` tickers and CSS `pulse` on a SINGLE element are fine; two animated elements in
the same flex row / cell / label are never fine.

## 7. Checks-tab label rule (item 11 — FROZEN format)

`checksTabInfo` produces, scaling to any number of judges:

```
Checks {passed}/{total}            ← deterministic count; omit "{passed}/{total}" when 0 checks
 + one ✶ per judge judgment        ← colored tone-green/tone-red by that judgment's pass
 + ONE spinner instead of the ✶s   ← while judging (single animated element)
```

Examples: `Checks 2/2 ✶` (one judge, green), `Checks 2/2 ✶✶` (two judges, each its own
verdict color), `Checks ⠙` (judging), `Checks` (nothing yet). NO "· Judge ✓" text. The
button's `title`/tooltip carries the legend: one line per judge — `"{name} — Passed/Failed
(score)"` — plus the checks summary line. Judge glyph stays ✶ (matches ScenariosPage).

## 8. Tab-bar layout rule (item 5 — screenshot: judge-trace header bleeding ABOVE the tabs)

Root cause: `.rd-right` is itself the scroll container (`panel scroll-col`) and the tab bar
is `position: sticky` INSIDE it; the panel's 12px top padding is a see-through strip above
the sticky bar where scrolled content shows.

**Rule (frozen, WP-RUNDETAIL4):** the tab bar lives OUTSIDE/at the top of the scroll
container; only tab CONTENT scrolls.

```
.rd-right            → flex column, overflow hidden, max-height: var(--scroll-col-max);
                       NOT a scroll container; keeps panel chrome + opaque background
  .tabs.rd-tabs      → static first child (no sticky needed), opaque var(--panel) background
  .rd-tab-content    → NEW wrapper around the tab body: flex: 1; min-height: 0;
                       overflow-y: auto
```

Remove `.rd-right > .tabs { position: sticky; … }`. Apply the same change in JSX
(`RunDetailsPage.tsx`: wrap the tab-content branch in `<div className="rd-tab-content">`)
and CSS (`run-details.css`). The `scroll-col` class moves off `.rd-right` onto
`.rd-tab-content` (or replicate its styles). Mobile breakpoint keeps `max-height: none`.

---

## 9. WP-RUNS4 — runs page + new-run dialog (wave 1)

Owns: `evals/ui/src/pages/RunsPage.tsx`, `NewRunDialog.tsx`, `runs.css`; secondary:
`ScenariosPage.tsx`, `scenarios.css`, `ConfigsPage.tsx`, `configs.css` (ConfigChip adoption
only). Implements items 1, 2, 3, 4, 7 (its contexts), 12 (its confirm), 13 (adoption).

### 9.1 Item 1 — judge-model menu must never scroll the modal

Render the `.model-menu` as a `position: fixed` element INSIDE the dialog subtree (NOT
portaled to `document.body` — see warning below), copying the EXACT MultiSelect positioning
mechanics already in `DataTable.tsx` (anchor rect from the input, viewport-aware: flip
above when no room below, clamp x, `max-height: 280px`, reposition via `useLayoutEffect`
on `[menuOpen, matches.length]`, close on Escape/outside-mousedown — keep the existing
`onBlur`/`onMouseDown` preventDefault dance for option clicks). CSS: keep `.model-menu`
visuals, change `position: absolute → fixed`, drop `top/left/right` (inline style supplies
them) — in `runs.css`. The dialog itself must keep ZERO scrollbars at any viewport
≥ 600px tall; with the menu out of the dialog's flow this is structural, not incidental.

**WARNING — never portal to `document.body` from inside a `showModal()` dialog.** The open
modal sits in the browser top layer: body-level content is painted BENEATH it (invisible
wherever it overlaps the dialog) and is inert (unclickable; `elementFromPoint` returns the
dialog). Verified via screenshots + `elementFromPoint` probes. `position: fixed` inside the
dialog subtree gives identical viewport-anchored coordinates (the dialog has no transform)
without leaving the top layer. The shared `Tooltip` handles this generically by portaling
to `triggerRef.current?.closest("dialog:modal") ?? document.body`.

### 9.2 Item 2 — InfoTip on every new-run field (exact copy, frozen)

- Name: `"Optional display name for the runs list — a run id is generated either way"`
- Scenarios: `"What gets evaluated — every selected scenario becomes a matrix row"`
- Configs: `"Harness × model under test — every selected config becomes a matrix column"`
- Attempts Per Cell: `"Independent attempts per scenario × config cell — pass@n/best@n scoring"`
- Concurrency: `"Attempts executed in parallel — each boots its own E2B sandbox stack"`
- Judge Model: keep today's `"Bare OpenRouter id; scenario-level judge models still win"`

Pattern: `<span className="form-label">Label <InfoTip text="…" /></span>` (Judge Model
already does this).

### 9.3 Items 3 + 4 — runs-table hovers (use the new `Column.tooltip`)

- Run column: `tooltip: (r) => (r.run.name !== null ? `${r.run.name}\n${r.run.id}` : r.run.id)`;
  DELETE its `titleText` (the rich tooltip replaces it).
- Scenarios column: `tooltip: (r) => <Matrix variant="mini" scenarioIds={r.run.scenarioIds}
  configIds={r.run.configIds} cells={r.cells} />`; keep count render; DELETE `titleText`.
- `DataTable` wraps tooltip-cells in `<Tooltip block wide>` automatically (IMPLEMENTED) —
  no page-side wrapper needed.

### 9.4 Items 7 + 12 + 13 — see §1.3, §4, §6 for its contexts.

## 10. WP-RUNDETAIL4 — run details (wave 1)

Owns: `evals/ui/src/pages/RunDetailsPage.tsx`, `Waterfall.tsx`, `JudgeTrace.tsx`,
`run-details.css`. Implements items 5, 6, 7 (its context), 9, 10, 11, 12 (its confirm),
13 (AttemptSummary), 14 (Logs tab display).

### 10.1 Item 6 — live waterfall

- `TimingsTab` polls `getAttemptProgress(selId)` every 2 s while
  `isUnfinished(attempt.status)` (null interval otherwise — same `usePoll` pattern as
  judge-live).
- When `progress.active`: render the waterfall from `progress.phases` with the CURRENT
  phase as a growing bar. Frozen `Waterfall` contract change (additive):

```tsx
export default function Waterfall(props: {
  timings: PhaseTimingsJson;
  totalMs: number | null;
  /** Live mode: the in-flight phase renders as a growing accent bar. */
  live?: { currentPhase: string | null; currentPhaseStartedAt: string | null } | null;
}): ReactNode;
```

  Mapping `AttemptPhase → PhaseTimings key` mirrors §2.1. Build a full `PhaseTimingsJson`
  from the partial (`{ perTask: [], …nulls, …progress.phases }`). The live row: duration =
  `now - currentPhaseStartedAt` (via `useNow(1000)`), bar from the cumulative cursor,
  accent color + `pulse` class, duration cell shows `<Elapsed>`. Phases not yet reached
  render dim "Pending" instead of "Not measured" while live.
- When the attempt finished (or registry empty after a server restart): exactly today's
  behavior (persisted `attempt.timings`, "Timings land when the attempt finishes" /
  "Timings not captured (older run)").

### 10.2 Item 9 — checks/judgments as an expandable table

Replace the stacked `JudgmentBlock` list (terminal state) with a `DataTable` using the new
`renderExpanded` (IMPLEMENTED):

- Columns (collapsed row): Kind (glyph ≡/✶ via `judgmentKindInfo`, tooltip = label, 40px),
  Name, Verdict (`StatusScore status={pass?"pass":"fail"} score`), Duration
  (`fmtDuration(j.durationMs)`, right), Cost (`fmtCost(j.costUsd)` + harness-overhead
  tooltip; dim — for deterministic/null, right), Age (`fmtAgo(j.createdAt)`).
- `renderExpanded: (j) => <JudgmentDetail judgment={j} />` — the existing JudgmentBlock
  body (reasoning, `<JudgeTrace trace={judgmentToTrace(j)} />` when `j.steps` non-null,
  raw toggle, "Trace not captured (older run)" fallback) minus the head row (now the table
  row). `searchable={false}`, no sort default (insertion order = created order).
- LIVE precedence is unchanged: while `judging` with live traces, render the streaming
  `<JudgeTrace live>` cards exactly as today (no table).

### 10.3 Item 10 + 14 — Logs tab

New tab "Logs" between Timings and Assets (`type RdTab = … | "logs"`).

- **Sources**: segmented control `[Runner | Worker | API]` (plain `.btn`-style toggles).
  - Runner: while `isUnfinished(attempt.status)` AND `progress.active` → live
    `progress.log` lines (poll shares §10.1's 2 s `usePoll`); else the `runner.log`
    artifact (kind `"log"`).
  - Worker: artifact kind `"sandbox-log"` name `worker.log`.
  - API: artifact kind `"sandbox-log"` name `api.log`.
- **Fetching artifact content**: `fetch(artifactUrl(artifact.id)).then(r => r.text())`
  lazily per source on first open (the meta list has no content). Cache per attempt id.
- **Rendering**: parse each line into `{ ts?, level, message }`:
  1. runner.log: `^(\S+) \[(info|warn|error)\] (.*)$` (the §2.2 format);
  2. JSON lines (worker/api logs are pino-ish): `JSON.parse` → `level` numeric map
     (≥50 error, ≥40 warn, else info), `time`/`ts` → timestamp, `msg`/`message` → text;
  3. fallback: raw line, level info.
  Row = dim mono timestamp (HH:MM:SS) + level glyph (`·` info dim / `⚠` warn yellow /
  `✗` error red) + message (pre-wrap, single-line ellipsis with expand-on-click is fine).
  Auto-scroll pinned to bottom while live (only when already at bottom).
- **Fallbacks**: missing source → "Runner log not captured (older run)" / "Worker log not
  captured" etc.; zero artifacts + unfinished → "Logs land as the attempt progresses…".
- Assets tab: add `"log"` to `ASSET_KIND_GLYPHS` (suggested glyph `≣`).

### 10.4 Items 5, 7, 11, 12, 13 — see §8, §6, §7, §1.3, §4.

## 11. WP-TRANSCRIPT4 — transcript polish (item 8, wave 1)

Owns: `evals/ui/src/pages/Transcript.tsx`, `transcript.css`, `evals/ui/src/logs-parser/*`
(if needed). Uses the shared `<Markdown>` (IMPLEMENTED,
`evals/ui/src/components/Markdown.tsx` — headings, fenced code, lists, quotes, rules,
inline code/bold/italic/links; React-rendered, no innerHTML).

- **Assistant text blocks**: `TextView` for `msg.role === "assistant"` renders
  `<Markdown text={block.text} />` (other roles keep plain pre-wrap text).
- **Thinking**: keep the collapse behavior; body stays plain pre-wrap but styled italic +
  dim (it's stream-of-thought, not markdown).
- **Tool cards**: humanize the head — after the tool name, a single-line dim arg preview
  (first meaningful string input: `command` / `file_path` / `path` / `url` / `pattern` /
  first string value; ellipsized). Args: collapsed by default behind `▸ Args` when the
  input has > 1 key (today's always-open `JsonView` becomes the expanded state); results
  keep `ClippedText` but with a smaller default clip for non-error results is allowed.
- **Result/meta/raw blocks**: keep structure; restyle so nothing renders as a wall of
  monospace — sans body for assistant/user text, mono reserved for code/tool/raw payloads.
- No parser changes required (`logs-parser/*` only if a provider needs a block split fix).

## 12. Ownership matrix (wave 1 — disjoint; wave-0 layer is read-only)

| Package | Files (exclusive) | Implements |
|---|---|---|
| WP-RUNNER4 | `evals/src/runner/index.ts`, `evals/src/swarm/client.ts`, `evals/src/swarm/sandbox.ts` | §1.1 (cancel fix), §2.1–§2.2 (progress wiring + runner.log) |
| WP-API4 | `evals/src/api/server.ts` | §3 (progress endpoint) |
| WP-RUNS4 | `evals/ui/src/pages/RunsPage.tsx`, `NewRunDialog.tsx`, `runs.css` + secondary `ScenariosPage.tsx`, `scenarios.css`, `ConfigsPage.tsx`, `configs.css` | §9 (items 1–4), §1.3, §4 adoption, §6 contexts |
| WP-RUNDETAIL4 | `evals/ui/src/pages/RunDetailsPage.tsx`, `Waterfall.tsx`, `JudgeTrace.tsx`, `run-details.css` | §10 (items 5, 6, 9, 10, 11, 14-display), §1.3, §4 adoption, §6 contexts |
| WP-TRANSCRIPT4 | `evals/ui/src/pages/Transcript.tsx`, `transcript.css`, `evals/ui/src/logs-parser/*` | §11 (item 8) |

Wave-0 (ALREADY LANDED, read-only for wave 1): `evals/src/types.ts`,
`evals/src/live/attempt-progress.ts` (+ test), `evals/ui/src/types.ts`,
`evals/ui/src/api.ts`, `evals/ui/src/hooks.ts`, `evals/ui/src/styles.css`,
`evals/ui/src/components/{ConfigChip,ConfirmDialog,Markdown,DataTable,Matrix,StatusBadge,Tooltip,HarnessIcon}.tsx`,
this spec. `evals/src/db/*` needed NO changes (artifacts.kind is unconstrained TEXT;
`insertArtifact` already accepts the new `"log"` kind via the types union).

If you believe you must touch a file you don't own — STOP, the spec is wrong; escalate.

## 13. Verification (every wave-1 package)

```bash
cd /Users/taras/Documents/code/agent-swarm/evals
bun run tsc:check                          # zero errors in your files
bun test src/cost/ src/judge/ src/live/    # all green (WP-RUNNER4 especially)
cd .. && bunx biome check --write <your files>
```

Manual E2E (integrator): `bun src/cli.ts serve`; start a 1×1 run →
`curl localhost:4801/api/attempts/<id>/progress` while it runs (currentPhase + phases +
log growing; Timings tab shows the live waterfall; Logs tab streams the runner log);
press Cancel mid-boot AND mid-task → in-app confirm modal, run flips `cancelled` within
seconds, attempts back to `pending`, `e2b sandbox list` shows no leaked sandboxes, Resume
re-runs them; after finish → runner.log artifact in Assets/Logs; runs table: hover a
truncated run name (full name tooltip) and the Scenarios cell (mini matrix); new-run
dialog: judge-model menu open at the bottom of the list → NO modal scrollbar, every field
has an ⓘ; run-details: exactly one spinner next to the run name; tab bar never shows
content above it while scrolling; checks tab label `Checks n/m ✶…`; checks table rows
expand to full traces; transcript shows markdown-rendered assistant text. Open an OLD run:
progress endpoint returns `{ active: false … }`, Logs tab shows "not captured (older run)"
fallbacks, nothing 500s.
