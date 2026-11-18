# Implementing

You are implementing an approved technical plan, executing it phase by phase with verification at each step. Each phase is executed as a background sub-agent via `desplega:phase-running` — the main session acts as an orchestrator.

## Working Agreement

**All user-facing questions go through `AskUserQuestion`** — see `desplega:ask-user` for conventions. Never ask in chat as plain bullets.

**All read/research/validation work goes through sub-agents** — keep raw tool output out of the main session. Default to `run_in_background: true`.

The autonomy mode (below) controls how often you check in. AskUserQuestion is always the mechanism.

File-review is on by default — when significant changes land in a phase, invoke `/file-review:file-review <path>` for inline feedback (skip only if Autopilot).

## When to Use

This skill activates when:
- User invokes `/implement-plan` command
- Another skill references `**REQUIRED SUB-SKILL:** Use desplega:implementing`
- User asks to execute or implement an existing plan

## Autonomy Mode

Adapt your behavior based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Execute all phases, pause only for manual verification or blockers |
| **Critical** (Default) | Pause between phases for approval, ask when mismatches found |
| **Verbose** | Check in frequently, confirm before each major change |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Initial Setup Questions

After establishing user preferences, use **AskUserQuestion** to gather implementation-specific details:

### 1. Branch/Worktree Setup

First, check the current branch: `git branch --show-current`

Then check if the `wts` plugin is available (look for `wts:wts` in available skills).

**If wts plugin is installed**, use **AskUserQuestion** with these options:

| Question | Options |
|----------|---------|
| "You're currently on branch `<current-branch>`. Where would you like to implement?" | 1. Continue on current branch, 2. Create a new branch, 3. Create a wts worktree |

**If wts plugin is NOT installed**, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "You're currently on branch `<current-branch>`. Where would you like to implement?" | 1. Continue on current branch, 2. Create a new branch |

### 2. Commit Strategy

Use **AskUserQuestion** with these options:

| Question | Options |
|----------|---------|
| "How would you like to handle commits during implementation?" | 1. Commit after each phase (Recommended for complex plans), 2. Commit at the end (Single commit for all changes), 3. Let me decide as I go |

If "Commit after each phase" is selected:
- After completing each phase's verification, create a commit with message: `[Phase N] <phase name>`
- Use the plan's phase descriptions for commit messages

### 3. Code Review Mode

Use **AskUserQuestion** with these options:

| Question | Options |
|----------|---------|
| "Run an automatic code review after each phase?" | 1. Automatic two-axis review per phase (Recommended), 2. Only at the end (single review before completion), 3. Off — I'll review myself |

In **Autopilot**, skip the question and default to automatic per-phase review.

Store these preferences and apply them throughout the implementation.

## Prior Learning Recall

**OPTIONAL SUB-SKILL:** If `~/.agentic-learnings.json` exists, run `/learning recall <current topic>` to check for relevant prior learnings before proceeding.

## Getting Started

When given a plan path:
1. Read the plan completely
2. Check for existing checkmarks (`- [x]`)
3. Set plan status to `status: in-progress` by editing the frontmatter `status` field. This signals to progress-tracking hooks which plan is active.
4. **Read files fully** - never use limit/offset parameters
5. Think deeply about how the pieces fit together
6. Create a todo list to track progress
7. Start implementing if you understand what needs to be done

If no plan path provided, ask for one.

## Implementation Philosophy

Plans are carefully designed, but reality can be messy. Your job is to:
- Follow the plan's intent while adapting to what you find
- Implement each phase fully before moving to the next
- Verify your work makes sense in the broader codebase context
- Update checkboxes in the plan as you complete sections

When things don't match the plan exactly, think about why and communicate clearly.

## Handling Mismatches

If you encounter a mismatch (and autonomy mode is not Autopilot):
- STOP and think deeply about why the plan can't be followed
- Use **AskUserQuestion** to present the issue and get direction:

| Question | Options |
|----------|---------|
| "Issue in Phase [N]: Expected [what the plan says], Found [actual situation]. Why this matters: [explanation]. How should I proceed?" | 1. Adapt plan to match reality, 2. Proceed as originally planned, 3. Stop and discuss |

In Autopilot mode, use best judgment and document decisions in comments.

## Verification Approach

Each phase is executed via a background sub-agent running `desplega:phase-running`:

1. **Read the phase overview** in the main session (minimal context usage)
2. **Spawn a `desplega:phase-running` agent** in background with plan path + phase number:
   - Use the Agent tool with `run_in_background: true`
   - Pass the plan path and phase number as context
3. **Wait for agent completion** — you'll be notified when it finishes
4. **Review the agent's report** — check status (completed/blocked/failed), changed files, verification results
5. **Check QA Doc status** — if the phase agent reports `QA Doc: <path>`, the linked QA doc has scenarios that need execution. Invoke `desplega:qa` against the QA doc path. (For `QA: n/a`, proceed normally.) Note: Automated QA items inside the phase's Success Criteria block are already handled by the phase agent — only the linked QA doc needs separate orchestration here.
6. **Run the per-phase code review** (unless review mode is Off) — invoke `desplega:code-reviewing` on the phase's diff: Standards + Spec axes as parallel background sub-agents (routed per `desplega:delegate-work`), spec source = the phase body and Success Criteria. Critical findings block the phase from closing — fix and re-verify before the commit. If "Only at the end" was selected, run one review over the full diff before Completing Implementation instead.
7. **Handle manual verification** with the user — present the manual verification items from the phase
8. **Proceed to next phase** after user confirms

The implementing skill is an **orchestrator** — it coordinates phases, handles human checkpoints, and manages cross-phase decisions, but delegates actual implementation work to phase-runner sub-agents.

**Executor routing**: if the `desplega:delegate-work` skill is available, pick each phase's executor per its routing matrix instead of defaulting to a `phase-running` sub-agent — a phase may route to a Codex variant or a specific Claude model tier. Only the executor choice changes; everything else here (autonomy modes, checkpoints, plan bookkeeping, verification, commit strategy) stays unchanged.

### Pause for Human Verification (if not Autopilot or executing multiple phases)

```
Phase [N] Complete - Ready for Manual Verification

Automated verification passed:
- [List automated checks that passed]

Please perform the manual verification steps listed in the plan:
- [List manual verification items from the plan]

Let me know when manual testing is complete so I can proceed to Phase [N+1].
```

If instructed to execute multiple phases consecutively, skip the pause until the last phase.

Do not check off manual testing items until confirmed by the user.

## If You Get Stuck

When something isn't working as expected:
1. Make sure you've read and understood all relevant code
2. Consider if the codebase has evolved since the plan was written
3. Present the mismatch clearly and ask for guidance (unless Autopilot)
4. Use sub-tasks sparingly for targeted debugging

## Resuming Work

If the plan has existing checkmarks:
- Trust that completed work is done
- Pick up from the first unchecked item
- Verify previous work only if something seems off

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

## Completing Implementation

When all phases are complete and verified:
1. Set the plan frontmatter `status` field to `completed`.
2. Ensure automated verification checkboxes are updated.
3. Leave manual verification checkboxes unchecked until the user confirms completion.
4. Offer post-implementation auditing: "Would you like me to run `/verify-plan` for a post-implementation audit, then `/review` for a final quality check?"
5. If the work ships as a GitHub PR: once review comments land, address them with `desplega:tackle-gh-comments` (fetch threads, verify each claim, fix, reply, resolve — push last).

Remember: You're implementing a solution, not just checking boxes. Keep the end goal in mind.

## Review Integration

File-review is on by default (unless Autopilot):
- After significant code changes in each phase, invoke `/file-review:file-review <changed-file-path>` for inline human comments
- Process feedback with the `file-review:process-review` skill before moving to the next phase
