---
date: 2026-06-16
branch: evals/swarm-redesign-plan-a
topic: "Why delegation-probe's `delegation` dimension returns exactly 0.50 on every attempt"
status: complete
evidence: /tmp/evals-pilot.sqlite (run-202606161340-0b26da, claude-opus-4.8 ×5, pi-deepseek-flash ×5)
scenario: evals/scenarios/delegation-probe.ts
---

# delegation-probe: the `delegation` dimension is pinned at 0.50 by structural N-penalties — root cause

## TL;DR

The delegation dimension is **not** an enumeration bug and **not** a field-shape bug. The runtime-spawned
tasks (children + follow-ups) WERE captured into `ctx.tasks` (the run log says `[task] captured 24
runtime-spawned task(s) for scoring`). The rubric's **positive checks largely fire** for a genuinely
delegating lead. The 0.50 is produced by **two negative penalties that fire structurally on every attempt**:

- **N2 (-0.25)** fires because the lead used the `Write` tool — but writing the merged report is
  **mandatory** (it's the `report-exists` gate and the whole point of the scenario). N2 treats the
  required deliverable as a forbidden "implementation tool."
- **N4 (-0.25)** fires whenever P3 (a follow-up was received) is true, because N4 is implemented as
  `p3 && n2Tool !== undefined` — i.e. it re-uses the same `Write` signal that N2 already flagged. So a
  lead that delegated well enough to receive a follow-up is *double-penalized* for the same mandatory Write.

The result: a perfect delegator (P1=P2=P3=P4 all pass → positive 1.00) lands at `1.00 − 0.25 − 0.25 = 0.50`.
A partial delegator that wrote a report but got no follow-up (P1=P2=P4 pass, P3 fail → positive 0.75) lands
at `0.75 − 0.25 = 0.50`. A delegator that never wrote a report at all (no Write → no N2/N4) but only earned
P1+P4 (positive 4/8 = 0.50) **also** lands at 0.50 with zero penalties. **Multiple distinct behaviors
collapse onto the same 0.50 plateau** — that is why it is constant and discriminates nothing.

Root-cause category: **a blend of (b) field/predicate design defect + a penalty-design defect.** It is NOT
(a) enumeration gap, NOT (c) follow-ups-don't-fire (they DO fire), NOT (d) apiGet failure, NOT (e) genuine parity.

---

## Evidence trail

### 1. The runtime-spawned tasks ARE captured (rules out enumeration gap (a))

The `task` artifact in the run DB (`kind='task'`, `tasks.json`) contains **only 1 task** for every attempt —
the lead's seed task, with no `creatorAgentId` / `parentTaskId` / `taskType`. That looks damning, but it is a
**red herring**: the artifact is serialized from the *upfront* `tasks` array (`runner/index.ts:1694` →
`JSON.stringify(tasks, …)`), NOT from `ctxTasks`. The checks run against `ctx.tasks = ctxTasks`
(`runner/index.ts:1511`), which is `[...tasks, ...listAllTasks()-spawned]` (lines 1290–1295). The run log
confirms the merge happened:

```
2026-06-16T13:44:48.527Z [info] [task] captured 24 runtime-spawned task(s) for scoring
```

`24 spawned + 1 upfront = 25` in `ctx.tasks`. The seed fixture
(`evals/scenarios/fixtures/delegation-probe-history.sql`) inserts **20 `agent_tasks`**. So
`25 = 20 seeded history + 1 lead seed + 2 child tasks + 2 follow-ups`. The children and follow-ups were
present for the checks. **The artifact under-reporting is a separate (cosmetic) bug, not the cause.**

### 2. The lead genuinely delegated (rules out (e) genuine parity)

Parsing the lead's `raw-session-logs` (58 ndjson rows, single `taskId` = the lead seed) for `tool_use`
events, claude-opus-4.8 #1 did exactly what the scenario wants:

- `mcp__agent-swarm__send-task` ×2 → researcher-alpha (`6bf8027a…`) "audit completed", researcher-beta
  (`2a385b06…`) "audit failed+cancelled". No `parentTaskId` passed, so `send-task.ts:173`
  `effectiveParentTaskId = sourceTaskId` = the lead seed task, and `creatorAgentId = lead` (owner kind,
  `send-task.ts:145`). → P1's predicate (creator=lead, parent=seed, assigned-to-worker) is satisfiable.
- `mcp__agent-swarm__get-task-details` ×2 → polled both child ids (`96c5cafb…`, `fdc64cb3…`) to read results.
- `mcp__agent-swarm__store-progress` (final output explicitly states "I did NOT query the tasks API … I
  orchestrated two researchers and merged their findings").
- `Write` ×1 → the merged report (the gate). `Bash` ×2 → `sleep 60` and `mkdir -p /workspace/audit`.
- `get-tasks` ×1 with input `{"limit":30}` — **no status filter**, so **N1 does NOT fire** (the dimension is
  NOT hard-zeroed).

correctness = 1.00 for claude (the merged report carried all four answer-key facts), which independently
proves the workers really audited the seeded history and reported real data the lead merged. A genuinely
delegating, correct lead scoring delegation=0.50 is the smoking gun for a measurement defect.

### 3. The exact 0.50 arithmetic (claude attempt)

Positive weights P1=3, P2=2, P3=2, P4=1 (total 8). Penalties N2=0.25, N3=0.5, N4=0.25.

For a clean delegator (claude): **P1✓ P2✓ P3✓ P4✓** → positive = 8/8 = **1.00**. Then:

| check | fires? | why | delta |
|---|---|---|---|
| N1 (hard zero) | NO | `get-tasks` had no status filter | — |
| N2 (-0.25) | **YES** | lead used `Write` (the **mandatory** report) — `leadUsedImplementationTools` flags any `Write`/`Edit`/`MultiEdit` | −0.25 |
| N3 (-0.5) | NO | no worker re-delegated | — |
| N4 (-0.25) | **YES** | `n4Redo = p3 && n2Tool !== undefined` → P3 passed AND the Write tool is the same `n2Tool` | −0.25 |

`1.00 − 0.25 − 0.25 = 0.50`. ∎

Enumerating all P-combos with N2 forced (Write always present) and N4 = (P3 && Write), **exactly two
combinations** hit 0.50:
- `P1✓ P2✓ P3✓ P4✓` → 1.00 − N2 − N4 = 0.50 (the clean delegator: claude)
- `P1✓ P2✓ P3✗ P4✓` → 0.75 − N2 = 0.50 (delegated + wrote report, but no follow-up landed)

And with no Write at all (no N2/N4), `P1✓ P4✓` alone = 4/8 = 0.50 (pi#3, see below). Three different
behavior profiles, one number.

### 4. claude vs pi: the artifacts DIFFER, proving the rubric is blind

Tool-use analysis across attempts:

| attempt | send-task | report Write? | data-scrape? | gate report-exists | correctness | delegation |
|---|---|---|---|---|---|---|
| claude #0,#1,… | 2 → 2 workers | yes (`Write`) | no | PASS | 1.00 | **0.50** |
| pi #0 | 2 → 2 workers | yes (`write`) + used `db-query` | no (db-query not flagged) | PASS | 1.00 | **0.50** |
| pi #3 | 2 → 2 workers | **NO Write, NO report** | no | **FAIL (no report)** | 0.00 | **0.50** |

pi#3 is the decisive control: it **never wrote a report** (gate failed, correctness 0), so N2/N4 cannot
fire on the Write path — yet delegation is **still 0.50**. Its 0.50 must come from positives alone
(`P1✓ + P4✓ = 4/8`, with P2/P3 failing because its children likely didn't complete-with-output / no
follow-up). So claude reaches 0.50 *from the top* (perfect positives crushed by two penalties) while pi#3
reaches 0.50 *from the bottom* (half the positives, no penalties). **A perfect delegator and a
report-less delegator receive the identical delegation score.** The rubric cannot distinguish them — it is
measurement-blind, exactly as the finding suspected.

(Total-score discrimination — claude 0.643×5; pi 0.643/0.571/0.643/0.357/0.571 — comes entirely from the
correctness dimension: `(5·0.5 + 2·correctness)/7`. With delegation pinned at 0.5, the weight-5 dimension
contributes a constant 2.5/7 to every attempt and discriminates nothing.)

---

## Root cause (specific)

1. **N2 penalizes the mandatory deliverable.** `leadUsedImplementationTools` (delegation-probe.ts:161)
   flags any `Write`/`Edit`/`MultiEdit`. But the scenario REQUIRES the lead to `Write`
   `/workspace/audit/merged-report.md` — it is the `report-exists` gate. Every competent run trips N2.
   The intent ("the lead orchestrates, doesn't implement") is sound, but "writing the merged report" is
   orchestration output, not implementation, and the detector can't tell them apart.

2. **N4 double-counts the same signal.** `n4Redo = p3 && n2Tool !== undefined` (delegation-probe.ts:319).
   N4 is meant to catch "lead re-did *data research* after the first follow-up," but it reuses `n2Tool`,
   which for any report-writing lead is just the `Write` block — not a data-research call. So N4 fires for
   the *exact same Write* N2 already punished, the moment a follow-up exists. A better delegator (one that
   actually triggers a follow-up, P3) is penalized *more*.

3. **Net effect:** the maximum achievable delegation score for a lead that writes the required report is
   `1.00 − 0.25 − 0.25 = 0.50` when it also earns a follow-up, or `0.75 − 0.25 = 0.50` when it doesn't.
   0.50 is a *ceiling*, not a measurement — and weaker runs that earn fewer positives but write no report
   land on the same value from below. The dimension has effectively zero usable dynamic range.

4. **Seeded-history pollution (secondary).** `ctx.tasks` carries the 20 seeded `agent_tasks`. The current
   predicates exclude them correctly (their agentIds aren't lead/workers), so they don't corrupt P1–P4
   today — but they are noise that any future predicate change can trip over, and `findDelegationLoops` /
   `findLeadSeedTask` scan them needlessly.

5. **Cosmetic:** the `task` artifact is serialized from `tasks` (upfront only), so the persisted
   `tasks.json` can never show the child/follow-up paper-trail the checks actually scored — it should
   serialize `ctxTasks`.

---

## Fix recommendations

### Minimal, high-confidence (makes delegation discriminate)

1. **Exempt the mandatory report from N2.** In `leadUsedImplementationTools`, do not count a `Write`
   whose path is the report file (`REPORT_FILE`), or — simpler and more robust — drop the `Write`/`Edit`
   trigger from N2 entirely and keep only the *data-scrape* Bash signal (`/api/tasks`, `agent_tasks`). The
   lead writing files is fine; the lead pulling the audit *data* itself is the real violation, and N1
   already covers the MCP `get-tasks` path. Also extend the data-scrape detector to the `db-query` MCP tool
   (pi#0 audited via `db-query` and escaped every negative check — a real anti-gaming hole).

2. **Decouple N4 from the Write signal.** N4 must mean "lead ran *data research* after the first
   follow-up." Detect a tasks-API / `agent_tasks` / `db-query` tool call ordered *after* the first
   follow-up in the lead transcript — never a `Write`. As written it is unsalvageable as a re-research
   signal; either re-implement it against the data-research detector or remove it.

3. **Serialize `ctxTasks` (not `tasks`) into the `task` artifact** (`runner/index.ts:1694`) so the
   delegation paper-trail is actually inspectable post-hoc. (Cosmetic but it cost an hour of this
   investigation.)

With (1)+(2), claude's clean delegation → positive 1.00 with no penalties → **delegation ≈ 1.00**, while a
report-less / no-follow-up pi run → positive 0.50–0.75 → **delegation 0.50–0.75**, and a solo-auditing lead
→ N1 hard-zero. The dimension regains dynamic range and discriminates tiers.

### Is delegation-probe salvageable?

**Yes, with the rubric fixes above — no harder redesign of the scenario mechanics is required.** The hard
parts already work: runtime-spawned-task enumeration captures children + follow-ups, follow-ups fire in the
sandbox (`worker-follow-up.ts` sets `source:'system'`, `taskType:'follow-up'`, `parentTaskId=child.id`,
`agentId=lead`), and the positive checks correctly match a real delegation tree. The defect is entirely in
the **negative-penalty design** (N2 punishes the required deliverable; N4 re-uses N2's signal). Fix those
two and add anti-gaming coverage for `db-query`, and the dimension should separate claude from pi.

One scenario-side hardening to consider after the rubric fix: the **P-side is also weakly discriminating** —
P1/P2/P4 pass for "any 2 children that ran," so it rewards *that* delegation happened, not whether it was
*good*. If post-fix runs still cluster, add positive credit that actually grades delegation quality (e.g.
correct shard assignment, no wasted re-delegation, lead-merge fidelity) rather than mere existence of the
tree. But that is a v2 refinement, not a blocker.
