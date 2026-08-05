---
id: step-N
name: [Step Name]
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-N: [Step Name]

## Overview
[What this step accomplishes as a vertical slice. One paragraph.]

## Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

#### 2. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*
- [ ] Tests pass: `bun test path/to/this/slice`
- [ ] Linting passes: `bun run lint`
- [ ] Typecheck passes: `bun run typecheck`

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it. Browser-use, screenshot diff, CLI walkthrough, etc.)*
- [ ] [Scenario the agent verifies end-to-end for this slice]

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*
- [ ] [Human-only step]

**Implementation Note**: This step is a vertical slice — QA-able on its own. After completing this step, pause for manual confirmation. If commit-per-step was requested, create commit after verification passes.

### QA Spec (optional):

For steps warranting a *separate* QA report (cross-cutting, evidence-heavy, end-of-feature) — not just per-step checks. The inline Automated QA bucket above already covers per-step agent verification.

**QA Doc**: `thoughts/<username|shared>/qa/YYYY-MM-DD-[feature].md` (generate via `desplega:qa`; scenarios live in the doc, not here).
