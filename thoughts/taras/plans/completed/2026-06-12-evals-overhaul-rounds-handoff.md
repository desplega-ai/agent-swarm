---
date: 2026-06-12T01:30:00Z
topic: "Handoff: evals overhaul rounds 1-7 (PR #737) — round 7 IN FLIGHT"
status: handoff
branch: feat/evals-subproject
pr: 737
---

# Handoff: evals overhaul rounds 1–7 (PR #737)

**Branch:** `feat/evals-subproject` · last commit `4c87730c` (pushed) · PR #737 draft.
**CRITICAL: round 7 is RUNNING in the background right now** — see "Round 7 in flight" below. The previous session launched it and will NOT receive its completion notification; this session must poll.

## Arc summary (rounds 1–6, all committed + pushed)

Seven QA-feedback rounds were executed as ultracode workflows (wave-0 contracts agent → parallel disjoint-ownership packages → verify loop w/ real-money E2E → adversarial audit → fixers). Committed across `7ed748c6`, `09abfdf9`, `d1e00afa`, `4c87730c`:

1. **R1**: UI rebuilt as Vite+React+TS (`evals/ui/`, `ui:build` → dist served by Bun server :4801); cost always tracked (harness → recompute tokens×models.dev → `unpriced`); extreme data capture (sandboxJson at boot, phase timings, meta artifacts); judge default `deepseek/deepseek-v4-pro`; transcript = ported `ui/src/logs-parser`.
2. **R2**: live transcript (`?live=1` via stored apiUrl+swarmKey), portal tooltips, glyph statuses, Configs page, PrettyView, ModelChip, HarnessIcon, waterfall timings tab.
3. **R3**: judge observability — JudgeTrace per judgment (steps w/ reasoning/tool outputs/elapsed/tokens/cost), live judge streaming (in-memory registry + `/judge-live`), judge cost separate from task cost.
4. **R4**: cancel actually works (4-part root cause: signal threading through all polling), live attempt progress + runner.log, Logs tab, ConfirmDialog, ConfigChip, version capture (API `/health` + `agent-swarm version`), embedding envs → API sandbox, `NODE_ENV=production`.
5. **R5**: analytics page (`#/analytics`: matrix HeatTable, model rollups w/ cost-per-minute, version-event time series), expandable runs table, cost wait 62s→13s, ANSI-clean versions, **root fix** `OPENCODE_SERVER_TIMEOUT_MS=30s` in `src/providers/opencode-adapter.ts` (83% opencode spawn-flake; reaches sandboxes only at next template publish).
6. **R6**: multi-worker v1 (sandboxJson v2 `workers[]`), `seed.sqlDump` (pre-boot import) + `seed.memories` (readiness gate), **native task dependsOn** (swarm API supports it; cascade-skip semantics), opencode infra net (`INFRA_FAILURE_SIGNATURES` short-circuit → retry → `error` not scored), boot-log timestamping + Logs severity, 26-config catalog + ConfigMultiSelect, 6 scenarios E2E-proven (~$1.43).

Specs: `thoughts/taras/plans/2026-06-11-evals-overhaul-spec.md` + `-v2/-v3/-v4/-v5-spec.md`, `2026-06-11-evals-v6-seeding-multiworker-spec.md` (+§9-13 extensions). Research: `thoughts/taras/research/2026-06-11-evals-sandbox-envs-multiworker-sql-seeding.md`.

## Round 7 IN FLIGHT

- **Workflow task id `wj2ykmb5c`, run id `wf_38745c03-d92`** (resumed once to add item 12).
- Output lands at `/private/tmp/claude-501/-Users-taras-Documents-code-agent-swarm/39c292b1-978a-472f-914a-e1414856859e/tasks/wj2ykmb5c.output` (JSON; may take 1–3h total — includes real E2E).
- Script (for resume after edits): `/Users/taras/.claude/projects/-Users-taras-Documents-code-agent-swarm-evals/d90b7981-dfcf-4814-aaf0-f576fdd153bf/workflows/scripts/evals-overhaul-v7-wf_38745c03-d92.js` — resume with `Workflow({scriptPath, resumeFromRunId: "wf_38745c03-d92"})` after `TaskStop`.
- **Check status**: `TaskOutput(task_id: "wj2ykmb5c", block: false)`. Extract verdict when done:
  `jq -r '.result | .verifyPassed, .failedPackages, .remainingIssues, .auditGaps, .sharedChangeRequests' <output-file>` then `jq -r '.result.verifyReport' | tail -30`.
- **Scope (12 items)**: writes spec `thoughts/taras/plans/2026-06-12-evals-overhaul-v7-spec.md`; wave 0 researches worker-template env contract + `GET /api/agents` roster + lead-role boot + alias rule; packages: WP-CORE (WorkerSpec w/ per-member config/model overrides + optional `Scenario.lead` — "lead w opus, workers w smaller" is item 12; roster capture; per-member cost+token attribution; universal token capture; fable config → `claude-fable-5`; dummy-scenario removal w/ graceful historical rendering; heterogeneous-roster demo scenario), WP-AAPI7 (analytics v2: min/max cost, duration+accuracy metrics, harness/provider groupings, tokens-vs-score scatter payload), WP-AUI7 (artificialanalysis.ai-style highlights row + scatter w/ quadrant + color-by — reference screenshots at `/Users/taras/.claude/image-cache/d90b7981-dfcf-4814-aaf0-f576fdd153bf/4.png` + `6.png`), WP-RD7 (transcript per-task sub-tabs, N-attempt aggregated run header, Workers section w/ roster/cost-per-worker/lead badge), WP-SCEN7 (two-column scenario detail, clamp+expand desc/rubric, exec overflow). Verify incl. heterogeneous-roster E2E (~$2.5 cap), audit checks against the screenshots + env-contract authenticity.

## Next steps (in order)

1. Poll `wj2ykmb5c` until done; extract verdict (pattern above).
2. If audit gaps flagged "needs sign-off" → AskUserQuestion (precedent: R6 kept the interim `OPENROUTER_API_KEY` injection into claude worker sandboxes — Taras approved "Keep it"; remove after next template publish).
3. Commit round 7 (style: `feat(evals): …` body bullets; see `git log`).
4. **Merge latest main** into the branch (`git fetch origin && git merge origin/main`), resolve conflicts (root-file overlap: merge-gate.yml, src/e2b/dispatch.ts, src/providers/opencode-adapter.ts, src/utils/internal-ai/complete-structured.ts), run `bun run lint` + `cd evals && bun run tsc:check && bun test src/` post-merge, then **push**. ← Taras explicitly asked for this.
5. Restart :4801 server with final build (`kill $(lsof -ti :4801)`; `cd evals && nohup bun src/cli.ts serve > /tmp/evals-serve.log 2>&1 &` — needs `bun run ui:build` first if dist stale).
6. Report to Taras: verdict + E2E evidence + what merged.

## Warnings & gotchas

- **Workflow conventions**: agents never git-commit; verify leaves server running on :4801; verdicts extracted via jq (results truncate in notifications). Background-agent completion notifications only reach the launching session — poll instead.
- evals.db is live data (50+ runs incl. v1-era rows) — back-compat sacred; never commit it (gitignored, as are `.env`, `ui/dist`).
- Uncommitted in tree right now: round-7 wave-0/wave-1 work in progress (agents editing live), plus a small runner artifact-naming fix (worker-0/ double-slash). Do NOT commit mid-workflow.
- The interim guards (OPENROUTER injection, `EMBEDDING_DIMENSIONS=512`, infra net) become removable after the next release publishes worker/API templates ≥ current main.
- Memory `project_swarm_evals` + CLAUDE.md govern; `bun run lint` (root) covers `evals/`; merge-gate has evals install/tsc/ui-build steps.
- Backlog (post-merge candidates): scenario backlog table (v6 spec §13.2: memory-distractor, chain-depth-3, sql-audit-history, cross-worker-invent, tier-ladder recipe), lead-orchestration scenarios, heterogeneous matrix axes, qa-use skip rule (Taras manual-QAs the SPA).

## Resume prompt

> Continue the evals overhaul (PR #737, branch feat/evals-subproject). Round 7 workflow `wj2ykmb5c` (run `wf_38745c03-d92`) is running in the background — poll its output file, extract the verdict, handle audit sign-offs, commit, merge latest main, push, restart :4801, and report. Full state in this handoff.
