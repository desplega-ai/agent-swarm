# [Feature/Task Name] Implementation Plan

## Overview

Brief description (1–3 sentences): what we're doing and why.

- **Motivation**: [driving constraint, incident, ticket, or stakeholder ask]
- **Related**: [`path/to/file.ext`, issue/PR link, `thoughts/<username>/research/[relevant].md`]

## Current State Analysis

[What exists now, what's missing, key constraints — include `file:line` references for anything load-bearing.]

## Desired End State

[Specification of the desired end state and how to verify it.]

## What We're NOT Doing

[Explicitly out-of-scope items.]

## Implementation Approach

- [Strategy bullet 1 — one-liner]
- [Strategy bullet 2 — one-liner]
- [Sequencing decision or trade-off made]

## Quick Verification Reference

Common commands to verify the implementation locally:
- [Primary test command, e.g. `make test` / `npm test`]
- [Linting command, e.g. `make lint` / `npm run lint`]
- [Build command if applicable]

---

## Phase 1: [Descriptive Name]

### Overview

[1–2 sentences: the concrete deliverable produced by this phase.]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

### Success Criteria:

*(Push everything you can into the first two buckets — Automated Verification + Automated QA — so the agent provides proof of work. Manual Verification is the exception, not the default.)*

#### Automated Verification:
*(Low-level: runnable commands. Tests, lint, type-check, build.)*
- [ ] Tests pass: `make test`
- [ ] Linting passes: `make lint`
- [ ] [Other automated check]: `command here`

#### Automated QA:
*(Agent-driven proof of work: same job a human QA would do, but the agent does it. Browser-use, screenshot diff, CLI walkthrough, etc.)*
- [ ] [Scenario the agent verifies end-to-end]

#### Manual Verification:
*(Only what truly needs a human — visual judgment, real-device perf, things the agent genuinely cannot reach.)*
- [ ] [Human-only step]

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

### QA Spec (optional):

For phases warranting a *separate* QA report (cross-cutting, evidence-heavy, end-of-feature) — not just per-phase checks. The inline Automated QA bucket above already covers per-phase agent verification.

**QA Doc**: `thoughts/<username|shared>/qa/YYYY-MM-DD-[feature].md` (generate via `desplega:qa`; scenarios live in the doc, not here).

---

## Phase 2: [Descriptive Name]

### Overview

[1–2 sentences: the concrete deliverable produced by this phase.]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

### Success Criteria:

#### Automated Verification:
- [ ] Tests pass: `make test`
- [ ] Linting passes: `make lint`

#### Automated QA:
- [ ] [Scenario Claude can verify]

#### Manual Verification:
- [ ] [Human-only step]

**Implementation Note**: After this phase, pause for manual confirmation.

---

## Appendix

- **Follow-up plans**: [links to follow-on plans, if this is part of a larger effort]
- **Derail notes**: [things noticed during planning but out of scope — capture so they're not lost]
- **References**:
  - Research: `thoughts/<username|shared>/research/[relevant].md`
  - [Other links: issues, PRs, ADRs, external docs]
