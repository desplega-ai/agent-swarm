# Reviewing

You are performing a structured critique of a document (research, plan, or brainstorm) to identify gaps, weaknesses, and quality issues. (For reviewing a code diff, use `desplega:code-reviewing` instead — this skill reviews documents.)

## Working Agreement

**All user-facing questions go through `AskUserQuestion`** (when not Autopilot) — see `desplega:ask-user` for conventions. Never ask in chat as plain bullets.

File-review is on by default — invoke it after the automated review (skip only if Autopilot).

### Output Mode

Unless Autopilot, ask once at the start:

| Question | Options |
|----------|---------|
| "How should I present the review findings?" | 1. Append errata section to the document (Recommended), 2. Auto-apply fixes to the document, 3. Write a separate review file to thoughts/*/reviews/ |

## When to Use

This skill activates when:
- User invokes `/review` command
- Another skill references the reviewing skill at completion
- User asks to review, critique, or check a document

## Autonomy Mode

At the start of review, adapt your interaction level based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Run full review, auto-fix minor issues, present summary at end |
| **Critical** (Default) | Ask about Critical/Important findings, auto-fix Minor ones |
| **Verbose** | Walk through each finding, confirm before any changes |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Process Steps

### Step 1: Read & Classify

Read the input document fully. Determine the document type from its path and content structure:

| Path contains | Type |
|---------------|------|
| `/research/` | Research document |
| `/plans/` | Plan |
| `/brainstorms/` | Brainstorm |
| `/qa/` | QA report |

If the type is ambiguous, infer from content structure or use **AskUserQuestion** to clarify.

### Step 2: Structural Check

Verify required sections exist based on document type:

**Research documents:**
- YAML frontmatter with required fields (date, researcher, topic, status)
- Research Question section
- Summary section
- Detailed Findings with file:line references
- Code References table
- Open Questions section

**Plans:**
- YAML frontmatter with required fields (date, planner, topic, status)
- Overview with Motivation + Related links
- Current State Analysis
- Desired End State
- What We're NOT Doing
- Implementation Approach (bullet one-liners)
- Quick Verification Reference
- Phases with Changes Required and Success Criteria (all three subsections: Automated Verification, Automated QA, Manual Verification)
- QA Spec (when present) is a link to a `desplega:qa`-generated doc, not inline scenarios
- Appendix (follow-up plans, derail notes, references)

**Brainstorms:**
- YAML frontmatter with required fields (date, author, topic, status)
- Context section
- Exploration section with Q&A pairs
- Synthesis section
- Next Steps section

**QA reports:**
- YAML frontmatter with required fields (date, author, topic, status)
- Context section
- Scope section (In Scope / Out of Scope)
- Test Cases with Steps, Expected, Actual, Status per case
- Evidence section (Screenshots, Videos, Logs, or External Links)
- Verdict section with overall status and summary

### Step 3: Content Analysis

Apply type-specific quality criteria:

**Research documents:**
- Are findings supported by specific file:line references?
- Are there claims without evidence from the codebase?
- Are there obvious areas that weren't investigated?
- Are open questions actually open (not answerable from the findings)?

**Plans:**
- Are there missing phases or gaps in the implementation sequence?
- Are success criteria specific enough to be actionable?
- Are there unstated assumptions about the codebase?
- Is error handling or rollback addressed?
- Is there scope creep risk (doing more than stated)?
- Is any phase over-built? Run proposed abstractions, layers, and new dependencies against `desplega:engineering-standards` (deletion test, two-adapters rule, new-dependency test) — flag failures as Important.

**Brainstorms:**
- Were important angles left unexplored?
- Were conclusions reached prematurely before sufficient exploration?
- Are constraints and requirements clearly identified?
- Is the document ready to feed into research or planning?

**QA reports:**
- Does every test case have an actual result and status?
- Is evidence provided for failures (screenshots, logs)?
- Is the verdict consistent with individual test case results?
- Are edge cases and exploratory testing documented?
- Are external references (Sentry, PRs, CI) linked where relevant?

### Step 4: Gap Identification

Look for what's missing or assumed:
- Cross-reference claims against the codebase if needed (spawn **codebase-analyzer** agent for verification)
- Identify unstated assumptions
- Check for internal contradictions
- Verify external references are still valid

### Step 5: Present Findings

Categorize all findings into three severity levels:

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Blocks correctness or completeness — must be addressed | Discuss with user |
| **Important** | Significant gap or weakness — should be addressed | Discuss with user (or auto-fix in Autopilot) |
| **Minor** | Formatting, typos, small inconsistencies | Auto-fix unless Verbose mode |

Present a summary as text output with findings grouped by severity.

### Step 6: Apply or Discuss

Based on output mode preference:

**If "Append errata":**
- Auto-fix Minor issues directly in the document
- For Critical/Important items, append a `## Review Errata` section at the end of the document with:
  ```
  ## Review Errata

  _Reviewed: YYYY-MM-DD by [reviewer]_

  ### Critical
  - [ ] [Finding description and recommended action]

  ### Important
  - [ ] [Finding description and recommended action]

  ### Resolved
  - [x] [Minor issue] — auto-fixed
  ```

**If "Auto-apply":**
- Auto-fix Minor issues directly in the document
- Auto-fix Important issues directly in the document
- For Critical findings, use **AskUserQuestion** with:

| Question | Options |
|----------|---------|
| "There are [N] Critical findings. Would you like me to auto-apply fixes for those too?" | 1. Yes, apply Critical fixes too, 2. No, leave Critical items as errata for me to address |

- Apply Critical fixes if authorized, otherwise leave them as unchecked errata items
- Append a `## Review Errata` section summarizing all changes:
  ```
  ## Review Errata

  _Reviewed: YYYY-MM-DD by [reviewer]_

  ### Applied
  - [x] [Finding description] — auto-applied
  - [x] [Finding description] — auto-applied

  ### Remaining (if any Critical items were not auto-applied)
  - [ ] [Critical finding description and recommended action]
  ```

**If "Separate file":**
- Write review to `thoughts/*/reviews/YYYY-MM-DD-review-of-<original-slug>.md`
- Include all findings with references back to the original document

### Step 7: Workflow Handoff

After the review is complete, determine the document type (from frontmatter, file path, or content) and propose the appropriate next step.

Use **AskUserQuestion** with context-dependent options:

**If reviewing a brainstorm document:**

| Question | Options |
|----------|---------|
| "Review complete. What's next for this brainstorm?" | 1. Start research (→ `/research`), 2. Create a plan directly (→ `/create-plan`), 3. Done for now |

**If reviewing a research document:**

| Question | Options |
|----------|---------|
| "Review complete. What's next for this research?" | 1. Create a plan (→ `/create-plan`), 2. Done for now |

**If reviewing a plan document:**

| Question | Options |
|----------|---------|
| "Review complete. What's next for this plan?" | 1. Start implementation (→ `/implement-plan`), 2. Done for now |

**If reviewing a post-implementation verification:**

| Question | Options |
|----------|---------|
| "Review complete. What's next?" | 1. Done — mark as complete, 2. Address remaining items |

**If reviewing a QA report:**

| Question | Options |
|----------|---------|
| "Review complete. What's next for this QA report?" | 1. Run post-QA verification (→ `/verify-plan`), 2. Address issues found, 3. Done |

**If document type is unclear**, ask a generic question:

| Question | Options |
|----------|---------|
| "Review complete. Would you like to proceed to the next workflow step?" | 1. Yes, suggest next step, 2. Done for now |

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.

## No Rewriting Rule

**CRITICAL**: The reviewer identifies issues — the reviewer does NOT rewrite the document. Present findings and let the original author address them. Exceptions:
- Minor auto-fixes (typos, formatting) are always applied
- In **Auto-apply** mode, the reviewer applies Important and (optionally) Critical fixes directly, as authorized by the user

## Review Integration

File-review is on by default (unless Autopilot):
- After the automated review, invoke `/file-review:file-review <path>` for inline human comments
- Process feedback with the `file-review:process-review` skill
