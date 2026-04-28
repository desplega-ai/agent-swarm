---
date: 2026-04-28T00:00:00Z
author: taras
topic: "Per-agent daily cost budget with refusal-at-claim"
tags: [brainstorm, cost-control, agents, budgets, scheduling]
status: ready-for-research
exploration_type: idea
last_updated: 2026-04-28
last_updated_by: claude (post file-review)
---

# Per-agent daily cost budget with refusal-at-claim — Brainstorm

## Context

Initial framing — agent-swarm orchestrates multi-agent work across Claude Code, Codex, and Gemini CLI. Each agent execution incurs LLM cost (tokens × model price). Without a per-agent guardrail, a single misbehaving / runaway / poorly-scoped agent can consume disproportionate budget — either through long sessions, retry loops, expensive model selection, or sheer volume of claimed tasks.

The proposal: **per-agent daily cost budget with refusal-at-claim**.
- Each agent has a daily cost ceiling (USD or token-equivalent).
- Refusal happens at *claim time* (when the agent tries to pick up the next task), not mid-execution. This means in-flight work always finishes; budget only gates *new* work being accepted.
- If the agent is over budget for the day, it refuses (gracefully declines) to claim further tasks until the budget rolls over.

Why claim-time and not mid-execution?
- Predictable: a task, once started, runs to completion — no half-finished state, no torn DB writes, no abandoned PRs.
- Simpler: no need for cost-aware tool-call interception, no streaming-token accountant, no hard-kill of a running harness.
- Honest: cost is mostly known *after* the call, so per-call enforcement would always be reactive.

Open ground at the start of the session — needs exploration:
- What unit is the budget in? Hard USD, model-tokens, or both?
- Where does cost data come from? (Provider receipts vs. token counts × known prices?)
- Per-agent only, or also per-team / per-project / per-org?
- Does refusal mean "skip and offer to next agent" or "hold the task in queue until budget resets"?
- What's the operator override / emergency-bypass story?
- How is "daily" defined — UTC midnight, local-tz, or rolling 24h window?
- How do users see remaining budget / get alerts as they approach the cap?

## Exploration

### Q: What's the primary motivation for this budget feature right now?
**Compliance / billing limits** — external constraint (customer cap, org-wide spend limit, or contractual ceiling) that must be enforced.

**Insights:**
- Refusal must be enforceable, not advisory. Audit / proof of enforcement matters.
- The budget number maps to a real external commitment, not a heuristic.
- Tension worth pressure-testing immediately: "refusal-at-claim" means a claimed task can run past the cap. Compliance framing makes that overshoot a first-class concern, not a tolerable rounding error.
- Likely need: USD-denominated cap (most contracts are), even though tokens are what we measure. Conversion accuracy becomes a compliance question.

### Q: How strict is the daily cap on overshoot from in-flight tasks?
**Hard cap, zero overshoot.** Day's spend MUST NOT exceed the budget under any circumstances.

**Insights — major tension surfaced:**
- The proposed mechanism ("refusal-at-claim") is incompatible with hard-cap semantics. Once a task is claimed, the agent can spend arbitrarily during execution — refusal-at-claim alone gives "at-most-once-over-the-cap", not zero overshoot.
- Three ways to reconcile:
  1. **Per-task cost ceiling + claim-time admission** (cleanest): every task has a known max cost (max-tokens, timeouts, turn caps enforced at the harness layer). Claim is allowed only if `remaining_budget ≥ per_task_ceiling`. Math is exact, no torn state, refusal-at-claim becomes sufficient.
  2. **Mid-task interruption**: kill the harness when budget is hit. Destructive — abandoned PRs, torn DB writes, half-done work. Operationally painful.
  3. **Pessimistic budget reservation**: at claim, reserve an estimated max cost; release the unused portion when task completes. Functionally similar to (1) but with dynamic ceilings per task.
- Path (1) is the natural fit for the existing claim-time architecture. It does require committing to a hard per-task ceiling — which is an additional decision but a sensible one regardless (runaway-task protection).

### Q: How do we reconcile hard-cap compliance with refusal-at-claim?
**Walk-back to bounded overshoot.** In-flight task is allowed to push past the daily budget; the cap applies only to *new claims*. Plain refusal-at-claim is the mechanism. No per-task admission gate.

**Insights:**
- This revises the strictness from "hard cap" to "bounded overshoot". Compliance audit story is now: *"we stopped accepting new work once the cap was reached"*, not *"spend never exceeded the cap"*.
- Worst-case daily spend = budget + cost of the single in-flight task at the moment budget hit zero.
- Implication: we don't *need* a per-task ceiling for compliance, but we likely want one anyway — to bound the worst-case overshoot to a known, reportable number (otherwise a runaway task could blow the cap arbitrarily, which a compliance reviewer will flag). This is a "for our own sanity" cap, not a "for compliance" cap.
- The mechanism in the topic title stands. The implementation gets simpler: just track running cost per agent per day, compare against budget at claim time, return refusal if over.

### Q: What level(s) does the budget apply at?
**Global + per-agent.** Two-tier hierarchy. Higher levels (team / project / org / per-model) deferred for later.

**Insights:**
- Claim-time admission rule is conjunctive: `global_spend_today < global_budget` **AND** `agent_spend_today < agent_budget`. Either failing means refusal.
- Global budget is a server-wide kill-switch (most directly maps to a contract / org-level commitment). Per-agent is the fairness layer (one agent can't starve the rest).
- When global is exhausted, the swarm pauses globally — no agent can claim, regardless of per-agent headroom. Worth confirming this is the intended UX.
- Schema is simple: spend rows keyed by `(scope, scope_id, date)` where scope ∈ {global, agent}. Plus a `budgets` config row per scope+id.
- Per-team / per-org / per-model can be layered on later as additional scope rows without changing the core admission predicate (just AND another check).

### Q: When an agent refuses to claim because of budget, what happens to that task?
**Stays in queue, reassignable** — AND **a refusal event is reported to the lead**, the same way completion and failure events are. (Refinement volunteered by Taras after the initial answer.)

**Insights:**
- Refusal is an observable event, not silent. There's now a third terminal-ish outcome alongside "completed" and "failed": "refused (budget)".
- Self-balancing on the task side: agent A over per-agent budget refuses → agent B with headroom claims → done. The notification is what makes the refusal *visible* even when the queue mechanics handle it transparently.
- When *global* is exhausted, every agent in turn will attempt-and-refuse → potentially N notifications per task per day. Thrash on the data path is benign; thrash on the notification path is alarm fatigue. Dedup logic needed.
- Reuse the existing lead-notification plumbing (the path completion / failure already use). Adds a new event type, not a new transport.
- DB impact: task still stays `pending`; we add an event-log row per refusal (and/or update an `on_hold_reason` field for UI). Refusal events table OR a column on the task — TBD.

### Q: What unit should budgets and spend be denominated in?
**USD only.** Budgets are dollars; token counts converted via a price book at the moment of recording.

**Insights:**
- Need a price catalog: `(provider, model, token-class) → price_per_1k_tokens`, with token-class covering input / output / thinking / cache-read / cache-write distinctions.
- Price catalog needs an update story (operator UI? config file? PR-driven?). Stale prices = under/over-billed against compliance limit.
- Recording-time conversion locks the dollar value at the moment of spend — if prices change retroactively, history is unaffected. Good for audit immutability.
- Cached / batch / discount tiers need an explicit policy: "we record nominal cost" vs "we record actual cost after discounts". Compliance cap is presumably on actual cost (the contract is about dollars), so we should record the discounted number where discount info is available.

### Q: How often should a budget-refusal notify the lead for the same task?
**One notification per task.** First refusal fires; subsequent agents refusing the same task are silent (already reported).

**Insights:**
- Dedup key is `(task_id, day)` so a task that survives to the next day's reset can re-notify once if refused again.
- Implementation: a `budget_refusal_notified_on` date column on the task (or a small `budget_refusal_notifications` log table keyed by (task_id, date) with a unique constraint).
- Lead gets at most one alert per blocked task per day across all agents — clean SNR.
- Notification payload should carry: task_id, refusal cause (per-agent vs global), the offending agent_id (the first one to refuse), current spend / budget, time-to-reset.

## Synthesis

### Key Decisions

1. **Motivation: compliance / billing limits.** The cap maps to an external commitment (customer / org / contract). Refusal must be enforceable and auditable, not advisory.
2. **Mechanism: refusal-at-claim** (the one in the topic title). Admission check at claim time; in-flight tasks are not interrupted.
3. **Strictness: bounded overshoot, not hard cap.** Day's spend may exceed the budget by the cost of in-flight tasks at the moment of breach. Audit story is *"we stopped accepting new work once the cap was reached"*. The user explicitly walked back from "zero overshoot".
4. **Scope: two-tier (global + per-agent).** Admission predicate is conjunctive: `global_spend < global_budget` AND `agent_spend < agent_budget`. Either failing → refusal. Per-team / per-org / per-model deferred for V2.
5. **Unit: USD only.** Token counts converted via a price book at recording time. No mixed-unit budgets.
6. **Refused-task fate: stays in queue, reassignable.** No special status. Other agents (with headroom) can still claim. When the day rolls over, the task is naturally claimable again.
7. **Refusal is observable.** The lead is notified — same path as completion / failure events — exactly once per `(task_id, day)`, regardless of how many agents thrash on the claim. Payload carries cause (per-agent vs global), offending agent, current spend / budget, time-to-reset.
8. **Reset window: UTC midnight.** Simplest, matches existing DB conventions. Local-timezone and rolling-24h variants explicitly rejected.
9. **Cost reporting cadence: post-task (V1).** Spend is debited when a task completes (or is failed-but-billed). Incremental per-tool-call accounting is out of scope for V1. Worst-case overshoot per day = `Σ cost(in_flight_tasks_at_moment_of_breach)` — acceptable given the bounded-overshoot stance in (3).
10. **Default-when-not-configured: unlimited.** Missing budget row = no cap, by design. Back-compat for existing deployments. No deploy-time warning needed for V1; opt-in is the model.
11. **No operator override / bypass mechanism.** Operators raise the budget config if more headroom is needed. No in-line "force-claim" escape hatch.
12. **Price book: stored in DB.** Prices are first-class data (a `pricing` table keyed by `(provider, model, token_class)`), not a config file. Seeded at startup with a baseline; mutable via API/UI for tenant-specific deals or provider price changes.
13. **Alerts: refusal-only for V1.** No 80% / 95% threshold notifications. Refusal *is* the alert.
14. **Cost data source: trust the harness.** Every supported provider (Claude Code / Codex / Gemini / pi) emits usage at session end. We consume what they report and convert via the price book. No proxy-layer interception, no provider-receipt reconciliation in V1.

### Open Questions

Only one detail remains for the planning phase:

- **Refusal payload over the wire.** What the worker returns when it refuses to claim — a specific MCP tool response shape so the lead can distinguish "no work available" from "work available but I'm refusing". Resolved during `/desplega:research` once the current claim-tool response shape is mapped.

### Constraints Identified

- **Architectural.** API server is the sole DB owner; workers (where the agent actually spends) communicate via HTTP. So spend reporting is a worker → API call, and admission lookup is server-local.
- **Forward-only SQL migrations.** New schema (budgets table, daily_spend table, refusal events / notification dedup) goes in a new `NNN_*.sql` file. No down migrations.
- **Existing notification plumbing.** The lead-notification path (used today for completion / failure) must be reused, not reimplemented. New event type, same transport.
- **Secret-scrubbing.** Cost payloads may include task or session metadata; egress through `scrubSecrets`.
- **Bounded overshoot in compliance reporting.** We must be able to *report* the worst-case overshoot to a compliance reviewer, which means we need an upper bound — practically, this argues for a per-task max-cost ceiling at the harness layer (max-tokens / max-turns / timeout) even though we walked back from per-task admission. Otherwise a runaway task makes the overshoot unbounded.

### Core Requirements (lightweight pre-PRD)

**R1. Budget configuration.** Operators can set a daily USD budget at two scopes: global (one row) and per-agent (one row per agent). Mutable via API / UI. Missing config = unlimited for V1.

**R2. Spend tracking.** Every completed (or failed-but-billed) agent task contributes to two daily counters: global spend for the day, and the agent's spend for the day. Counters are USD, derived from token usage × price book.

**R3. Claim-time admission.** When an agent attempts to claim a task, the API server checks `global_spend < global_budget` AND `agent_spend < agent_budget`. If either fails, the claim is refused with a structured response carrying the cause.

**R4. Refused-task lifecycle.** A refused task stays in `pending`. Other agents may attempt to claim. No automatic deferral or terminal failure.

**R5. Lead notification on refusal.** Exactly one notification per `(task_id, day)`, regardless of refusal-attempt count, dispatched through the existing completion/failure notification path. Payload: cause, agent_id, spend, budget, reset time.

**R6. Audit trail.** Spend rows are immutable. Refusal events are logged (who tried, when, which budget). Reportable for compliance.

**R7. Bounded-overshoot guarantee.** The system must be able to report a finite worst-case overshoot per day. Practically: the existing harness max-token / max-turn / timeout caps must be present and enforced, and the per-task ceiling × max-in-flight gives the math.

## Next Steps

- [x] File-review pass complete; 7 open questions resolved into decisions 8–14.
- [ ] **`/desplega:research`** — codebase grounding for: (a) where claim happens today (admission hook point); (b) how each harness emits usage at session end; (c) where the lead-notification path lives (completion / failure plumbing); (d) what shape the existing claim-tool response uses (to design the refusal payload).
- [ ] **`/desplega:create-plan`** for V1 scope = R1–R7 once research lands.
- [ ] Status: ready-for-research.
