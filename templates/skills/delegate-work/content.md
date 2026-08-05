# delegate-work

Claude (Fable 5) is the **orchestrator**: it thinks, designs, schedules, reviews, commits, and talks to the user. Everything else is delegated to the **cheapest executor that clears the quality bar**. Codex types; Claude judges.

This skill applies in BOTH modes:
- **Ad-hoc**: any time you'd spawn an `Agent`/Task, pick its model from the matrix below instead of the default.
- **Plan execution**: inside `desplega:implementing` / `desplega:v-implementing` (and `run-phase` / `run-step`), keep ALL of their orchestration semantics (autonomy modes, checkpoints, plan bookkeeping, commit strategy) — only the executor choice changes: instead of default phase-running/step-running sub-agents, route each phase/step per the matrix.

## The matrix

Rankings 1–10, higher = better. Cost = subscription quota burned — both Claude and Codex run on flat-rate subs, so higher = lighter on that plan's rate limits (Fable burns the Claude quota fastest; Codex quota is comparatively abundant). Code = how hard a coding problem you can hand it unsupervised. Taste = UI/UX, code quality, API design, copy.

| executor                | cost | code | taste | speed | role |
|-------------------------|------|------|-------|-------|------|
| fable-5                 | 2    | 9    | 9     | 4     | orchestration, deep reasoning, architecture, final judgment |
| opus-5                  | 4    | 7    | 8     | 5     | UI implementation, complex review, browser E2E |
| sonnet-5                | 5    | 5    | 7     | 7     | routine review, API QA agents, standard sub-agent work |
| haiku-4.5               | 9    | 3    | 4     | 9     | search, locate, digest, mechanical sweeps — NEVER for writing code |
| codex gpt-5.6-sol       | 8    | 10   | 6     | 6     | hard/long-horizon implementation, gnarly debugging |
| codex gpt-5.6-terra     | 9    | 8    | 5     | 8     | everyday implementation from a frozen spec |
| codex gpt-5.6-luna      | 10   | 6    | 4     | 10    | mechanical code: migrations, renames, test fills, dep bumps |

(Context for the Codex rows, from the 5.6 release: Sol-max is SOTA on the AA Coding Agent Index, ~3 pts above Fable 5 at ~⅓ the cost; Terra lands just above Fable 5; Luna outperforms Opus 5 — each in ~⅓ the time. Claude keeps the edge on taste and judgment; that's why review and UI stay Claude-side.)

**Defaults, not limits.** Standing permission to override: if a cheaper executor's output doesn't meet the bar, rerun or redo with a smarter one without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.

## Routing table

| work | executor | how |
|------|----------|-----|
| orchestration, deep reasoning, spec-writing, architecture | **Fable 5** | stay in the main session; never delegated |
| UI implementation (pages, components, styles, UX flows) | **Opus 5** | `Agent` with `model: "opus"`, background |
| code review — routine / per-phase | **Sonnet 5** | `Agent` with `model: "sonnet"` |
| code review — complex, security-sensitive, cross-cutting, or reviewing Sol output | **Opus 5** (+ optional parallel Codex review, see Verify ↓) | `Agent` with `model: "opus"` |
| API-level QA / E2E agents, plan-verification agents | **Sonnet 5** | `Agent` with `model: "sonnet"` |
| browser E2E / driving the real UI | **Opus 5** | `Agent` with `model: "opus"`; use a browser-automation agent for local URLs unless stated differently |
| search, locate, pattern-find, doc digests | **Haiku 4.5** | `Explore` / locator agents with `model: "haiku"` |
| bulk mechanical call-sequences (~10+ similar tool/API calls, any fan-out over a list) | **a script** | `desplega:script-builder` — cheapest executor of all; one summary re-enters context, raw payloads never do |
| raw code implementation from a frozen spec | **Codex** | variant by scope ↓, via `codex-exec.sh` |

**Codex variant by scope** (effort in parentheses):

- `gpt-5.6-luna` (`medium`→`high`) — mechanical & bounded: renames, mechanical migrations, test/coverage fills, CI fixes, dep bumps, single-file bug fix with known repro.
- `gpt-5.6-terra` (`high`) — the default for a well-specified phase/step: single vertical slice, clear verification, few unknowns.
- `gpt-5.6-sol` (`high`; `xhigh` for hard, `max` only for the gnarliest long-horizon work) — multi-file backend phases, cross-package changes, subtle debugging, anything where the spec has known-unknowns.
- Never use Codex `ultra` (its own multi-agent mode) — parallelism is the orchestrator's job, via worktrees.

**Keep in Claude regardless of matrix**: tasks where writing the spec IS the work (ambiguity = design); tiny edits (<~20 lines) where delegation overhead loses; anything needing session tools (MCP, browser, secrets); destructive/irreversible ops, pushes, GitHub mutations; judging delegated output — executors may contribute reviews, but the join and final verdict are never delegated, never skipped.

Heuristic: if the prompt reads as a work order → delegate; if writing it forces decisions → it's design, keep it.

## Workflow-tool orchestration

When the harness exposes the `Workflow` tool AND the user has opted in (the desplega skills ask during setup — that answer IS the explicit opt-in the tool requires), fan-out runs as a workflow script instead of ad-hoc `Agent` calls. The matrix above still routes every executor; it just maps onto `agent()` opts:

- **Model tiers** → `model: "haiku" | "sonnet" | "opus"`; omit `model` for work that must stay at orchestrator quality (it inherits the session model). `effort` follows the same logic: `low` for mechanical stages, higher tiers only for verify/judge stages.
- **Named agents** (locators, analyzers, pattern-finders) → the `agentType` opt.
- **Codex rows** still apply inside a workflow: an `agent()` can drive `codex-exec.sh` in its own worktree. Plan bookkeeping and commits stay orchestrator-side, as always.
- **The join stays Claude-side**: the workflow returns data (findings, reports, file lists) — reading the diff, deduping findings, and the final verdict happen in the main session, never inside the script.
- **Pause points sit between Workflow invocations** — one workflow per wave/stage, orchestrator judges and checkpoints in between. Never bury a human checkpoint inside a script.

## Codex: the one primitive

> **Prerequisite**: the `codex` CLI on PATH, authenticated, with access to the gpt-5.6 models. If it's missing, the Codex rows of the matrix are unavailable — route implementation work to Claude executors instead (Opus for hard slices, Sonnet for routine ones) and tell the user why.

`bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh`

```
printf '%s' "$PROMPT" | bash ~/.claude/skills/delegate-work/scripts/codex-exec.sh -m gpt-5.6-terra -e high \
  -C <workdir> -o <report-file> -l <log-file>
```

- `-m` model / `-e` reasoning effort — from the scope table above (script defaults: `gpt-5.6-sol` + `high`; env overrides `CODEX_MODEL`/`CODEX_EFFORT` still work).
- `-C` working root — a **git worktree** for parallel work, repo root for sequential.
- `-o` report file — Codex's final message; read THIS back, not the log.
- `-l` log file — for monitoring only; keep raw logs out of the session.
- Sandbox defaults to `workspace-write` (edits inside `-C`, reads anywhere). `CODEX_BYPASS=1` only when a task genuinely must write outside its worktree.
- **Always background** (`run_in_background: true`, `timeout: 600000`).
- **Prompt via stdin/temp file, never inline arg** — the inline form can silently drop the prompt and hang on stdin (observed). A ~39-byte log means it hung.
- Follow-up fixes: `codex exec resume --last` from the same dir is cheaper than a fresh run and keeps its context — use for review-fix rounds and crash recovery ("assess partial state via git status/diff first; don't redo, don't trust").
- After **2 failed rounds** on the same task: stop delegating, take over directly (or escalate the model one rung).

## Codex prompt contract

Codex starts with zero session context. Every prompt: goal, exact repo/paths (absolute plan path in the MAIN repo — worktrees don't contain untracked `thoughts/`), scope fence ("ONLY Phase N / step-N, don't touch X"), non-goals, verification commands to run, the standards line ("smallest diff that solves the problem; no speculative abstractions" — per `desplega:engineering-standards`), and the report shape (status completed/blocked/failed, files changed, verification output, notes). Codex must NOT edit the plan file — the orchestrator owns all plan bookkeeping.

## Worktrees & parallelism

**Always clean up after use** — the moment a slice is merged or abandoned: `git worktree remove <path>` + `git branch -d codex/<slug>`. Never leave stragglers; before ending a session, `git worktree list` must show only the main tree (and any worktree the user created themselves).

- Sequential (linear plan): repo root or one dedicated worktree; one phase at a time; orchestrator verifies, ticks boxes, commits `[Phase N] <name>`, honors checkpoints.
- Parallel (DAG plan / independent slices): one worktree per slice — `git worktree add -b codex/<slug> <path> <integration-branch>`; fan out one Codex per ready step; merge back sequentially with `--no-ff`; remove worktree + branch after merge.
- **`bun install` (or equivalent) in every fresh worktree BEFORE launching** — a deps-less sandbox "verifies" nothing and ships unproven code.
- Codex cannot `git commit` inside linked worktrees (index lives under the main repo's `.git` → EPERM). Tell it not to commit; the orchestrator commits.
- Parallel Claude agents sharing ONE tree need strict file fences: commit only their own paths, never `git add -A`.

## Verify (Claude judges, always)

- Read the full diff and judge it like a contributor PR; Codex/sub-agent claims are advisory.
- Re-run the phase/step verification commands yourself when the report is ambiguous.
- After web service-layer changes: probe the running dev server — unit tests miss RSC import crashes.
- UI touched by anything non-Opus (or by Codex at all): hands-on polish pass — drive the real UI, screenshot, fix spacing/copy/empty-states yourself.
- Then the per-phase review round before closing the phase: `desplega:code-reviewing` — two axes (Standards per `desplega:engineering-standards`, Spec against the phase body), parallel sub-agents Sonnet/Opus per the table, reported separately and never merged.
- **Codex can review too**: for complex/high-stakes phases, add a Codex review (`codex exec review`, or a sol review prompt via `codex-exec.sh`) in parallel with the two Claude axes, then join — dedupe findings, discard false positives, rank the rest. The JOIN and the final verdict stay Claude-side; a review is never delegated to a single executor and never skipped.

## Failure & mismatch handling

Same as `implementing`/`v-implementing`: on blocked/failed or plan-vs-reality mismatch, `AskUserQuestion` (Adapt / Retry / Skip / Stop); in Autopilot use judgment and document it. Cleanup on abort: `git worktree list` → `git worktree remove --force` stragglers, delete `codex/*` branches.
