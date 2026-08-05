# TDD Planning

You are creating implementation plans that follow a strict Test-Driven Development approach. Every implementation step follows the TDD cycle: **RED → GREEN → COMMIT/ROLLBACK**.

## Core TDD Principles

This skill enforces a disciplined TDD workflow:

1. **RED**: Write a failing test first (test must fail for the right reason)
2. **GREEN**: Write minimal code to make the test pass (nothing more)
3. **COMMIT/ROLLBACK**: If green, commit. If stuck, rollback to last green state.

**No implementation code is written without a failing test first.** This is non-negotiable.

## Working Agreement

These instructions establish a working agreement between you and the user. The key principles are:

1. **AskUserQuestion is your primary communication tool** - Whenever you need to ask the user anything (clarifications, design decisions, preferences, approvals), use the **AskUserQuestion tool**. Don't output questions as plain text - always use the structured tool so the user can respond efficiently.

2. **Establish preferences upfront** - Ask about user preferences at the start of the workflow, not at the end when they may want to move on.

3. **Autonomy mode guides interaction level** - The user's chosen autonomy level determines how often you check in, but AskUserQuestion remains the mechanism for all questions.

### User Preferences

Before starting planning (unless autonomy is Autopilot), establish these preferences:

**Commit Granularity** - Use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "How granular should commits be?" | 1. Commit after each GREEN (Recommended for strict TDD), 2. Commit after each feature/phase completes, 3. I'll handle commits manually |

**Rollback Strategy** - Use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "When a test can't be made green after reasonable effort, what's the rollback strategy?" | 1. `git checkout .` to last commit (Recommended), 2. `git stash` changes for later analysis, 3. Keep failing code, ask for guidance |

**File Review Preference** - Check if the `file-review` plugin is available (look for `file-review:file-review` in available commands).

If file-review plugin is installed, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "Would you like to use file-review for inline feedback on the plan when it's ready?" | 1. Yes, open file-review when plan is ready (Recommended), 2. No, just show me the plan |

Store these preferences and act on them during implementation.

## When to Use

This skill activates when:
- User invokes a TDD-planning command
- Another skill references `**REQUIRED SUB-SKILL:** Use desplega:tdd-planning`
- User explicitly asks for TDD-based planning
- The feature being implemented is test-critical or safety-critical

## Autonomy Mode

At the start of planning, adapt your interaction level based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Research independently, create complete TDD plan, present for final review only |
| **Critical** (Default) | Get buy-in at major decision points, validate test strategy |
| **Verbose** | Check in at each step, confirm test approach before each cycle |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Process Steps

### Step 1: Context Gathering & Test Infrastructure Analysis

1. **Read all mentioned files immediately and FULLY:**
   - Research documents, related plans, JSON/data files
   - **IMPORTANT**: Use Read tool WITHOUT limit/offset parameters
   - **CRITICAL**: Read files yourself before spawning sub-tasks

2. **Analyze test infrastructure:**
   - What testing framework is used? (Jest, pytest, Go testing, etc.)
   - Where do tests live? (co-located, `__tests__/`, `tests/`, etc.)
   - What's the test command? (`npm test`, `make test`, `pytest`, etc.)
   - Are there existing test patterns to follow?

3. **Spawn initial research tasks:**
   - Use **codebase-locator** agent to find test files and test utilities
   - Use **codebase-analyzer** agent to understand current test patterns
   - Use **codebase-pattern-finder** agent to find similar test implementations
   - Use context7 MCP for testing library insights

4. **Present understanding and questions (if not Autopilot):**

   First, present your findings as text:
   ```
   Based on the research of the codebase, I understand we need to [summary].

   Test Infrastructure:
   - Framework: [testing framework]
   - Test location: [where tests live]
   - Test command: `[command]`
   - Existing patterns: [relevant patterns found]
   ```

   Then, if there are questions, use **AskUserQuestion**.

### Step 2: Test Strategy Design

1. **Identify testable units:**
   - What are the smallest testable pieces?
   - What inputs/outputs can be verified?
   - What edge cases matter?

2. **Design test progression:**
   - Start with simplest case (happy path)
   - Progress to edge cases
   - End with error handling

3. **Present test strategy (if not Autopilot):**

   Use **AskUserQuestion** to validate approach:

   | Question | Options |
   |----------|---------|
   | "I propose starting with [simplest test case] and progressing to [more complex cases]. Does this test progression make sense?" | 1. Yes, proceed, 2. Let's discuss the order, 3. Add more test cases |

### Step 3: Plan Structure Development

1. **Create TDD cycle outline:**

   Each feature/phase is broken into TDD cycles:
   ```
   ## Feature: [Name]

   ### Cycle 1: [Simplest behavior]
   - RED: Test for [specific behavior]
   - GREEN: Implement [minimal code]
   - COMMIT: "[descriptive message]"

   ### Cycle 2: [Next behavior]
   ...
   ```

2. **Get feedback on structure** before writing details (unless Autopilot)

### Step 4: Detailed Plan Writing

Before proceeding, exit plan mode to write the plan file.

Write the plan to `thoughts/<username|shared>/plans/YYYY-MM-DD-tdd-description.md`.

**Path selection:** Use the user's name (e.g., `thoughts/taras/plans/`) if known from context. Fall back to `thoughts/shared/plans/` when unclear.

**CRITICAL**: Every TDD cycle MUST include exact test code to write and expected failure message. See template for exact format.

**QA Specs (optional)**: Features that change user-facing behavior SHOULD include an optional `### QA Spec (optional):` section at the Feature level (after the feature header, before the first TDD cycle). Unlike regular plans where QA specs attach per-phase, TDD plans attach them per-feature since the RED/GREEN cycle itself serves as the per-cycle verification. See the template for the format.

**Template:** Read and follow the template at `template.md`

### Step 5: Review and Iterate

1. **Present draft plan location:**
   ```
   I've created the TDD implementation plan at:
   `thoughts/<username|shared>/plans/YYYY-MM-DD-tdd-description.md`

   Please review it.
   ```

2. **Iterate based on feedback** (if not Autopilot)

3. **Offer structured review:**
   - After iteration, offer: "Would you like me to run `/review` on this TDD plan for completeness and gap analysis?"
   - If yes, invoke the `desplega:reviewing` skill on the plan document

4. **Learning Capture:**

   **OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

5. **Workflow handoff:**
   After the plan is finalized (and optionally reviewed), use **AskUserQuestion** with:

   | Question | Options |
   |----------|---------|
   | "The TDD plan is ready. What's the next step?" | 1. Implement this plan (→ `/implement-plan`), 2. Run a review first (→ `/review`), 3. Done for now (park the plan) |

   Based on the answer:
   - **Implement**: Suggest the `/implement-plan` command with the plan file path
   - **Review**: Invoke the `desplega:reviewing` skill on the plan document
   - **Done**: Set the plan's `status` to `ready` or `parked` as appropriate

5. **Finalize the plan** - DO NOT START implementation

## Review Integration

If the `file-review` plugin is available and the user selected "Yes" during User Preferences setup:
- After creating plans, invoke `/file-review:file-review <path>`
- If user selected "No" or autonomy mode is Autopilot, skip this step

## TDD Cycle Requirements (MANDATORY)

**Every implementation step MUST follow the TDD cycle.** Plans without proper TDD cycles are incomplete.

### Required Structure for Each Cycle

```markdown
### Cycle N: [Behavior being implemented]

#### RED Phase
**Test to write:**
```[language]
// Exact test code goes here
```

**Expected failure:**
```
[Expected error message or failure output]
```

**Verify RED:** `[test command]` should fail with the above message

#### GREEN Phase
**Implementation approach:**
[Brief description of minimal code needed]

**Files to modify:**
- `path/to/file.ext`: [what to add/change]

**Verify GREEN:** `[test command]` should now pass

#### COMMIT/ROLLBACK
**If GREEN:**
- Commit message: `"[descriptive message following conventional commits]"`
- Command: `git add -A && git commit -m "[message]"`

**If STUCK (can't reach GREEN after reasonable effort):**
- Rollback: `git checkout .` (or `git stash` based on preference)
- Reassess: Consider if the test is too big, or if design needs rethinking
```

### Validation Checklist

Before finalizing any TDD plan, verify:
- [ ] Every implementation step has RED → GREEN → COMMIT/ROLLBACK structure
- [ ] RED phase includes exact test code to write
- [ ] RED phase includes expected failure message
- [ ] GREEN phase describes minimal implementation
- [ ] Each cycle is small enough to complete in one sitting
- [ ] Cycles build on each other progressively
- [ ] Rollback strategy is clear for each cycle

## Important Guidelines

1. **Tests First, Always**: Never describe implementation without the test that drives it
2. **Minimal GREEN**: Only write enough code to pass the test, nothing more
3. **Small Cycles**: If a cycle seems big, break it into smaller cycles
4. **Progressive Complexity**: Start simple, add complexity through new tests
5. **Clear Rollback Points**: Every commit is a safe point to return to
6. **No Speculative Code**: Don't add code "because we'll need it later"
