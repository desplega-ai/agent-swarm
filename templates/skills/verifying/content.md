# Verifying

You are performing a post-implementation audit of a plan, cross-referencing it against actual changes to ensure nothing was missed, nothing is stale, and the implementation matches what was planned.

## Working Agreement

**All user-facing questions go through `AskUserQuestion`** — see `desplega:ask-user` for conventions.

**All read/research/validation work goes through sub-agents** — default to `run_in_background: true`.

File-review is on by default (unless Autopilot) — invoke it on the verification report when ready.

## When to Use

This skill activates when:
- User invokes `/verify-plan` command
- The implementing skill offers verification at completion
- User asks to audit or verify a completed plan

## Autonomy Mode

At the start of verification, adapt your interaction level based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Run all checks, update plan, report summary at end |
| **Critical** (Default) | Ask about discrepancies and blocking items |
| **Verbose** | Walk through each check, confirm interpretation |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Process Steps

### Step 1: Load Plan

Read the plan fully. If no path provided:
1. Search for plans with `status: in-progress` or `status: completed` in `thoughts/*/plans/`
2. If multiple found, use **AskUserQuestion** to let the user choose
3. If none found, report and stop

### Step 2: Checkbox Audit

Parse all `- [ ]` and `- [x]` items in the plan. Report:

| Metric | Description |
|--------|-------------|
| Total items | Count of all checkbox items |
| Checked items | Count of `- [x]` items |
| Unchecked Automated Verification | Items under `#### Automated Verification:` still unchecked |
| Unchecked Automated QA | Items under `#### Automated QA:` still unchecked |
| Unchecked Manual Verification | Items under `#### Manual Verification:` still unchecked |

Flag any Automated Verification or Automated QA items that are still unchecked — these are expected to be checked by the implementing/phase-running skills.

### Step 3: Git Diff Correlation

Check the plan's frontmatter for a `git_commit` field.

**If `git_commit` exists:**
1. Run `git diff <git_commit>..HEAD --name-only` to get changed files
2. Extract all file paths mentioned in the plan's "Changes Required" sections
3. Compare and flag:
   - **Unexpected changes**: Files changed that aren't mentioned in the plan
   - **Missing implementation**: Files mentioned in the plan that weren't changed

**If `git_commit` does not exist:**
- Skip this step with a note: "No git_commit in plan frontmatter — skipping git diff correlation"

**If on a different branch than the plan:**
- Note the branch difference and proceed with best-effort comparison

### Step 4: Scope Verification

Read the "What We're NOT Doing" section of the plan. Search the git diff for evidence of scope creep:
- Look for files or patterns related to explicitly out-of-scope items
- Check if any commits reference out-of-scope functionality

Be conservative here — flag only clear scope violations, not borderline cases.

### Step 5: Success Criteria Re-run

For each phase's Success Criteria, re-run both runnable buckets:

**Automated Verification** (commands):
1. Extract the commands from each checkbox item
2. Re-run each command
3. Report pass/fail

**Automated QA** (agent-driven scenarios):
1. For each scenario, re-execute via the appropriate tool (browser-use, screenshot diff, CLI walkthrough)
2. Report pass/fail per scenario

**Edge cases (apply to both):**
- Skip items that reference files or paths that clearly no longer exist
- If an item fails, capture the error/output for the report
- Don't re-run destructive or state-modifying items — only read-only checks
- If a phase's QA Spec links to an external QA doc, note its path in the report; re-running that doc is the qa skill's job, not this one's

**OPTIONAL SUB-SKILL:** When a verification command is missing, flaky, or so verbose that re-running it pollutes the report, invoke `desplega:script-builder` to wrap it into a re-runnable script. The generated script enforces PASS/FAIL + `/tmp` log output, so future verifications get a clean single-line result instead of a wall of stdout. The wrapped command stays in the plan; subsequent verifications discover the new script via the `<important if>` block script-builder adds to CLAUDE.md.

### Step 6: Plan Freshness Check

Compare phase descriptions against actual implementation:
- Are file paths in the plan still accurate?
- Do the "Changes Required" descriptions match what was actually done?
- Were any phases adapted significantly during implementation?

Flag phases where the description no longer matches reality as stale.

### Step 7: Verification Report

Present findings categorized as:

| Category | Meaning | Examples |
|----------|---------|----------|
| **Blocking** | Must be resolved before plan can be marked complete | Unchecked automated items, failing success criteria |
| **Warning** | Should be reviewed but don't block completion | Unexpected files changed, potential scope creep |
| **Info** | Informational, no action needed | Stale descriptions, minor mismatches, branch differences |

### Step 8: Status Update

If all blocking items are resolved:
- Offer to set plan `status: completed` in frontmatter
- Update `last_updated` and `last_updated_by` fields

If blocking items remain:
- List them clearly and suggest next steps

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

## Integration with Reviewing Skill

After verification completes, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "Verification complete. What's next?" | 1. Run QA (→ `/qa`), 2. Run review (→ `/review`), 3. Done |

## Review Integration

File-review is on by default (unless Autopilot):
- After the verification report, invoke `/file-review:file-review <plan-path>` for inline human comments
- Process feedback with the `file-review:process-review` skill
