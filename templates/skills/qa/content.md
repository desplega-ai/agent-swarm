# QA

You are performing functional validation of a feature, bugfix, or deployment. Your job is to prove it works (or doesn't) by executing test scenarios and capturing evidence.

## Working Agreement

**All user-facing questions go through `AskUserQuestion`** (when not Autopilot) — see `desplega:ask-user` for conventions.

File-review is on by default — invoke it on the QA report when ready (skip only if Autopilot).

## Ownership: QA Doc Lives Here, Not in Plans

QA test cases live in QA docs (`thoughts/<username|shared>/qa/YYYY-MM-DD-<feature>.md`), **not inline in plans**. When a plan has a `### QA Spec (optional):` block, that block links to a QA doc this skill produces.

**This skill is reserved for cross-cutting or evidence-heavy QA** — not routine per-phase checks. Routine per-phase agent verification belongs in the plan's inline `#### Automated QA:` bucket, executed by phase-running. Use this skill when:
- The QA work spans multiple phases or the whole feature
- Evidence (screenshots, recordings, logs) needs to live somewhere durable
- A formal verdict (pass/fail/blocked) is required

Invocation paths:
- **Planning Step 3** ("Generate QA docs") calls this skill *before* handoff, for any phase whose QA needs a separate doc.
- **Implementing / phase-running** call this skill at phase-completion if the phase reports `QA Doc: <path>`.
- **Direct user invocation** (`/qa`) creates a standalone doc not linked to a plan.

### QA Approach

Unless Autopilot, ask once at the start:

| Question | Options |
|----------|---------|
| "How would you like to execute test cases?" | 1. Browser automation (qa-use) — if available, 2. Manual testing with guided steps, 3. Mixed — automate what we can, manual for the rest |

**Note on qa-use availability**: Check if `qa-use` is available (look for `qa-use:*` in available skills). Also check if the project's `CLAUDE.md` specifies a different testing tool. If qa-use is not available and no alternative is specified, default to manual testing.

## When to Use

This skill activates when:
- User invokes `/qa` command
- Another skill references `desplega:qa`
- User asks to test, validate, or QA a feature
- The implementing skill encounters a phase with a QA spec

## Autonomy Mode

At the start of QA, adapt your interaction level based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Execute all test cases, capture evidence, present summary at end |
| **Critical** (Default) | Ask about test case design, present results for review |
| **Verbose** | Walk through each test case, confirm before executing |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Process Steps

### Step 1: Context & Scope

Determine the source of QA specs:

**Plan-driven (called from planning/implementing/phase-running)** → A plan path + phase reference is supplied. Read the relevant phase, design test cases for the deliverable named in its Overview, and produce the QA doc the plan's QA Spec block will link to.

**Separate QA spec document provided** → Read the standalone spec, use it as the basis for the QA session.

**Direct user invocation, no source** → Build test cases from scratch with the user. Use **AskUserQuestion** to establish:

| Question | Options |
|----------|---------|
| "What are we validating? Please describe the feature or provide context." | [Free text response] |

In all cases, create the QA document from `template.md` at `thoughts/<username|shared>/qa/YYYY-MM-DD-<topic>.md`. Use the user's name when known; fall back to `thoughts/shared/qa/`.

**For plan-driven invocation**: after the doc exists, update the plan's `### QA Spec (optional):` block in the relevant phase to point at the doc path. Do not inline scenarios in the plan.

### Step 2: Test Case Design

Define test cases covering:
- **Happy path** — The main scenario works as intended
- **Edge cases** — Boundary conditions, empty inputs, large inputs
- **Error scenarios** — Invalid inputs, permission failures, network errors

**If sourced from a plan**: Aggregate phase QA specs into the test case list. Augment with additional exploratory cases.

**If sourced from a separate spec**: Use those scenarios as the starting point and augment with exploratory cases.

**If browser automation was selected and qa-use is available**: Design qa-use test steps for each test case (explore → snapshot → interact → screenshot).

Write all test cases into the QA document's `## Test Cases` section.

### Step 3: Execute Tests

**For browser automation (qa-use)**:
1. Use `qa-use:explore` to navigate to the target page
2. Take snapshots to understand page state
3. Interact with elements (click, type, navigate)
4. Capture screenshots as evidence

**For manual testing**:
1. Present each test case's steps to the user
2. Guide them through execution
3. Use **AskUserQuestion** to collect results:

| Question | Options |
|----------|---------|
| "TC-N: [Test case name]. Did it pass?" | 1. Pass, 2. Fail — [describe what happened], 3. Blocked — [describe blocker], 4. Skipped |

**For CLI verification**:
1. Execute the CLI commands directly
2. Compare output against expected results
3. Record pass/fail automatically

**OPTIONAL SUB-SKILL:** When a CLI test case needs the same multi-step probe re-run later (regression coverage, post-deploy smoke, multi-environment validation) and no existing script captures it, invoke `desplega:script-builder` inline. The generated script is committed to the project's `scripts/` directory with the PASS/FAIL + `/tmp` log convention; this QA session uses it for the current run, and future QA/verifying sessions discover it via the auto-added `<important if>` block in CLAUDE.md.

For each test case, record the actual result and pass/fail status.

### Step 4: Capture Evidence

Gather evidence for the QA report:
- **Screenshots**: Via qa-use browser screenshots or user-provided
- **Videos**: Session recording URLs (Loom, etc.)
- **Logs**: Console output, error messages, relevant log lines
- **External links**: Sentry issues, CI/CD runs, Grafana dashboards, PR URLs

Add all evidence to the QA document's `## Evidence` section.

### Step 5: Record Results

Update the QA document with:
- Actual results for each test case
- Pass/fail/blocked/skipped status per test case
- Evidence links inline with relevant test cases
- Any issues found in the `## Issues Found` section with severity tags (critical/major/minor)

### Step 6: Verdict

Aggregate results into an overall verdict:

| Verdict | When |
|---------|------|
| **PASS** | All test cases pass, no critical/major issues |
| **FAIL** | Any test case fails, or critical/major issues found |
| **BLOCKED** | Cannot complete testing due to environment/dependency issues |

Write a 1-2 sentence summary in the QA document's `## Verdict` section. Update the frontmatter `status` field to match (pass/fail/blocked).

### Step 7: Persist QA Knowledge

If the project's `CLAUDE.md` or `agents.md` doesn't document how QA is done for this project, offer to add a QA section describing:
- Testing approach used (manual, browser automation, CLI)
- Tools used (qa-use, Playwright, etc.)
- Common test patterns discovered

Use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "This project doesn't have documented QA practices. Would you like me to add a QA section to CLAUDE.md?" | 1. Yes, add QA documentation, 2. No, skip this |

Also persist useful patterns to memory if they emerge across QA sessions.

## Review Integration

File-review is on by default (unless Autopilot):
- After the QA report is complete, invoke `/file-review:file-review <qa-report-path>` for inline human comments
- Process feedback with the `file-review:process-review` skill

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

## Workflow Handoff

After the QA report is complete, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "QA complete. What's next?" | 1. Run post-QA verification (→ `/verify-plan`), 2. Run review on QA report (→ `/review`), 3. Done |

Based on the answer:
- **Verify**: Invoke the `desplega:verifying` skill
- **Review**: Invoke the `desplega:reviewing` skill on the QA document
- **Done**: Finalize the QA report
