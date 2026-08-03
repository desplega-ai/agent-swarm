# Step Running

You execute a single step of a DAG plan as an atomic background sub-agent. You work autonomously to completion and report results — you do NOT interact with the user.

This is the DAG sibling of `phase-running`. The execution model and atomicity contract are identical; the differences are:
- You receive a **step file path** (`step-<n>.md`), not a plan path + phase number.
- You **claim the step atomically** via the step's frontmatter `status` field before doing work, and release it on completion / failure. This makes the same plan dir safe to drive from multiple orchestrator instances.

## Execution Model

This skill runs inside a background `Agent` (sub-agent). v-implementing (or a user invoking `/run-step`) spawns it via the Agent tool with `run_in_background: true`.

The step agent receives:
- **Step path**: full path to `step-<n>.md`
- **Plan dir**: full path to the parent plan directory (read `root.md` from here for plan-level context)
- **Agent ID**: unique identifier for this sub-agent (e.g. orchestrator session ID + step ID + timestamp). Used for atomic claim + stale-claim detection.
- **Relevant context**: any extra context from the caller

## Concurrency: Atomic Claim

Before doing any work, claim the step:

1. Read the step file's frontmatter.
2. **If `status: done`** — report `Status: skipped` and exit. The step is already finished.
3. **If `status: claimed`** and `assignee` differs from your agent ID:
   - Fresh claim (`claimed_at` within last hour): report `Status: blocked` (reason: `claimed by <other-id>`) and exit.
   - Stale claim (>1h): proceed and overwrite — the previous worker likely died.
4. **Otherwise** (`status: ready`, or stale `claimed`): rewrite the frontmatter block in a single `Edit` so the write is atomic-enough for filesystem-based coordination. Set:
   - `status: claimed`
   - `assignee: <your-agent-id>`
   - `claimed_at: <ISO timestamp UTC>`
5. Re-read the file. If `assignee` is not yours, another worker raced you — report `Status: blocked` (reason: `lost claim race`) and exit.

On terminal transitions, set frontmatter:
- **Completed**: `status: done`, clear `assignee` and `claimed_at`.
- **Blocked or failed (retry-able)**: `status: ready`, clear `assignee` and `claimed_at`. The orchestrator (or another worker) can retry.
- **Failed (non-retry-able)**: leave `status: claimed` so the orchestrator can investigate; include the reason in the report.

For true cross-machine atomicity (NFS, etc.), the caller is responsible for rendezvous (e.g. a shared lock service). The single-Edit pattern is good-enough for local filesystem and well-behaved network filesystems.

## Autonomy

Step agents always run as **Autopilot** within the sub-agent. The calling context controls outer autonomy and human checkpoints.

**CRITICAL**: Step agents do NOT use AskUserQuestion. If something is ambiguous, report `Status: blocked` with details. The caller handles all user interaction.

## Process Steps

### Step 1: Load Context

1. **Claim the step** (see "Concurrency: Atomic Claim"). Stop here on any non-claim outcome.
2. Read the full step file.
3. Read `root.md` from the plan dir for plan-level context: Overview, Current State, Desired End State, Implementation Approach, Global Verification.
4. Read all files mentioned in the step's "Changes Required" section.

### Step 2: Pre-flight Check

| Check | Action if failed |
|-------|-----------------|
| All `depends_on` steps have `status: done` | Scheduler bug — release claim, report `blocked` |
| No merge conflicts in target files | Release claim, report `blocked` |
| Files/dirs from depended-on steps exist | Release claim, report `blocked` |

### Step 3: Execute Step

Implement the changes described in the step's "Changes Required" section. Adapt to minor mismatches; report `blocked` for significant ones.

### Step 4: Run Verification

Same three-bucket pattern as `phase-running`:
1. **Automated Verification** (runnable commands): run each, record pass/fail. On failure, attempt one fix-and-retry.
2. **Automated QA** (agent-driven scenarios — browser-use, screenshot diff, CLI walkthrough): execute, record pass/fail per item.
3. **Manual Verification**: leave unchecked. Caller handles with the user.
4. **QA Spec (linked doc)**: if present, report `QA Doc: <path>`. Do not execute scenarios inline.

### Step 5: Update Step File

- Check off (`- [x]`) Automated Verification + Automated QA items that passed.
- Do NOT check off Manual Verification items.
- Update frontmatter `status` per "Concurrency: Atomic Claim" terminal-transition rules.
- Update `last_updated` / `last_updated_by` frontmatter fields if present.

### Step 6: Report Results

**Completed:**
```
Status: completed
Step: step-N - <Name>
Final frontmatter status: done
Files changed: [list]
Automated Verification: N/M passed
- [x] [Check 1] — passed
Automated QA: N/M passed
- [x] [Scenario 1] — passed
QA Doc: <path> | n/a
Manual verification needed:
- [ ] [Manual check 1]
```

**Blocked / failed:** mirror `phase-running`'s shape, plus a `Final frontmatter status:` line so the orchestrator knows whether the step is released for retry (`ready`) or held for investigation (`claimed`).

## Atomicity Contract

- No interactive questions.
- No partial states left unexplained.
- Frontmatter `status` always reflects the final state at exit.
- Report includes enough detail for the caller to decide next steps.

## Context Handoff Pattern

| Direction | Data |
|-----------|------|
| **Caller → Step Agent** | Step path + plan dir + agent ID + autonomy mode |
| **Step Agent reads** | Step file + root.md + files in Changes Required |
| **Step Agent writes** | Frontmatter status transitions + checkboxes + code changes |
| **Step Agent → Caller** | Status + changed files + verification results + final frontmatter status |
| **Caller handles** | Manual verification, cross-step coordination, QA doc execution, human checkpoints |
