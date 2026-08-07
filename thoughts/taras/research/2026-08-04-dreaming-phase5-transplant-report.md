# Dreaming Phase 5 — Prod-prompt knowledge transplant, diff report

**Date:** 2026-08-04
**Worktree:** `/Users/taras/worktrees/agent-swarm/2026-08-03-dreaming` (branch `dreaming`)
**Sources compared:**

| Side | Artifact |
| --- | --- |
| PROD (live) | `/tmp/prod-monolith-compounding.txt` — `daily-compounding-reflection` (schedule `cdfa3f00-0e10-4bcd-8d69-9f10b30cb9a2`), 15,957 chars |
| PROD (live) | `/tmp/prod-blocker-digest.txt` — `daily-blocker-digest`, 8,897 chars |
| REPO baseline | `templates/schedules/daily-compounding-reflection/content.md` (v1.0.0), 10,288 chars |
| REPO baseline | `templates/schedules/daily-blocker-digest/content.md`, 5,583 chars |
| NEW target | `templates/skills/dreaming/content.md` (already carried the v1.0.0 transplant) |
| Mechanized | `src/be/seed-scripts/catalog/dream-gather.ts`, `dream-apply.ts`, `src/be/seed-workflows/dream.ts` |

**Method:** every instruction in the two prod prompts was checked against (1) the corresponding repo
template, (2) the new skill playbook, (3) what `dream-gather` / `dream.ts` / `dream-apply` already do
mechanically. Only items failing all three are deltas. Counts: **8 folded into the skill**,
**11 needing code/data decisions**, **17 dropped**.

**Only file edited in the repo:** `templates/skills/dreaming/content.md` (5 edits). No `files/` dir was
created. No other repo file touched, nothing staged or committed.

---

## Section 1 — Folded into `templates/skills/dreaming/content.md`

| # | Delta (prod source) | Landed in section | Shape it took |
| --- | --- | --- | --- |
| F1 | **"Verify, don't assume" (digest L3, Taras 2026-04-22) + every `PR #<num>`/github URL in HEARTBEAT is a verifiable claim; merged ⇒ `RESOLVED-STALE`, remove the line** (compounding 4A, Lead Rule #10) | Evidence rules → *What earns a delta* (extends the existing `RESOLVED-STALE` bullet) | "Verify, don't assume: every PR or issue reference in `HEARTBEAT` is a claim to re-check, not a status. One that already merged is `RESOLVED-STALE` and the line should come out." |
| F2 | **Touched-agent hygiene: while a profile is open, scan for dead service URLs, retired tools/files/hosts, and contradictions with current infra** (compounding 4A, second bullet — the generic rule behind the migrated-host list) | Evidence rules → *What earns a delta* (new bullet) | "A stale reference in a file you already have open… A line that is now false costs more than a line that is missing — fix it or remove it." Deliberately generic: the concrete Desplega host list is **not** hardcoded (see N2). |
| F3 | **Benign/transient failure-noise filter before reading any cluster as real signal**: `superseded_workflow_task`, `cancelled`, NUL-spawn, codex quota, reboot-sweep "worker session not found", OOM, `e2big`, plus codex sentinel-progress phantoms ("running shell command"/"querying database"/"editing" — work done, structured receipt missing) (compounding Phase 0.2; digest Phase 0 `benignSentinelPhantomsExcluded` + digest anti-pattern) | Evidence rules → *What does not* (new bullet, after "One-offs") | Names each noise class, ends with "Filter these out *before* you call two failures a pattern; what survives the filter is real signal and deserves a delta." Provider-neutral wording ("sentinel-progress phantoms", "provider quota") so it holds for non-codex harnesses. **Highest-value fold** — without it the per-agent lane reads `cancelled` tasks as failure evidence. |
| F4 | **Hunt skills citing migrated hosts/endpoints or dead tools** (compounding 4B, rotation target 4) | ReflectionDelta contract → `skill` | "Propose an update when a skill cites a host, endpoint, or command that no longer exists: a playbook with a dead step in it is worse than no playbook." Complements the existing `invokes: 0` discoverability trigger — staleness was previously uncovered. |
| F5 | **HEARTBEAT is a runbook, not a log; >~20KB means it drifted; incident detail belongs in memory, not the runbook; lift resolved/✅ watch items** (compounding 4A) | ReflectionDelta contract → `hygiene` | "A line recording what happened belongs in a `memory`; a line telling you to do something *again* belongs here… the useful delta is a removal — not another addition." The ~20KB numeric threshold was dropped as arbitrary under per-agent `heartbeatMd` (see D-note in F5 row of Section 3 rationale). |
| F6 | **Leave-no-regrowth rule: removals need a "why" or they get re-added within a week; record a memory for any non-obvious removal** (compounding 4C) | ReflectionDelta contract → `hygiene` | "`reason` shows on today's receipt and is then gone, so pair a non-obvious removal with a `memory`… Otherwise a later dream sees the gap and regrows it. This is the one case where the same lesson legitimately belongs in two deltas." The last clause is deliberate — it reconciles with the pre-existing anti-pattern "Writing the same lesson as both a `memory` and a `profile-op`", which would otherwise contradict this rule. |
| F7 | **"Folds 1-3 grow the swarm; Fold 4 keeps it from rotting… evolution that only ever adds and never removes produces bloat that out-paces the signal" + anti-pattern "Only ADDING and never REMOVING — hygiene is half the job"** (compounding Fold 4 intro, attributed to Taras 2026-05-29) | Anti-patterns | "Only ever adding. A dream that never removes anything grows the files faster than it grows the signal." Attribution/date dropped (template ships to all installs). |
| F8 | **Anti-pattern: "Removing cruft without a 'why' comment, so the next run regrows it"** (compounding anti-patterns) | Anti-patterns | "Removing something without recording why, so the next dream puts it straight back." |

Voice/format compliance: all folds are agent-facing playbook lines, placed in existing sections, no new
H2 headings introduced (which also keeps the skill's own anchor rules honest for anyone reading it as a
worked example).

---

## Section 2 — Needs code / data / a decision (NOT hardcoded into the skill)

Ordered by risk of silent knowledge loss at cutover.

### N1. The rotating deep-clean target list has no home — and the new cursor rotates something else

Prod (compounding 4B) rotates **one deep-clean target per run** through a 5-item list:
1. agent `start-up.sh` / `setupScript`s, 2. profile files for 2-3 agents, 3. config & MCP servers,
4. skills, 5. stale memories — with the cursor in `/workspace/personal/hygiene-rotation.md`.

The new architecture *has* a rotation cursor (`kv` namespace `dreaming`, key `rotation-cursor`) but
`dream-gather.ts:245` uses it to index into **PR references scraped out of HEARTBEAT/task text**
(`prReferences[cursor % prReferences.length]`), feeding the `hygiene-snapshot` node. That is a different
axis entirely: PR-by-PR verification, not category-by-category deep cleaning.

**Recommendation (needs your call):** either (a) accept the substitution — PR-ref rotation replaces
category rotation, and targets 2/4/5 are covered opportunistically by the folded F2/F4 rules; or
(b) add a second cursor (`dreaming` / `hygiene-target-cursor`) plus a target list in the hygiene lane's
gather inputs. Note that under (b), targets 1 and 3 are still **unexpressible** as deltas (see D9/D10) —
so a category rotation would only ever land on 3 of the 5. My read: take (a), and log the gap.

### N2. Migrated-host list — install-specific data, do not ship in the template

Prod (compounding 4A): internal Dokploy hosts `agent-swarm-mcp.desplega.sh` / `agent-swarm.desplega.sh`
migrated **2026-05-15** → canonical `api.desplega.agent-swarm.dev` / `app.agent-swarm.dev`.

**Recommendation:** seed as a Lead (or swarm-wide) `TOOLS.md` line and/or a shared memory on prod
**before** the retirement migration merges; the generic hunting rule is already folded (F2).
**Flag:** `app.agent-swarm.dev` does not match the product URL I have on record for the dashboard
(`cloud.agent-swarm.dev`); the prod prompt may itself be stale here. Worth verifying before you copy it
into a profile — copying a stale host list into TOOLS.md is exactly the failure mode F2 is about.

### N3. Cross-repo open-PR digest — the largest genuine capability loss

Prod digest 1B gathers **all open PRs across 11 repos** (`desplega-ai/agent-swarm`, `-landing`,
`landing`, `landing-labs`, `qa-use`, `agent-fs`, `chat-py`, `argus`, `argus-action`, `ai-toolbox`,
`agent-work`) via the `github-list-open-prs` seed script (or a `gh pr list` loop), computes `daysOpen`,
and buckets: dependabot / security-dependabot (`critical|high|security|vulnerability`) / **stale 60+ d**
/ **aging 30-59 d** / recent — every entry rendered as a clickable `<URL|repo #NUM>`, dependabot
collapsed to a footer count except security ones.

`dream-gather` does **none** of this. It only extracts PR refs already mentioned in HEARTBEAT/task text.
After the migration, nobody produces the daily cross-repo PR review.

**Recommendation:** decide explicitly. Either add a `github-list-open-prs` call + repo list to
`dream-gather` (config-driven repo list, not hardcoded) and a PR section to `dream-receipt`, or accept
that the PR digest is retired and say so on the PR. The repo list, bucket thresholds (60/30), and the
`<url|repo #N>` link convention are the data to carry over if you keep it. **This is the item most
likely to be missed at cutover** — it is a whole deliverable, not a line of prose.

### N4. Soft-ping batching rule (added 2026-06-11) — no lane owns it

Prod digest Phase 3: if ≥3 tracked HEARTBEAT items have soft-ping triggers landing on the same day, do
**not** post separate pings — post one consolidated `:ballot_box_with_check: *Decisions needed today*`
block, one line per decision, each with its link and a **yes/no-shaped question**. "Three separate pings
in one morning is noise; one decision-list is actionable."

This is human-communication policy, not reflection evidence, so it does not belong in the skill.
**Recommendation:** move it into Lead's `CLAUDE.md` (or `dream-receipt`'s deferred-items rendering)
before the migration merges. As far as I can tell it exists *only* in this prompt.

### N5. Pool-target risk check (Lead Rule #13)

`Heartbeat Audit.poolTargetRiskSchedules` flags **pool-targeted schedules whose template does
git/docker/bun/gh/branch work**. `dream-gather` reproduces neither the check nor the flag.
**Recommendation:** if the check still matters, port it into `dream-gather` (it is a pure DB query over
`scheduled_tasks` templates) or leave it to Lead Rule #13 in the profile — but confirm the rule survives
(see N11).

### N6. Failure-cluster conventions — swarm level, not lane level

Prod uses `minClusterSize: 3` over `windowDays: 7`, clustered by `schedule:` tag (Rule #15) and by
`agentId + reason` (Rule #16). The per-agent skill correctly stays at "same failure twice in the window".
**Recommendation:** put the cluster thresholds in the **arbitration/critique lane prompt** in
`dream.ts` (Lead sees all lanes) rather than the skill; `gather-rich` already carries
`insights.compound.failureClusters` for it.

### N7. `memory-delete` by ID is the only real removal

Prod 4B target 5: "moving files on disk does **not** un-index the embeddings." Under the new
architecture the lane proposes `{kind: "memory", action: "delete", id}` and `dream-apply` performs it, so
folding this into the skill would be inert prose. **Recommendation:** keep it as an agent `TOOLS.md` /
memory fact for agents doing ad-hoc memory maintenance outside a dream.

### N8. `memory-search` indexing lag

Prod Phase 0.1: a memory written <5 min ago may not be searchable yet — confirm via `get-tasks` + the
file on disk before declaring it MISSING. Not applicable to the lane (the slice reads `agent_memory`
from the DB, not the search index), so not folded. **Recommendation:** retain as a `TOOLS.md` /
memory fact — it still bites any agent using `memory-search` interactively.

### N9. AgentMail — already covered in the skill, but verify the prod memory survives

`AGENTMAIL_API_KEY` + `api.agentmail.to`, REST-only, **no MCP**; inbound email is swarm-native
(`register-agentmail-inbox` + webhook → tasks); any `agentmail-mcp` block is dead cruft. The gotcha is
**already the canonical `memory` example** in the skill (lines ~91), so no skill edit was needed — this
row exists so it is not mistaken for a dropped item. **Recommendation:** confirm prod memory
`agentmail-is-rest-api-not-mcp-2026-05-29` still exists post-cutover; the "strip `agentmail-mcp` from
setup scripts" corollary is unexpressible as a delta (D9).

### N10. Slack identifiers

Channel `C0A4J7GB0UD` (both prompts) and ping target `<@U08NR6QD6CS>` (digest).
**Recommendation:** ensure `DREAMING_SLACK_CHANNEL` is set to `C0A4J7GB0UD` on prod before the
migration deploys, and decide whether the receipt pings the owner (the digest did; the dream receipt
currently does not, as far as this phase's scope shows).

### N11. Both prompts lean on Lead `CLAUDE.md` Rules #10/#11/#13/#15/#16/#17

The prompts *reference* these rules rather than restating them, so disabling the schedules does not
delete them — they live in Lead's profile and survive. **But Rule #17 is defined in terms of the
blocker-digest schedule** ("self-serve a lightweight prelude", digest idempotency), and Rule #11 assumes
the digest's Slack-ts verification step. **Recommendation:** read Lead's `claudeMd` on prod and
re-point (or retire) #11 and #17 in the same PR as the migration — this is also where Phase 5 step 4 of
the plan (heartbeat template + `Heartbeat Audit`'s digest-ran-today check) needs to land.

---

## Section 3 — Dropped (obsolete monolith mechanics)

| # | Dropped item | Justification |
| --- | --- | --- |
| D1 | Org identity preamble ("a real team working for Desplega Labs (desplega.ai) — the agent swarm, agent-fs, and related products") | The skill ships to every install; identity belongs in agent `SOUL`/`IDENTITY`, not a template. |
| D2 | Phase 0 gather sequence: `get-tasks completed limit=25`, `get-tasks failed limit=10`, `get-swarm`, `skill-list`, `memory-search "daily evolution"` for continuity | Mechanized wholesale by `dream-gather` + `dream-agent-slice`; the lane is handed its slice. |
| D3 | `script-run name="compound-insights" scope="global" args={"days":7}` invocation, the "args MUST be an object, never null, or argsSchema fails" gotcha, and the manual `get-tasks` fallback | `dream-gather.ts:175` makes the call with a literal object; a script-authoring gotcha, not agent-facing. |
| D4 | The `compound-insights` output tour (`taskSummary`, `failureClusters`, `scheduleHealth`, `toolUsage`, `memoryHealth` byScope/bySource, `byAgent`) and the ~25-roundtrips/~50K-context rationale | Delivered pre-shaped as `insights.compound`; the "Read your slice first" section already documents the lane's actual input contract. |
| D5 | `get-swarm includeFull:true` overflows the result cap and dumps to a file — jq the saved file per agent | The slice carries `profiles.<file>` excerpts + `h2Anchors` directly; the overflow path no longer occurs. |
| D6 | Digest-may-be-MISSING handling: shared pooled credential, quota/5xx window, "self-serve a lightweight prelude per Rule #17", `digestRanToday` idempotency guard, confirming via `get-tasks scheduleId=cdfa3f00…` | The digest is absorbed into `gather` inside the same workflow run — there is no second schedule to be missing, and no cross-schedule handoff to reconstruct. |
| D7 | Named roster "(Lead, Picateclas, Researcher, Reviewer, Tester, Jackknife)" | `dream-gather` derives the live roster from `agents WHERE status IN ('idle','busy')` and the workflow fans out one lane per agent. |
| D8 | `/workspace/personal/hygiene-rotation.md` file-based rotation cursor (read it, pick next, write it back) | Replaced by the KV cursor (`dreaming`/`rotation-cursor`) advanced by `dream-apply.ts:172-179`. |
| D9 | Rotation target 1 — clean agent `start-up.sh` / `setupScript`: dead MCP boot blocks, MCP servers installed but never enabled/permitted, inconsistent install methods, duplicated shebang/header lines | **Unexpressible:** `ReflectionDelta` has no setup-script op (`profile-op` covers SOUL/IDENTITY/CLAUDE/TOOLS/HEARTBEAT only). Genuine capability gap, logged under N1. |
| D10 | Rotation target 3 — config & MCP servers via `list-config` / `mcp-server-list` | Same: no config/MCP delta kind exists on the apply path. |
| D11 | Digest Phase 5 hand-off memory written to `/workspace/shared/memory/d454d1a5-4df9-49bd-8a89-e58d6a657dc3/` with a `daily-blocker-digest-YYYY-MM-DD.md` title | Memory writes go through the tool on the apply path; the handoff is now intra-workflow node wiring, not a file drop read by a later schedule. |
| D12 | "Add a terse *Health flags* line so the compound (5 min later) inherits them" + the whole 5-minutes-apart two-schedule choreography | One workflow, one run — `gather-rich` outputs flow to the hygiene/reflect/skills lanes as node inputs. |
| D13 | Both full Slack message templates (🧬 Daily Evolution fold-by-fold block; :clipboard: Daily Blocker Digest with STALE/AGING/Recent/security/awaiting-reply/stuck sections) | `dream-receipt.ts` owns receipt rendering; the skill's stance ("the deltas are the deliverable, the receipt is just the receipt") is already explicit. Formatting conventions worth keeping are captured in N3. |
| D14 | Phase 5 verify checklists (both prompts) and the `store-progress` completion-paragraph instruction | The lane contract is structured output validated by the workflow's `outputSchema`; the skill's "Before you submit" is the equivalent, already grounded in the delta contract. |
| D15 | `slackTsToCheck` + "Rule #11 stays Lead-side — the runtime has no Slack token" | Artifact of the retired `Heartbeat Audit` call path. (The underlying Rule #11 lives in Lead's profile — tracked in N11.) |
| D16 | Digest 1C awaiting-user-reply SQL and 1D stuck-in-flight `get-tasks status=in_progress` + >2h flag | Reproduced verbatim in `dream-gather` (`awaitingUserReply` query; `blockers` query with `-2 hours`). |
| D17 | `Heartbeat Audit` invocation, its full arg shape (`nowIso`, `windowDays`, `minClusterSize`, `defaultRepo`, `heartbeatMarkdown`, `prRefs`) and `resolvedStalePRs` consumption, plus the per-line `gh pr view` fallback | The script is retired by this cutover; `dream-gather.pullRequestsFromText` performs the PR-ref extraction and the `hygiene-snapshot` node does the per-target check. The judgment half (merged ⇒ RESOLVED-STALE) is folded as F1. |

**Also dropped from F5:** the literal "~20KB" HEARTBEAT size threshold. It was calibrated for a single
shared `/workspace/HEARTBEAT.md`; the new model is per-agent `heartbeatMd` in the DB, where 20KB is not a
meaningful line. The qualitative runbook-vs-log test was kept.

---

## Appendix — checked, confirmed already covered (not deltas)

These prod lines have real content but were already present in the repo template baseline, the new skill,
or a lane prompt, so they generated no action:

- Surgical-edit / never-template-overwrite rule (compounding 2C + 4B target 2) → skill *Anchor discipline*: "whole-file rewrites destroy accumulated evolution".
- RESOLVED-STALE post-mortem memory rule (compounding 1A) → already in the repo template **and** the skill's *What earns a delta*.
- The four per-claim verification methods (PR merge / curl the API / check the thread / check task status) → already in the repo digest template Phase 2.
- "Do NOT trust the HEARTBEAT wording" → repo digest template ("Do not trust stale notes").
- AgentMail REST-not-MCP → already the skill's worked `memory` example (see N9).
- Advance the rotation cursor so tomorrow moves on → already instructed by the hygiene lane prompt (`dream.ts:161-162`) and the skill's rotation-cursor note.
- "Completing in under 2 minutes" and "zero changes means look harder" → present in the repo template; the skill's equivalent is "Zero deltas plus a one-line reason is a legitimate outcome on a quiet day — but if you had failures in the window and propose nothing, look again."
- Fold 2D Lead self-evolution and all of Fold 3 (skill candidates/create/update/adoption) → present in the repo template baseline, already transplanted into the skill's `skill` delta section.

---

## Verification run

```
$ bun run check:skill-sources && bun run check:seed-skill-files
<output pasted below in the task report>
```
