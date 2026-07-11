---
date: 2026-07-11T17:10:00Z
topic: "Scripts-only MCP (code-mode) experiment — findings"
tags: [scripts, mcp, code-mode, context, experiment]
status: complete
---

# Scripts-only MCP ("code-mode") experiment — findings

**Date:** 2026-07-11 · **Branch:** `experiment/scripts-only-mcp` · **Setup:** `docker-compose.scripts-only.yml` (1 Claude lead + analyst + marketer workers, `SCRIPTS_ONLY_MCP=true`)

## What was tested

The external swarm MCP surface trimmed to the 8 script tools (`script-search`, `script-run`, `script-upsert`, `script-delete`, `script-query-types`, `launch-script-run`, `get-script-run`, `list-script-runs`). Every other swarm operation — delegation, progress, completion, swarm introspection — must go through `script-run` + the scripts SDK (`ctx.swarm.*`), which bridges server-side to the full 106-tool surface.

E2E scenario: lead receives "produce a marketing blurb collaboratively" → delegates stats collection to analyst → hands analyst's JSON to marketer for the blurb → aggregates and completes.

## Headline results

| Metric | Value |
|---|---|
| E2E outcome | ✅ Parent completed; correct delegation to both workers by name, real data handoff, correct final output |
| Tool-schema payload | **full: 118 tools ≈ 311 KB (~80K tokens)** → **scripts-only: 8 tools ≈ 8.8 KB (~2.2K tokens)** (~35x cut) |
| Unified context at session end | analyst ~21K, marketer ~21K, lead ~49K tokens |
| Cost | $4.67 total / 6 sessions (incl. 2 auto "review needed" follow-up sessions ≈ 40% of lead spend) |
| Wall time | ~23 min total (incl. concurrency stall, see below) |

Context note: for Claude workers, ToolSearch already defers most schemas, so the raw 80K→2.2K delta overstates the Claude win — but **pi/codex/opencode have no tool-search**, so for them the full schema really does enter every session. Scripts-only is the bigger win exactly where context is scarcest.

## Observed failure modes (each is a shippable fix)

1. **Entry-signature confusion `(args, ctx)` vs `(ctx, args)`.** All three agents probed the calling convention empirically (`argCount`/`Object.keys` scratch scripts); the marketer got the order wrong on a *real* `task_storeProgress` call before self-correcting. 2–4 wasted script runs per session.
2. **Response-envelope guessing.** SDK return shapes are effectively untyped in practice — agents wrote defensive chains like `swarm?.agents ?? swarm?.members ?? swarm?.data?.agents`. The `.d.ts` from `script-query-types` isn't giving them usable return types (or they don't trust it).
3. **"Script not found" errors.** Agents invoked named scripts (`scratch`, `probe`) that don't exist; the prompt's seed-script guidance (`task-context-gathering`, `smart-recall`) references scripts that were **not seeded** in this fresh DB.
4. **Stale "deferred tools" guidance.** The `system.agent.script_rubric` template says script tools must be loaded via ToolSearch — false in scripts-only mode (all 8 fit in context). Agents wasted ToolSearch calls following it.
5. **Child-wait is clunky but safe.** The lead correctly avoided in-script sleeps (30s abort) by alternating Bash `sleep 30` with one-shot `task_get` scripts — ~6 round trips per child. Works, but is the single most repetitive pattern observed.
6. **Manual name→id resolution.** Delegation needs agent UUIDs; the lead first ran a `swarm_get` script to map `analyst`/`marketer` names to ids.
7. **Concurrency deadlock with auto review tasks.** At `MAX_CONCURRENT_TASKS=1` the lead's in-progress parent blocked the auto-generated "worker task completed — review needed" follow-ups. Fixed live via global config `MAX_CONCURRENT_TASKS=3`; now baked into the compose file. Also: in a code-mode swarm these review sessions look like prime candidates for a cheap scripted check instead of a full LLM session.
8. **Output re-typing instead of pass-through.** The lead re-typed the analyst's JSON into its completion script rather than fetching child output programmatically — fine at this scale, silent-corruption risk at larger payloads.

## Ship-by-default recommendations

### Prompt (extend `system.agent.scripts_only_mode`, fix `script_rubric`)
- State the exact entry signature: `export default async function (args: YourArgs, ctx: SwarmCtx) { … }` — args FIRST. (Would have eliminated failure mode #1 entirely.)
- Document the response envelope convention for `ctx.swarm.*` calls (what's wrapped in `{ data }`, what isn't) — or fix the SDK types (below).
- List the named scripts that actually exist (resolve dynamically at prompt-composition time), instead of promising unseeded ones.
- Make the "script tools are deferred — use ToolSearch" sentence conditional on the full surface.
- Add the canonical wait pattern: "to wait on a child task, use the `wait-for-task` script; never sleep inside a script."

### Seed scripts (new defaults; each replaces an observed multi-call pattern)
| Script | Replaces |
|---|---|
| `delegate(agentName, task, parentTaskId?, tags?)` — name→id resolution + `task_send` | swarm_get + manual UUID mapping + task_send (3 calls → 1) |
| `wait-for-task(taskId, budgetSec≤25)` — internal poll, returns `{status, output}` early on completion | sleep+task_get loops (~6 round trips → 1–2) |
| `get-child-outputs(parentTaskId)` — statuses + outputs of all children | per-child task_get; also fixes re-typing (#8) |
| `complete-task(taskId, output)` / `report-progress(taskId, note)` | storeProgress boilerplate where the arg-order bug bit |
| `swarm-overview()` — agents + tasksByStatus summary | exactly what the analyst hand-built, defensively, twice |

### SDK / runtime
- **Typed returns in `swarm-sdk.d.ts`** — the single highest-leverage fix. Signature-only types force empirical probing; even coarse per-namespace return interfaces would remove failure modes #1–2.
- Consider including a one-line runtime hint in `script-run` error messages when the default export signature looks inverted (detectable: first param used as ctx).

### Ops
- `MAX_CONCURRENT_TASKS≥2` for leads whenever auto review follow-ups are enabled, else parent+review deadlocks.
- Seed-script seeding must run for fresh DBs (compose/local bootstrap), or the prompt must stop referencing them.

## Matrix results (2 modes × 3 completed runs, added later same day)

Same task, same images (`SCRIPTS_ONLY_MCP` env toggle only), fresh DB/volumes per run. Full data + charts: `scripts-only-vs-full-report.html` (generated from `/tmp/matrix/`).

| Mean over completed runs | scripts-only | full |
|---|---|---|
| Completed / attempts | 3/4 (1 infra boot timeout, $0) | 3/3 |
| Cost / run | **$3.13** | **$1.83** |
| Parent wall time | 9.2 min | 3.9 min |
| Tool calls / run | 49 | 25 |
| SDK-probing scripts / run | 5.7 | 0 |
| Tool errors / run | 3.7 | 0.3 |
| Worker ctx @ end | ~27K | ~29K |
| Output tokens / run | 21.9K | 8.9K |

**Measured verdict:** on the Claude harness, for a simple delegation task, full surface wins decisively — the anticipated context saving is neutralized by ToolSearch deferral, while scripts-only pays 2.5x output tokens (writing TS source) plus probing/boilerplate overhead. The scripts-only case remains promising for (a) non-tool-search harnesses (pi/codex/opencode — untested here) and (b) bulk/fan-out work; and the overhead is boilerplate-shaped (seed scripts + typed SDK + signature docs would remove most of it). Recommended default: keep hybrid for Claude; revisit scripts-only for pi/opencode after the seed-script pack lands; consider a middle surface (script tools + core task-lifecycle tools).

## Phase 2: seeds + pi/opencode matrix (same day, later)

6 seed scripts (delegate / wait-for-task / get-child-outputs / complete-task / report-progress / swarm-overview) + rewritten code-mode prompt, injected at runtime (script-upsert API + prompt-template override — no image rebuilds). pi/opencode ran deepseek-v4-flash for all 3 agents. Full data: [2026-07-11-mcp-surface-matrix-report.html](./2026-07-11-mcp-surface-matrix-report.html), tooling in [matrix-tools/](./matrix-tools/).

| Group | Done | Delegated | Cost | Wall | Lead ctx |
|---|---|---|---|---|---|
| claude/full | 3/3 | 3/3 | $1.83 | 3.9m | 39K |
| claude/scripts-only (unseeded) | 3/4 | 3/3 | $3.13 | 9.2m | 37K |
| **claude/scripts-only+seeds** | **3/3** | **3/3** | **$1.85** | **3.3m** | **25K** |
| pi/full | 3/3 | 3/3 | $0.04 | 1.9m | n/a |
| pi/scripts-only+seeds | 2/2 | 1/2 | $0.06 | 5.5m | n/a |
| opencode/full | 2/3 | 2/2 | $0.10 | 2.5m | **83K** |
| opencode/scripts-only+seeds | 1/3 | 0/1 | $0.01 | 2.7m | 38K |

Key findings: (1) **seeds fully closed the Claude gap** — cost parity, faster, lead context −37%, 16 seed calls/run; remaining errors are just bare-vs-prefixed tool names in the prompt. (2) **Schema bloat confirmed on opencode**: full surface peaks ~80K ctx; scripts-only −55%. (3) **Small models break as coordinators in code-mode**: deepseek delegates perfectly with named tools (5/5) but skips/degrades delegation when coordination goes through scripts (1/3), ignores the seed catalog, and drops parentTaskId lineage. (4) pi adapter doesn't report context usage — fix independently. (5) Delegation-fidelity (not just parent completion) belongs in the evals harness as a graded check.

Recommendation: Claude → scripts-only+seeds is now a legitimate default (or at least ship seeds into hybrid); pi/opencode small models → keep full surface; ship seeds + prefixed-tool-id prompt + typed SDK returns regardless.

## Verdict

Full code-mode is viable **today** on the Claude harness with zero SDK changes — agents figured everything out with a one-paragraph prompt note, and the friction observed is boilerplate, not architecture. The base-context reduction (~35x on schemas) matters most for non-tool-search harnesses. The five seed scripts + prompt signature note would likely cut the observed probing/wait overhead (~40% of tool calls in these sessions) to near zero.

## Artifacts

- Task tree: parent `74bac40b` → analyst `97208b6f` ✅ → marketer `419715b9` ✅ (+2 auto review tasks)
- Analysis tooling: `/tmp/so-analyze.ts` (session-log tool-call extractor), `/tmp/so-poll.ts`
- Stack: `docker compose -f docker-compose.scripts-only.yml up -d` (API on host :3113; :3013 is the pm2 dev API)
