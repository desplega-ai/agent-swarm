---
date: 2026-01-30
author: Claude (Researcher Agent)
status: ready
tags: [pr-review, code-review, memory-system, multi-agent, quality-improvements]
related_research: /workspace/shared/thoughts/16990304-76e4-4017-b991-f3e37b34cf73/research/2026-01-29-pr-review-quality-improvements.md
---

# PR Review Quality Improvements - Implementation Plan

**Date**: 2026-01-30
**Status**: Ready for Review

## Overview

Implement comprehensive improvements to the PR review system based on research of Claude official plugins, memory system design, and best practices for thorough code review. This plan addresses the identified gaps: no memory system, no inline comments, single-agent review, no confidence scoring, no CLAUDE.md auto-loading, and no reply threading.

## Current State Analysis

The current `review-pr` skill:
- Parses PR number/URL and clones repo locally
- Fetches PR details via `gh pr view` and `gh pr diff`
- Analyzes for security, logic, performance, quality, tests
- Provides structured markdown feedback
- Posts via `gh pr review --body` (summary comments only)

### Identified Gaps (from Research):

1. **No inline comments** - Only posts summary comments
2. **No memory** - Each review starts fresh, no learning
3. **Single-agent** - No specialized parallel reviewers
4. **No confidence scoring** - Can't filter low-confidence issues
5. **No CLAUDE.md auto-loading** - Doesn't check repo guidelines
6. **No reply threading** - Can't respond to author replies

## Desired End State

A robust PR review system that:
1. Posts inline comments on specific code lines via GitHub API
2. Maintains persistent memory across reviews (global, per-repo, per-PR)
3. Uses multi-agent architecture with specialized reviewers
4. Filters issues using confidence scoring (0-100 scale)
5. Auto-loads and enforces CLAUDE.md guidelines
6. Tracks conversation threads and responds contextually

## Quick Verification Reference

Common commands to verify the implementation:
- `bun run lint` - Linting
- `bun run typecheck` - Type checking
- `bun test` - Run tests
- `bun run build` - Build

Key files to check:
- `skills/review-pr.md` - PR review skill definition
- `src/be/db.ts` - Database schema
- `src/types.ts` - Type definitions
- `src/tools/pr-review/*.ts` - PR review tools (to be created)

## What We're NOT Doing

- **Installing third-party plugins**: Not using external Claude plugins (building native)
- **Full PR review toolkit rewrite**: Incremental improvement, not replacement
- **Complex ML-based learning**: Confidence scoring is rule-based, not ML
- **Cross-repository learning**: Scope limited to per-repo memory (cross-repo is future work)
- **GitHub MCP Server integration**: Using `gh` CLI, not MCP server for inline comments

## Implementation Approach

Phased rollout with incremental value delivery:
1. **Phase 1**: Quick wins (inline comments, CLAUDE.md, confidence scoring)
2. **Phase 2**: Memory system (SQLite persistence layer)
3. **Phase 3**: Multi-agent architecture (parallel specialized reviewers)
4. **Phase 4**: Learning & intelligence (feedback loop, threshold tuning)

---

## Phase 1: Quick Wins

### Overview
Deliver immediate improvements to review quality with minimal infrastructure changes.

### Changes Required:

#### 1.1 Auto-Load CLAUDE.md Before Reviews

**File**: `skills/review-pr.md`
**Location**: Add to review workflow steps

**Implementation**:
```bash
# Fetch CLAUDE.md from repo before review
CLAUDE_MD=""
if gh api "repos/{owner}/{repo}/contents/CLAUDE.md" --jq '.content' 2>/dev/null; then
  CLAUDE_MD=$(gh api "repos/{owner}/{repo}/contents/CLAUDE.md" --jq '.content' | base64 -d)
fi

# Also check for .claude/CLAUDE.md
if [ -z "$CLAUDE_MD" ]; then
  CLAUDE_MD=$(gh api "repos/{owner}/{repo}/contents/.claude/CLAUDE.md" --jq '.content' 2>/dev/null | base64 -d || echo "")
fi
```

**Behavior Changes**:
- CLAUDE.md content included in review context
- Violations of CLAUDE.md rules flagged with higher confidence
- Review summary notes which CLAUDE.md rules were checked

**Verification**:
- [ ] Review on repo with CLAUDE.md shows rule enforcement
- [ ] Review on repo without CLAUDE.md works normally
- [ ] Handles .claude/CLAUDE.md path variant

---

#### 1.2 Implement Confidence Scoring

**File**: `skills/review-pr.md`
**Location**: Issue analysis section

**Confidence Scale** (from Claude official plugins):
| Score | Meaning | Action |
|-------|---------|--------|
| 0-25 | False positive / Might be real | Filter out by default |
| 26-50 | Real but minor | Optional inclusion |
| 51-75 | Real and important | Include in review |
| 76-100 | Absolutely certain | Always include |

**Implementation**:
- Each identified issue assigned a confidence score
- Default threshold: 75 (configurable via environment)
- Issues below threshold noted but not posted
- Summary includes count of filtered low-confidence issues

**Output Format Changes**:
```markdown
## Issues (12 total, 8 high-confidence)

### Critical (Confidence: 95)
- **Line 42**: SQL injection vulnerability - user input not sanitized

### High (Confidence: 85)
- **Line 87**: Potential null pointer - missing null check

---
*4 low-confidence issues (< 75) filtered. Set `REVIEW_CONFIDENCE_THRESHOLD=50` to include.*
```

**Verification**:
- [ ] Issues include confidence scores
- [ ] Low-confidence issues filtered by default
- [ ] Threshold configurable via environment variable

---

#### 1.3 Implement Inline Comments via GitHub API

**File**: `skills/review-pr.md`
**Location**: Comment posting section

**Current Behavior**: Single `gh pr review --body "..."`

**New Behavior**: Use GitHub PR Review API for inline comments

**Implementation**:
```bash
# Create review with inline comments
gh api "repos/{owner}/{repo}/pulls/{pr_number}/reviews" \
  -X POST \
  -f body="$SUMMARY_COMMENT" \
  -f event="COMMENT" \
  -f comments="$INLINE_COMMENTS_JSON"
```

**Inline Comment JSON Format**:
```json
[
  {
    "path": "src/api/handler.ts",
    "line": 42,
    "body": "**[Critical - Confidence: 95]** SQL injection vulnerability..."
  },
  {
    "path": "src/utils/validate.ts",
    "line": 87,
    "body": "**[High - Confidence: 85]** Potential null pointer..."
  }
]
```

**Fallback**: If inline comment API fails, fall back to summary comment with line links

**Verification**:
- [ ] Inline comments appear on correct lines in GitHub UI
- [ ] Summary comment still posted with overview
- [ ] Fallback works when API rate limited

---

### Phase 1 Verification Checklist

- [ ] CLAUDE.md auto-loading works
- [ ] Confidence scores appear in output
- [ ] Inline comments posted to GitHub
- [ ] Existing review flow not broken
- [ ] All tests pass

---

## Phase 2: Memory System

### Overview
Implement persistent memory layer using SQLite to maintain review context across sessions.

### Database Schema

**File**: `src/be/db.ts`
**Location**: After existing tables

#### 2.1 Global Memory Table

```sql
CREATE TABLE IF NOT EXISTS pr_review_global_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  preferences JSON NOT NULL DEFAULT '{}',
  -- preferences: { confidence_threshold: 75, focus_areas: ["security", "performance"], ... }
  patterns JSON NOT NULL DEFAULT '[]',
  -- patterns: [{ type: "common_issue", pattern: "missing null check", count: 15 }, ...]
  statistics JSON NOT NULL DEFAULT '{}',
  -- statistics: { total_reviews: 42, avg_issues_per_pr: 3.2, approval_rate: 0.85 }
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pr_review_global_user ON pr_review_global_memory(user_id);
```

#### 2.2 Per-Repo Memory Table

```sql
CREATE TABLE IF NOT EXISTS pr_review_repo_memory (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL UNIQUE,
  -- repo_full_name: "owner/repo"
  claude_md TEXT,
  -- Raw CLAUDE.md content
  claude_md_rules JSON DEFAULT '[]',
  -- Parsed rules: [{ rule: "Use TypeScript strict mode", category: "style" }, ...]
  architecture JSON DEFAULT '{}',
  -- architecture: { modules: [...], services: [...], dependencies: [...] }
  conventions JSON DEFAULT '{}',
  -- conventions: { naming: "camelCase", test_pattern: "*.test.ts", ... }
  hot_files JSON DEFAULT '[]',
  -- hot_files: [{ path: "src/api/handler.ts", issue_count: 8, last_review: "2026-01-30" }, ...]
  review_history JSON DEFAULT '[]',
  -- review_history: [{ pr: 123, date: "2026-01-29", issues: 5, approved: true }, ...]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pr_review_repo_name ON pr_review_repo_memory(repo_full_name);
```

#### 2.3 PR Interaction Memory Table

```sql
CREATE TABLE IF NOT EXISTS pr_review_interaction_memory (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  overall_state TEXT NOT NULL DEFAULT 'open' CHECK(overall_state IN ('open', 'addressed', 'resolved', 'closed')),
  review_count INTEGER NOT NULL DEFAULT 0,
  iterations JSON NOT NULL DEFAULT '[]',
  -- iterations: [{ date: "2026-01-30", issues: 5, resolved: 2 }, ...]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_review_interaction_repo ON pr_review_interaction_memory(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_pr_review_interaction_pr ON pr_review_interaction_memory(repo_full_name, pr_number);
```

#### 2.4 Review Thread Table

```sql
CREATE TABLE IF NOT EXISTS pr_review_threads (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES pr_review_interaction_memory(id) ON DELETE CASCADE,
  github_comment_id TEXT,
  -- GitHub comment ID for API updates
  file_path TEXT NOT NULL,
  line_number INTEGER,
  original_comment TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open', 'pending_response', 'addressed', 'resolved', 'wont_fix')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('critical', 'high', 'medium', 'low', 'nit')),
  confidence INTEGER NOT NULL DEFAULT 75,
  conversation JSON NOT NULL DEFAULT '[]',
  -- conversation: [{ role: "reviewer", message: "...", timestamp: "..." }, ...]
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pr_review_threads_interaction ON pr_review_threads(interaction_id);
CREATE INDEX IF NOT EXISTS idx_pr_review_threads_state ON pr_review_threads(state);
```

---

#### 2.5 Database Functions

**File**: `src/be/db.ts`
**Location**: After existing functions

```typescript
// PR Review Memory Functions

export function getOrCreateGlobalMemory(userId: string): PRReviewGlobalMemory {
  const existing = db.prepare(
    `SELECT * FROM pr_review_global_memory WHERE user_id = ?`
  ).get(userId);

  if (existing) return existing;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pr_review_global_memory (id, user_id)
    VALUES (?, ?)
  `).run(id, userId);

  return getOrCreateGlobalMemory(userId);
}

export function getOrCreateRepoMemory(repoFullName: string): PRReviewRepoMemory {
  const existing = db.prepare(
    `SELECT * FROM pr_review_repo_memory WHERE repo_full_name = ?`
  ).get(repoFullName);

  if (existing) return existing;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pr_review_repo_memory (id, repo_full_name)
    VALUES (?, ?)
  `).run(id, repoFullName);

  return getOrCreateRepoMemory(repoFullName);
}

export function getOrCreateInteractionMemory(
  repoFullName: string,
  prNumber: number
): PRReviewInteractionMemory {
  const existing = db.prepare(
    `SELECT * FROM pr_review_interaction_memory
     WHERE repo_full_name = ? AND pr_number = ?`
  ).get(repoFullName, prNumber);

  if (existing) return existing;

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pr_review_interaction_memory (id, repo_full_name, pr_number)
    VALUES (?, ?, ?)
  `).run(id, repoFullName, prNumber);

  return getOrCreateInteractionMemory(repoFullName, prNumber);
}

export function updateRepoMemoryCLAUDEmd(
  repoFullName: string,
  claudeMd: string,
  claudeMdRules: object[]
): void {
  db.prepare(`
    UPDATE pr_review_repo_memory
    SET claude_md = ?, claude_md_rules = ?, updated_at = ?
    WHERE repo_full_name = ?
  `).run(claudeMd, JSON.stringify(claudeMdRules), new Date().toISOString(), repoFullName);
}

export function createReviewThread(
  interactionId: string,
  filePath: string,
  lineNumber: number | null,
  comment: string,
  severity: string,
  confidence: number,
  githubCommentId?: string
): string {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO pr_review_threads
    (id, interaction_id, github_comment_id, file_path, line_number, original_comment, severity, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, interactionId, githubCommentId || null, filePath, lineNumber, comment, severity, confidence);
  return id;
}

export function updateThreadState(threadId: string, state: string): void {
  db.prepare(`
    UPDATE pr_review_threads
    SET state = ?, updated_at = ?
    WHERE id = ?
  `).run(state, new Date().toISOString(), threadId);
}

export function addThreadConversation(
  threadId: string,
  role: string,
  message: string
): void {
  const thread = db.prepare(`SELECT conversation FROM pr_review_threads WHERE id = ?`).get(threadId);
  const conversation = JSON.parse(thread.conversation || '[]');
  conversation.push({ role, message, timestamp: new Date().toISOString() });

  db.prepare(`
    UPDATE pr_review_threads
    SET conversation = ?, updated_at = ?
    WHERE id = ?
  `).run(JSON.stringify(conversation), new Date().toISOString(), threadId);
}

export function getOpenThreadsForPR(repoFullName: string, prNumber: number): PRReviewThread[] {
  const interaction = db.prepare(`
    SELECT id FROM pr_review_interaction_memory
    WHERE repo_full_name = ? AND pr_number = ?
  `).get(repoFullName, prNumber);

  if (!interaction) return [];

  return db.prepare(`
    SELECT * FROM pr_review_threads
    WHERE interaction_id = ? AND state IN ('open', 'pending_response')
    ORDER BY created_at ASC
  `).all(interaction.id);
}
```

---

#### 2.6 Type Definitions

**File**: `src/types.ts`
**Location**: After existing types

```typescript
// PR Review Memory Types

export const PRReviewGlobalMemorySchema = z.object({
  id: z.string().uuid(),
  user_id: z.string(),
  preferences: z.object({
    confidence_threshold: z.number().min(0).max(100).default(75),
    focus_areas: z.array(z.string()).default([]),
    max_inline_comments: z.number().default(20),
    include_positive_feedback: z.boolean().default(true),
  }).default({}),
  patterns: z.array(z.object({
    type: z.string(),
    pattern: z.string(),
    count: z.number(),
  })).default([]),
  statistics: z.object({
    total_reviews: z.number().default(0),
    avg_issues_per_pr: z.number().default(0),
    approval_rate: z.number().default(0),
  }).default({}),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PRReviewGlobalMemory = z.infer<typeof PRReviewGlobalMemorySchema>;

export const PRReviewRepoMemorySchema = z.object({
  id: z.string().uuid(),
  repo_full_name: z.string(),
  claude_md: z.string().nullable(),
  claude_md_rules: z.array(z.object({
    rule: z.string(),
    category: z.string(),
  })).default([]),
  architecture: z.object({}).passthrough().default({}),
  conventions: z.object({}).passthrough().default({}),
  hot_files: z.array(z.object({
    path: z.string(),
    issue_count: z.number(),
    last_review: z.string(),
  })).default([]),
  review_history: z.array(z.object({
    pr: z.number(),
    date: z.string(),
    issues: z.number(),
    approved: z.boolean(),
  })).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PRReviewRepoMemory = z.infer<typeof PRReviewRepoMemorySchema>;

export const PRReviewInteractionMemorySchema = z.object({
  id: z.string().uuid(),
  repo_full_name: z.string(),
  pr_number: z.number(),
  overall_state: z.enum(['open', 'addressed', 'resolved', 'closed']),
  review_count: z.number(),
  iterations: z.array(z.object({
    date: z.string(),
    issues: z.number(),
    resolved: z.number(),
  })).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PRReviewInteractionMemory = z.infer<typeof PRReviewInteractionMemorySchema>;

export const PRReviewThreadSchema = z.object({
  id: z.string().uuid(),
  interaction_id: z.string().uuid(),
  github_comment_id: z.string().nullable(),
  file_path: z.string(),
  line_number: z.number().nullable(),
  original_comment: z.string(),
  state: z.enum(['open', 'pending_response', 'addressed', 'resolved', 'wont_fix']),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'nit']),
  confidence: z.number().min(0).max(100),
  conversation: z.array(z.object({
    role: z.string(),
    message: z.string(),
    timestamp: z.string(),
  })).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type PRReviewThread = z.infer<typeof PRReviewThreadSchema>;
```

---

### Phase 2 Verification Checklist

- [ ] Database tables created successfully
- [ ] Global memory persists across reviews
- [ ] Repo memory stores CLAUDE.md and rules
- [ ] Interaction memory tracks PR conversations
- [ ] Thread states transition correctly
- [ ] All tests pass

---

## Phase 3: Multi-Agent Architecture

### Overview
Implement parallel specialized review agents to increase coverage and reduce false positives.

### 3.1 Agent Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    REVIEW ORCHESTRATOR                       │
│  (Coordinates agents, merges results, posts review)          │
└─────────────────────────────────────────────────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌───────────┐       ┌─────────────┐       ┌───────────┐
│ Security  │       │ Bug/Logic   │       │ Style     │
│ Analyzer  │       │ Detector    │       │ Checker   │
└───────────┘       └─────────────┘       └───────────┘
    │                      │                      │
    ▼                      ▼                      ▼
┌───────────┐       ┌─────────────┐       ┌───────────┐
│ Test      │       │ CLAUDE.md   │       │ Confidence│
│ Analyzer  │       │ Compliance  │       │ Scorer    │
└───────────┘       └─────────────┘       └───────────┘
```

### 3.2 Agent Definitions

**Directory**: `skills/review-agents/`

#### Security Analyzer Agent
**File**: `skills/review-agents/security-analyzer.md`

Focus areas:
- SQL/NoSQL injection
- XSS vulnerabilities
- Authentication/authorization issues
- Secrets exposure
- OWASP Top 10

#### Bug/Logic Detector Agent
**File**: `skills/review-agents/bug-detector.md`

Focus areas:
- Null pointer dereferences
- Race conditions
- Off-by-one errors
- Infinite loops
- Resource leaks

#### Style Checker Agent
**File**: `skills/review-agents/style-checker.md`

Focus areas:
- Naming conventions
- Code formatting
- Comment quality
- Function complexity
- Dead code

#### Test Analyzer Agent
**File**: `skills/review-agents/test-analyzer.md`

Focus areas:
- Test coverage gaps
- Missing edge case tests
- Test quality (assertions, mocking)
- Integration test presence
- Flaky test patterns

#### CLAUDE.md Compliance Agent
**File**: `skills/review-agents/claudemd-compliance.md`

Focus areas:
- Rule extraction from CLAUDE.md
- Violation detection
- Severity classification
- Recommendation generation

#### Confidence Scorer Agent
**File**: `skills/review-agents/confidence-scorer.md`

Role:
- Reviews all issues from other agents
- Assigns confidence scores 0-100
- Identifies duplicates
- Removes likely false positives

### 3.3 Orchestrator Implementation

**File**: `skills/review-pr.md` (modified)

```markdown
# Review Workflow (Updated)

## Step 1: Preparation
- Clone repository
- Fetch PR diff and details
- Load CLAUDE.md (if exists)
- Load repo memory
- Load PR interaction memory

## Step 2: Parallel Agent Dispatch
Dispatch to specialized agents in parallel using Task tool:
- Security Analyzer
- Bug/Logic Detector
- Style Checker
- Test Analyzer
- CLAUDE.md Compliance (if CLAUDE.md exists)

## Step 3: Result Aggregation
- Collect all agent findings
- Pass to Confidence Scorer
- Deduplicate overlapping issues
- Filter by confidence threshold

## Step 4: Memory Update
- Save new issues to interaction memory
- Update repo hot files list
- Track statistics in global memory

## Step 5: Post Review
- Format inline comments JSON
- Post review via GitHub API
- Save thread IDs to memory
```

### Phase 3 Verification Checklist

- [ ] All 6 agent skill files created
- [ ] Orchestrator dispatches agents in parallel
- [ ] Results merged without duplicates
- [ ] Confidence scoring works across all agents
- [ ] Memory updated after each review
- [ ] All tests pass

---

## Phase 4: Learning & Intelligence

### Overview
Implement feedback loop to learn from author responses and improve future reviews.

### 4.1 Thread Response Handler

**New Skill**: `skills/respond-to-pr-thread.md`

Workflow:
1. Receive webhook/notification of author reply
2. Load interaction memory and thread
3. Analyze author response:
   - Did they address the issue?
   - Did they explain why it's not an issue?
   - Did they request clarification?
4. Update thread state
5. Generate contextual response
6. Post response to thread
7. Update memory with outcome

### 4.2 Feedback Loop Implementation

**File**: `src/be/db.ts` (additions)

```typescript
// Track issue acceptance/rejection

export function recordIssueOutcome(
  threadId: string,
  outcome: 'accepted' | 'rejected' | 'wont_fix'
): void {
  db.prepare(`
    UPDATE pr_review_threads
    SET state = ?, updated_at = ?
    WHERE id = ?
  `).run(
    outcome === 'accepted' ? 'resolved' : 'wont_fix',
    new Date().toISOString(),
    threadId
  );

  // Update patterns in global memory
  const thread = db.prepare(`SELECT * FROM pr_review_threads WHERE id = ?`).get(threadId);
  if (thread && outcome === 'rejected') {
    // Track as potential false positive pattern
    trackFalsePositivePattern(thread.original_comment, thread.confidence);
  }
}

export function trackFalsePositivePattern(comment: string, confidence: number): void {
  // Extract pattern keywords
  // Update global memory patterns
  // Lower future confidence for similar issues
}
```

### 4.3 Threshold Tuning

Auto-adjust confidence threshold based on acceptance rate:

```typescript
export function computeOptimalThreshold(repoFullName: string): number {
  const threads = db.prepare(`
    SELECT confidence, state FROM pr_review_threads t
    JOIN pr_review_interaction_memory i ON t.interaction_id = i.id
    WHERE i.repo_full_name = ? AND t.state IN ('resolved', 'wont_fix')
  `).all(repoFullName);

  // Find threshold where 90% of issues above it were accepted
  // Return adjusted threshold (min 50, max 95)
}
```

### 4.4 Statistics Dashboard Data

Expose review statistics for future UI:

```typescript
export function getReviewStatistics(repoFullName?: string) {
  if (repoFullName) {
    // Per-repo stats
    return db.prepare(`
      SELECT
        COUNT(*) as total_reviews,
        AVG(json_array_length(iterations)) as avg_iterations,
        SUM(CASE WHEN overall_state = 'resolved' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as resolution_rate
      FROM pr_review_interaction_memory
      WHERE repo_full_name = ?
    `).get(repoFullName);
  }

  // Global stats
  return db.prepare(`
    SELECT
      COUNT(*) as total_reviews,
      COUNT(DISTINCT repo_full_name) as repos_reviewed,
      AVG(json_array_length(iterations)) as avg_iterations
    FROM pr_review_interaction_memory
  `).get();
}
```

### Phase 4 Verification Checklist

- [ ] Thread response skill works
- [ ] Issue outcomes tracked correctly
- [ ] False positive patterns recorded
- [ ] Threshold auto-tuning functional
- [ ] Statistics queries return correct data
- [ ] All tests pass

---

## Summary

| Phase | Focus | Key Deliverables |
|-------|-------|------------------|
| Phase 1 | Quick Wins | CLAUDE.md loading, confidence scores, inline comments |
| Phase 2 | Memory System | SQLite persistence, 4-table schema, memory functions |
| Phase 3 | Multi-Agent | 6 specialized agents, orchestrator, parallel execution |
| Phase 4 | Learning | Thread response handler, feedback loop, threshold tuning |

## Dependencies

- `gh` CLI (GitHub CLI) - for API interactions
- `bun` / Node.js - runtime
- SQLite - database (already in use)
- Existing agent-swarm infrastructure

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| GitHub API rate limits | Cache CLAUDE.md, batch inline comments, implement backoff |
| Agent coordination complexity | Start with 3 agents, add more incrementally |
| Memory bloat | Implement retention policy, prune old PR memories |
| False positive fatigue | Conservative initial threshold (80), user-configurable |

## Success Metrics

- **Inline comment adoption**: >80% of issues posted as inline comments
- **Confidence accuracy**: >90% of high-confidence issues accepted by authors
- **Review thoroughness**: Average issues per PR increases 2x from baseline
- **Thread resolution**: >70% of threads reach resolved state
- **Memory utilization**: CLAUDE.md loaded in >95% of repos that have it

---

## Appendix: User Interaction Patterns for Memory Layer

This section documents how PR creators, reviewers, and external agents can interact with the swarm's memory layer during PR reviews. Full documentation is available in [docs/MEMORY_INTERACTION.md](../../../docs/MEMORY_INTERACTION.md).

### Memory Trigger Phrases

The memory layer responds to natural language commands in PR comments:

#### Storing Preferences

| Trigger | Example | Scope |
|---------|---------|-------|
| `remember this: ...` | `@swarm-bot remember this: We use 2-space indentation` | Per-repo |
| `remember that ...` | `@swarm-bot remember that error messages are English-only` | Per-repo |
| `for future reviews: ...` | `@swarm-bot for future reviews: Always check SQL injection` | Per-repo |
| `we use ... in this repo` | `@swarm-bot we use PascalCase for components in this repo` | Per-repo |
| `this is intentional because ...` | `@swarm-bot this is intentional because of backwards compat` | Per-PR |

#### Dismissing Feedback

| Trigger | Example | Scope |
|---------|---------|-------|
| `i don't care about ...` | `@swarm-bot i don't care about trailing whitespace` | Per-repo |
| `ignore ... issues` | `@swarm-bot ignore nit-level style issues in tests` | Per-repo |
| `don't flag ...` | `@swarm-bot don't flag console.log in dev scripts` | Per-repo |
| `this is fine because ...` | `@swarm-bot this is fine because null checked in caller` | Per-PR |
| `won't fix: ...` | `@swarm-bot won't fix: we prefer this pattern` | Per-thread |

#### Adjusting Sensitivity

| Trigger | Example |
|---------|---------|
| `be stricter about ...` | `@swarm-bot be stricter about security in API handlers` |
| `be more lenient with ...` | `@swarm-bot be more lenient with types in test files` |
| `focus more on ...` | `@swarm-bot focus more on performance in DB queries` |

### Best Practices

1. **Be Specific**: `remember this: All API endpoints must validate with Zod` > `remember to validate stuff`
2. **Provide Context**: `this is fine because we're using a factory pattern` > `this is fine`
3. **Scope Appropriately**: Use per-repo for standards, per-PR for exceptions
4. **Update When Things Change**: `forget: the 2-space rule - we're moving to 4-space`

### How Memory Affects Reviews

**Before Review**: Agent loads repo preferences, applies sensitivity adjustments, filters dismissed issue types

**During Review**: Issues scored against patterns, dismissed types get lower confidence, focus areas get extra attention

**After Review**: Your responses update memory - accepted issues reinforce patterns, dismissals lower future confidence

### Memory Types

| Type | Example | Lifetime |
|------|---------|----------|
| **Episodic** | "PR #42 had auth issue" | Months |
| **Semantic** | "Uses 2-space indentation" | Permanent until updated |
| **Procedural** | "How to review auth code" | Permanent, improved over time |

### Integration Points

The memory layer integrates with:

1. **Thread Response Handler** (Phase 4): Parses trigger phrases from author replies
2. **Repo Memory Table** (Phase 2): Stores per-repo preferences and conventions
3. **PR Interaction Memory** (Phase 2): Tracks per-PR exceptions and decisions
4. **Confidence Scoring** (Phase 1): Adjusts scores based on stored preferences

### Implementation Requirements

To support these interaction patterns, the thread response handler (Phase 4) must:

1. **Parse trigger phrases** from comment text
2. **Extract the preference/rule** being set or modified
3. **Determine scope** (per-repo, per-PR, per-thread)
4. **Store in appropriate memory table**
5. **Confirm to user** what was stored

Example parsing logic:

```typescript
const MEMORY_TRIGGERS = {
  store: [
    /remember this:\s*(.+)/i,
    /remember that\s+(.+)/i,
    /for future reviews:\s*(.+)/i,
    /we use (.+) in this repo/i,
    /our convention is\s*(.+)/i,
  ],
  dismiss: [
    /i don't care about\s+(.+)/i,
    /ignore (.+) issues/i,
    /don't flag\s+(.+)/i,
    /skip (.+) checks/i,
  ],
  adjust: [
    /be stricter about\s+(.+)/i,
    /be more lenient with\s+(.+)/i,
    /focus more on\s+(.+)/i,
    /focus less on\s+(.+)/i,
  ],
};

function parseMemoryTrigger(comment: string): MemoryAction | null {
  for (const [action, patterns] of Object.entries(MEMORY_TRIGGERS)) {
    for (const pattern of patterns) {
      const match = comment.match(pattern);
      if (match) {
        return { action, content: match[1].trim() };
      }
    }
  }
  return null;
}
```
