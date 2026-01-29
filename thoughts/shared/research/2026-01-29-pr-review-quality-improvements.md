---
date: 2026-01-29T15:45:00Z
topic: "Improving PR Review Quality and Memory"
task_id: "6c586ff9-5ab0-4cf8-b05c-d8300de16201"
author: "Agent 16990304-76e4-4017-b991-f3e37b34cf73"
---

# Research Document: Improving PR Review Quality and Memory

## Executive Summary

This research analyzed Claude official plugins, the current agent-swarm implementation, and best practices for code review to design a comprehensive memory system and quality improvement strategy.

### Key Findings

1. **Claude Official Plugins Architecture**:
   - **Multi-agent approach**: 4 parallel specialized agents (CLAUDE.md compliance x2, bug detector, history analyzer)
   - **Confidence scoring**: 0-100 scale with default 80 threshold
   - **Summary-only comments**: Single review with direct line links

2. **Current Agent-Swarm Gaps**:
   - No memory system (each review starts fresh)
   - Summary-only comments (no inline GitHub comments)
   - Single-agent review (no specialized parallel agents)
   - No confidence scoring
   - No CLAUDE.md auto-loading
   - No reply threading for conversations

3. **Memory System Design** (Three Layers):
   - **Global Memory**: User preferences, org standards, learned patterns across repos
   - **Per-Repo Memory**: Architecture, CLAUDE.md, conventions, review history
   - **Interaction Memory**: Thread state machine (open -> addressed -> resolved), PR conversation context

---

## Detailed Findings

### 1. Claude Official Plugins Analysis

#### Code Review Plugin (`plugins/code-review`)

**Multi-Agent Architecture**:
| Agent | Purpose |
|-------|---------|
| CLAUDE.md Compliance (x2) | Redundant verification of guideline compliance |
| Bug Detector | Focus on obvious bugs in changes only |
| History Analyzer | Git blame and commit history context |
| Confidence Scorers (Nx) | Independent 0-100 scoring per issue |

**Confidence Scoring Scale**:
- 0: False positive
- 25: Might be real
- 50: Real but minor
- 75: Real and important
- 100: Absolutely certain

**Filtering Strategy** (issues removed):
- Pre-existing issues not in PR
- Pedantic nitpicks
- Issues linters will catch
- General quality issues (unless in CLAUDE.md)

#### PR Review Toolkit (`plugins/pr-review-toolkit`)

**Six Specialized Agents**:
1. `comment-analyzer`: Comment accuracy and documentation
2. `pr-test-analyzer`: Test coverage quality (rated 1-10)
3. `silent-failure-hunter`: Error handling and silent failures
4. `type-design-analyzer`: Type quality (4 dimensions, rated 1-10)
5. `code-reviewer`: General CLAUDE.md compliance
6. `code-simplifier`: Clarity and complexity reduction

**Recommended Workflow**:
```
Write code -> code-reviewer -> Fix issues -> pr-test-analyzer ->
Document -> comment-analyzer -> code-simplifier (polish) -> Create PR
```

### 2. Current Agent-Swarm Implementation Analysis

**Location**: Skills are defined in plugin commands like `review-pr.md`

**Current Features**:
- Parses PR number/URL
- Clones repo locally
- Fetches PR details via `gh pr view` / `gh pr diff`
- Analyzes for security, logic, performance, quality, tests
- Provides structured markdown feedback
- Posts via `gh pr review --body`

**Current Strengths**:
- Good structure with executive summary, CI status sections
- Categorizes issues as critical/moderate/minor
- Lists positive aspects
- Clear verdict

**Gaps Identified**:
1. **No inline comments** - Only posts summary comments
2. **No memory** - Each review starts fresh, no learning
3. **Single-agent** - No specialized parallel reviewers
4. **No confidence scoring** - Can't filter low-confidence issues
5. **No CLAUDE.md auto-loading** - Doesn't check repo guidelines
6. **No reply threading** - Can't respond to author replies

### 3. Best Practices for Thorough Code Review

#### Google Engineering Practices - Comment Severity Levels

- **Nit**: Minor, limited impact
- **Optional/Consider**: Suggestions without requirements
- **FYI**: Informational only

**Key Principles**:
1. Be kind - focus on code, not developer
2. Explain reasoning
3. Balance direct instructions with problem identification
4. Encourage improvement

#### Thorough vs Rubber-Stamp Reviews

**Rubber-Stamp Indicators** (what we want to AVOID):
- Quick "LGTM" without analysis
- Reviewing PR title only
- Time pressure overriding quality
- Trust substituting verification
- Approving PRs that should have comments

**Thorough Review Criteria** (what we want to ACHIEVE):
- Verifies functional correctness
- Checks maintainability and conventions
- Assesses technical debt impact
- Reviews security vulnerabilities
- Validates test quality and coverage
- Uses confidence scoring
- Provides actionable feedback
- Questions unclear code
- Considers edge cases

**Optimal PR Size**: 200-400 lines
- Microsoft research: PRs under 300 lines receive 60% more thorough reviews
- Large PRs lead to superficial reviews

---

## Memory System Design Proposal

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      GLOBAL MEMORY                          │
│  (Cross-repository patterns, user preferences, standards)   │
├─────────────────────────────────────────────────────────────┤
│                     PER-REPO MEMORY                         │
│  (Codebase-specific knowledge, CLAUDE.md, architecture)     │
├─────────────────────────────────────────────────────────────┤
│                  INTERACTION MEMORY                         │
│  (PR-specific context, comment threads, review history)     │
└─────────────────────────────────────────────────────────────┘
```

### Layer 1: Global Memory (Agent Profile Integration)

**Purpose**: Store cross-repository preferences and learned patterns

**Contents**:
- User preferences (review depth, focus areas, thresholds)
- Team standards (org-wide conventions)
- Common patterns (frequently flagged issues)
- Learning history (false positives, adjusted thresholds)
- Review statistics (avg issues per PR, approval rate)

**Storage**: Integrated with existing agent infrastructure

**Implementation using existing swarm architecture**:
1. **Agent profile storage**: Use the existing `update-profile` MCP tool's `claudeMd` field to store persistent agent-specific memory
2. **File-based approach**: Store learned patterns/preferences as files in `/workspace/personal/` that can be referenced
3. **CLAUDE.md composition**: The agent's CLAUDE.md can include references to these memory files, making them automatically loaded

**Benefits**:
- Reuses existing infrastructure
- Memory becomes portable across sessions (already synced via profile)
- Can be used for other purposes beyond PR reviews
- Follows the "mounted file" pattern already established in the swarm

### Layer 2: Per-Repo Memory (Fetch-on-Demand)

**Purpose**: Access repository-specific knowledge

**Contents**:
- Architecture understanding (modules, services, dependencies)
- Conventions (naming patterns, file structure, test patterns)
- CLAUDE.md content (fetched fresh each time)
- History (previous reviews, recurring issues, known tech debt)
- Hot files (files with frequent changes/issues)

**Approach: Fetch-on-Demand vs Caching**

Trade-offs considered:
- **Fetch on-demand**: Simpler, always fresh, no sync issues. Works well for CLAUDE.md content.
- **Cached/stored**: Better for computed/derived data (e.g., architecture analysis, pattern learning, review history aggregates).

**Revised proposal**:
- **CLAUDE.md**: Always fetch fresh via `gh api` (no caching needed)
- **Architecture/conventions**: Derive on-demand from codebase analysis
- **Review history/patterns**: Only store learned insights from past reviews that can't just be fetched

**Auto-Loading** (on-demand):
```bash
# On every PR review, fetch fresh CLAUDE.md:
CLAUDE_MD=$(gh api repos/{owner}/{repo}/contents/CLAUDE.md 2>/dev/null | jq -r '.content' | base64 -d)
# Parse into structured rules for review checklist
```

### Layer 3: Interaction Memory

**Purpose**: Track PR-specific conversations and state

**Thread State Machine**:
```
OPEN ──(author responds)──> PENDING_RESPONSE
  │
  └──(reviewer confirms)──────> ADDRESSED ──(verified)──> RESOLVED
```

**Contents**:
- Thread state per comment (open/addressed/resolved)
- Full conversation context
- Review progress tracking
- Follow-up requirements
- Iteration count

### Storage Implementation (File-Based with Agent Profile)

Instead of a separate SQLite database, the memory system integrates with existing swarm infrastructure:

**1. Agent Profile Storage** (`update-profile` MCP tool):
```json
{
  "claudeMd": "## Review Memory\n\n@import /workspace/personal/review-patterns.md\n@import /workspace/personal/review-preferences.md"
}
```

**2. Personal Directory Files** (`/workspace/personal/`):
```
/workspace/personal/
├── review-patterns.md      # Learned patterns from past reviews
├── review-preferences.md   # User preferences and thresholds
└── review-history/         # Per-repo review history
    └── {owner}-{repo}.md   # Repo-specific review notes
```

**3. PR Interaction Memory** (if needed for complex thread tracking):
```sql
-- Minimal schema for PR thread state only (what genuinely needs persistence)
CREATE TABLE pr_threads (
  id TEXT PRIMARY KEY,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  thread_states JSON NOT NULL,  -- {commentId: state}
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_full_name, pr_number)
);
```

This approach:
- Minimizes new infrastructure
- Leverages existing agent profile sync
- Keeps CLAUDE.md as the source of truth for agent behavior
- Only persists what can't be fetched on-demand

---

## Recommendations

### Immediate Actions (1-2 weeks)

#### 1. Implement Inline Comments
Instead of just posting summary comments, use GitHub's PR review API for inline comments:

```bash
# Using gh CLI with review comments
gh api repos/{owner}/{repo}/pulls/{pr}/reviews \
  -X POST \
  -f body="Summary comment" \
  -f event="COMMENT" \
  -f comments='[{"path":"src/file.ts","line":42,"body":"Issue description"}]'
```

Or use `gh-pr-review` CLI extension for easier inline commenting.

#### 2. Auto-Load CLAUDE.md
Before every review:
```bash
# Fetch CLAUDE.md from repo
CLAUDE_MD=$(gh api repos/{owner}/{repo}/contents/CLAUDE.md 2>/dev/null | jq -r '.content' | base64 -d)
# Include in review context
```

#### 3. Add Confidence Scoring
Implement 0-100 confidence scale:
- Only surface issues with confidence >= 80 by default
- Allow user to adjust threshold
- Log low-confidence issues for learning

### Medium-Term (1-2 months)

#### 4. Multi-Agent Review Architecture (Using Existing Swarm Infrastructure)

**Leverage existing agent-swarm architecture** instead of creating a parallel system:

```
┌─────────────────────────────────────────────────────────────┐
│                    LEAD AGENT                               │
│  (Coordinates review, delegates to workers, merges results) │
└─────────────────────────────────────────────────────────────┘
                           │
                    send-task (MCP)
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌─────────┐         ┌─────────────┐         ┌─────────┐
│ Security│         │ Bug Detector│         │ Style   │
│ Worker  │         │   Worker    │         │ Worker  │
└─────────┘         └─────────────┘         └─────────┘
    │                      │                      │
    └──────────────────────┴──────────────────────┘
                           │
                  store-progress (MCP)
                           │
                    ▼ Results to Lead
```

**Implementation using existing swarm tools**:
- Use `send-task` MCP tool to spawn specialized review sub-tasks
- Each specialized reviewer (security, bugs, style) is a worker agent task
- The orchestrator role is handled by the lead agent coordinating reviews
- Results flow through the existing task completion/progress system
- Use `store-progress` to report findings back to lead

This aligns with the swarm's current design pattern where the lead delegates to workers.

#### 5. Implement Memory System (File-Based)
- Use agent profile `claudeMd` field for persistent memory
- Store learned patterns in `/workspace/personal/` files
- Implement memory read/write in review-pr skill
- Track comment threads via minimal persistence (only what can't be fetched)

#### 6. Add Reply Threading
When author replies to a comment:
1. Load PR memory
2. Find relevant thread
3. Update thread state
4. Generate context-aware response
5. Save updated memory

### Long-Term (3+ months)

#### 7. Cross-Repository Intelligence
- Track shared SDK/library usage across repos
- Understand microservice relationships
- Learn from reviews across similar codebases

#### 8. Learning from Feedback
- Track which issues are accepted vs dismissed
- Adjust confidence thresholds based on acceptance rate
- Reduce false positives over time

#### 9. Plugin Integration
Consider installing official plugins:
- `pr-review-toolkit` - 6 specialized agents
- `code-simplifier` - Clarity improvements

---

## Plugin Installation Recommendation

**Should we install more plugins by default?**

**Recommendation**: YES, with per-repo configuration

**Suggested Default Plugins**:
1. `pr-review-toolkit` - Comprehensive 6-agent review coverage
2. `code-simplifier` - Clarity and complexity reduction

**Implementation**:
- Allow repos to opt-out via `.claude/config.json`
- Allow enabling additional plugins per-repo
- Load plugins dynamically based on repo config

---

## Key Questions Answered

### Q1: How do official Claude plugins handle code review?
Multi-agent architecture with parallel specialized reviewers, confidence scoring (0-100), and summary-style comments with direct line links. The `code-review` plugin uses 4+ agents, while `pr-review-toolkit` uses 6 specialized agents.

### Q2: What techniques for inline vs summary comments?
Current plugins use summary comments with links to specific lines (format: `https://github.com/owner/repo/blob/[sha]/path#L[start]-L[end]`). True inline comments require GitHub's PR review API or the `gh-pr-review` CLI extension.

### Q3: How to implement memory for PR review interactions?
Three-layer system integrated with existing swarm infrastructure:
- **Global**: User preferences, org standards, learned patterns (via agent profile `claudeMd` and `/workspace/personal/` files)
- **Per-Repo**: Architecture, CLAUDE.md, conventions, history (fetch-on-demand where possible)
- **Interaction**: PR thread state machine (open -> addressed -> resolved) - minimal persistence only for what can't be fetched

### Q4: What makes thorough vs rubber-stamp review?
**Thorough**: Verifies correctness, checks maintainability, assesses tech debt, reviews security, validates tests, uses confidence scoring, provides actionable feedback.

**Rubber-stamp**: Quick LGTM, reviews title only, time pressure over quality, trust without verification.

### Q5: Should we install additional plugins by default?
**Yes** - Recommend `pr-review-toolkit` for comprehensive coverage. Allow per-repo configuration to opt-out or enable additional plugins.

---

## Sources

- [Claude Code Review Plugin](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-review/README.md)
- [Claude Code Simplifier Agent](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md)
- [Claude PR Review Toolkit](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/pr-review-toolkit/README.md)
- [Google Engineering Practices - How to Write Code Review Comments](https://google.github.io/eng-practices/review/reviewer/comments.html)
- [The Impact of PR Size on Code Review Quality](https://www.propelcode.ai/blog/pr-size-impact-code-review-quality-data-study)
- [gh-pr-review CLI Extension](https://github.com/agynio/gh-pr-review)
- [GitHub MCP Server Issue #635 - Inline Comments](https://github.com/github/github-mcp-server/issues/635)

---

## Appendix: Implementation Checklist

### Phase 1: Quick Wins
- [ ] Auto-fetch and parse CLAUDE.md before reviews
- [ ] Add confidence scoring to issues (0-100)
- [ ] Implement inline comments via `gh api` or `gh-pr-review`
- [ ] Keep summary comment smaller, focused on overall assessment

### Phase 2: Memory System (File-Based)
- [ ] Integrate with agent profile `claudeMd` field for persistent memory
- [ ] Create file structure in `/workspace/personal/` for review patterns
- [ ] Implement memory read/write helpers in review-pr skill
- [ ] Track comment thread states (minimal DB only for what can't be fetched)

### Phase 3: Multi-Agent Architecture (Using Existing Swarm)
- [ ] Configure lead agent to coordinate reviews via `send-task`
- [ ] Create specialized reviewer worker task types (security, bugs, style)
- [ ] Use existing swarm parallel task execution
- [ ] Implement result aggregation from worker `store-progress` outputs

### Phase 4: Learning & Intelligence
- [ ] Track issue acceptance/rejection
- [ ] Adjust confidence thresholds
- [ ] Implement cross-repo learning
- [ ] Add plugin configuration system
