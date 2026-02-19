---
date: 2026-02-19T16:59:00Z
topic: "Compound Engineering Plugin Mechanism Analysis"
author: "Agent 16990304 (Researcher)"
repository: "https://github.com/EveryInc/compound-engineering-plugin"
tags: ["compound-engineering", "knowledge-management", "memory", "cc-plugin", "claude-code"]
related_research: "2026-01-29-database-backed-memory-system.md"
---

# Compound Engineering Plugin Mechanism Analysis

## Executive Summary

This document analyzes the **compound-engineering-plugin** from EveryInc and proposes how its knowledge compounding mechanisms could extend our cc-plugin (desplega-ai/cc-plugin) and integrate with our planned database-backed memory system.

**Key Findings:**
1. The "compound mechanism" is a **documentation-first knowledge capture system** triggered after problem resolution
2. Knowledge is stored as **structured markdown files** with YAML frontmatter in `docs/solutions/`
3. A **learnings-researcher agent** queries this knowledge base before any new work
4. **Critical patterns** are elevated to "required reading" for all agents
5. The mechanism can be **auto-invoked** on phrases like "that worked", "it's fixed", etc.

**Recommendation:** Integrate the compound mechanism with our database-backed memory system by storing compound learnings in the database rather than filesystem, enabling efficient cross-agent querying and persistence.

---

## 1. The Compound Mechanism Explained

### 1.1 Core Philosophy

> "Each unit of engineering work should make subsequent units of work easier—not harder."

The compound-engineering-plugin inverts traditional development where complexity accumulates. Instead, it:
- Plans thoroughly (80%) before writing code (20%)
- Reviews to catch issues AND capture learnings
- **Codifies knowledge** so it's reusable

### 1.2 The Four-Phase Workflow

```
Plan → Work → Review → Compound → Repeat
```

| Phase | Command | Purpose |
|-------|---------|---------|
| **Plan** | `/workflows:plan` | Turn feature ideas into detailed implementation plans |
| **Work** | `/workflows:work` | Execute plans with worktrees and task tracking |
| **Review** | `/workflows:review` | Multi-agent code review before merging |
| **Compound** | `/workflows:compound` | Document learnings to make future work easier |

The key insight is the **Compound phase** - it explicitly captures what was learned and makes it retrievable for future work.

### 1.3 What Triggers Compound Actions?

The `/workflows:compound` command (and `compound-docs` skill) can be triggered:

1. **Manually**: User invokes `/workflows:compound` after solving a problem

2. **Auto-detected**: The system watches for confirmation phrases:
   - "that worked"
   - "it's fixed"
   - "working now"
   - "problem solved"
   - "that did it"

3. **Post-workflow**: After `/workflows:work` completes successfully

From `compound.md` (lines 204-206):
```xml
<auto_invoke>
  <trigger_phrases>
    - "that worked" - "it's fixed" - "working now" - "problem solved"
  </trigger_phrases>
</auto_invoke>
```

---

## 2. Knowledge Structure & Organization

### 2.1 Directory Structure

```
docs/solutions/
├── build-errors/
├── test-failures/
├── runtime-errors/
├── performance-issues/
├── database-issues/
├── security-issues/
├── ui-bugs/
├── integration-issues/
├── logic-errors/
├── developer-experience/
├── workflow-issues/
├── best-practices/
├── documentation-gaps/
└── patterns/
    ├── common-solutions.md
    └── critical-patterns.md
```

### 2.2 YAML Frontmatter Schema

Each solution document has structured metadata for efficient querying:

```yaml
---
module: Email Processing
date: 2025-11-12
problem_type: performance_issue  # enum
component: rails_model           # enum
symptoms:
  - "N+1 query when loading email threads"
  - "Brief generation taking >5 seconds"
root_cause: missing_include      # enum
severity: high                   # critical|high|medium|low
tags: [n-plus-one, eager-loading, performance]
---
```

**Key fields for retrieval:**
- `problem_type`: Maps to directory category
- `component`: Technical area affected
- `symptoms`: Observable behaviors (searchable)
- `root_cause`: Enumerated cause categories
- `tags`: Free-form keywords

### 2.3 Document Template Structure

From `resolution-template.md`, each solution captures:

1. **Problem** - Clear description of the issue
2. **Environment** - Module, version, affected component
3. **Symptoms** - Observable behaviors
4. **What Didn't Work** - Failed attempts (prevents repeating mistakes)
5. **Solution** - The fix with code examples
6. **Why This Works** - Technical root cause explanation
7. **Prevention** - How to avoid in future
8. **Related Issues** - Cross-references

### 2.4 Critical Patterns System

The most important learnings are elevated to `docs/solutions/patterns/critical-patterns.md`:

From `critical-pattern-template.md`:
```markdown
## N. [Pattern Name] (ALWAYS REQUIRED)

### ❌ WRONG ([Will cause X error])
```[language]
[code showing wrong approach]
```

### ✅ CORRECT
```[language]
[code showing correct approach]
```

**Why:** [Technical explanation]
**Documented in:** docs/solutions/[category]/[filename].md
```

These critical patterns are **always loaded** by the `learnings-researcher` agent before any work begins, regardless of the specific task.

---

## 3. How Knowledge is Queried

### 3.1 The learnings-researcher Agent

The `learnings-researcher` agent (haiku model for speed) uses an efficient multi-step strategy:

1. **Extract keywords** from feature/task description
2. **Category-based narrowing** (optional) based on feature type
3. **Grep pre-filter** - Search frontmatter fields BEFORE reading files
4. **Always check critical-patterns.md** - Required reading
5. **Read frontmatter** of matched candidates only (limit:30 lines)
6. **Score and rank** by relevance (module match, tag overlap, symptom similarity)
7. **Full read** only for truly relevant files
8. **Return distilled summaries** with key insights

Example grep patterns used:
```bash
Grep: pattern="title:.*email" path=docs/solutions/ -i=true
Grep: pattern="tags:.*(email|mail|smtp)" path=docs/solutions/ -i=true
Grep: pattern="module:.*(Brief|Email)" path=docs/solutions/ -i=true
```

### 3.2 Integration Points

The learnings-researcher is invoked by:
- `/workflows:plan` - Informs planning with institutional knowledge
- `/workflows:review` - Surfaces past issues related to PR's modules
- Manual invocation before feature work

---

## 4. Integration Proposal for cc-plugin

### 4.1 Current cc-plugin Workflow

Our current desplega cc-plugin has:
```
/desplega:research → /desplega:create-plan → /desplega:implement-plan
```

**Missing piece:** No explicit "compound" phase to capture learnings after successful implementations.

### 4.2 Proposed Extended Workflow

```
Research → Plan → Implement → Verify → Compound → (loop)
```

New commands/skills to add:
1. **`/desplega:compound`** - Capture learnings after successful work
2. **`learnings-researcher` agent** - Query past learnings before new work
3. **Auto-compound hook** - Trigger after successful implementations

### 4.3 Database-Backed Storage vs Filesystem

**Compound-engineering-plugin approach:** Filesystem-based markdown files with YAML frontmatter, searched via grep.

**Proposed enhancement for our system:** Store learnings in the **agent_memories** database table (from our prior research), with filesystem as cache/display.

#### Why Database > Filesystem for Our Use Case

| Aspect | Filesystem (compound-engineering) | Database (our proposal) |
|--------|-----------------------------------|------------------------|
| **Query speed** | Grep search on every query | SQL indexes + full-text search |
| **Cross-agent sharing** | Shared git repo required | Native database access |
| **Persistence** | Git-dependent | Database durability |
| **Structured queries** | YAML parsing required | Direct SQL filters |
| **Update frequency** | File write + git commit | Single DB transaction |

### 4.4 Mapping Compound Schema to Memory Schema

From our `2026-01-29-database-backed-memory-system.md` research:

```sql
CREATE TABLE agent_memories (
  id TEXT PRIMARY KEY,
  agentId TEXT NOT NULL,
  memoryType TEXT NOT NULL,  -- 'episodic', 'semantic', 'procedural'
  category TEXT,
  content TEXT NOT NULL,
  context TEXT,  -- JSON
  importance REAL DEFAULT 0.5,
  sourceType TEXT,
  sourceId TEXT,
  ...
);
```

**Mapping compound learnings to memory types:**

| Compound Content | Memory Type | Category Example |
|------------------|-------------|------------------|
| Problem symptoms/solution | **episodic** | 'implementation-outcome' |
| Code conventions discovered | **semantic** | 'code-conventions' |
| Critical patterns | **procedural** | 'required-patterns' |
| Prevention strategies | **procedural** | 'prevention-rules' |

**Example memory insertion for a compound learning:**

```typescript
await storeMemory({
  memoryType: 'episodic',
  category: 'implementation-outcome',
  content: 'N+1 query in brief generation fixed by adding .includes(:emails) to Brief model. Root cause: missing eager loading causing separate query per email thread.',
  contexts: [
    { type: 'repo', value: 'desplega-ai/agent-swarm' },
    { type: 'topic', value: 'performance' },
    { type: 'component', value: 'Brief System' }
  ],
  importance: 0.9,  // High because it fixed a performance issue
  sourceType: 'compound',
  sourceId: 'task-uuid-or-pr-number'
});
```

### 4.5 Critical Patterns as High-Priority Procedural Memory

Critical patterns should be stored with:
- `memoryType: 'procedural'`
- `importance: 1.0` (always loaded)
- `category: 'critical-patterns'`

Query at session start:
```typescript
const criticalPatterns = await queryMemory({
  memoryType: 'procedural',
  category: 'critical-patterns',
  sortBy: 'importance',
  limit: 100
});
// Load into agent context
```

---

## 5. Auto-Triggering After Successful Implementations

### 5.1 Current Triggering Mechanisms

Compound-engineering uses:
1. Manual `/workflows:compound` command
2. Auto-detect on phrases like "that worked"
3. Post-workflow hook suggestion

### 5.2 Proposed Auto-Trigger for Our System

**Option A: Hook-based Auto-Trigger**

Add a Claude Code hook that triggers compound after:
- `git commit` with conventional commit message
- `store-progress` with `status: 'completed'`
- Phrases like "that worked", "fixed", etc.

```json
{
  "hooks": {
    "PostCommit": [
      { "matcher": "^(feat|fix|refactor):", "action": "suggest_compound" }
    ],
    "PostTaskComplete": [
      { "action": "auto_compound_prompt" }
    ]
  }
}
```

**Option B: Integrated into `/desplega:implement-plan`**

At the end of successful implementation:
```markdown
## Post-Implementation

After all plan items are complete:
1. Run final verification (tests pass, lint clean)
2. **AUTO-INVOKE compound-docs skill** with implementation context
3. Store learnings in database
4. Suggest creating PR
```

**Recommendation:** Combine both - integrate into `/desplega:implement-plan` for guaranteed capture, plus hook-based for ad-hoc work.

### 5.3 What to Auto-Capture

For each successful implementation, capture:

| Data | Source | Memory Type |
|------|--------|-------------|
| What was built | Plan file summary | episodic |
| Files modified | Git diff | episodic |
| Patterns used | Code analysis | semantic |
| Gotchas encountered | Conversation context | procedural |
| Test coverage added | Test diff | semantic |

---

## 6. Implementation Roadmap

### Phase 1: Database Schema (Aligns with existing research)

Use the `agent_memories` schema from `2026-01-29-database-backed-memory-system.md`:
- Add `compound_source` to context metadata
- Add `problem_type`, `component`, `root_cause` as queryable fields in context JSON

### Phase 2: Compound Skill for cc-plugin

Create `/desplega:compound` skill:
1. Gather context from conversation (similar to compound-docs Step 2)
2. Extract: symptoms, solution, root cause, prevention
3. Store in database via `store-memory` MCP tool
4. Generate markdown cache file for human readability

### Phase 3: Learnings Query Integration

Add `query-memory` calls to:
- `/desplega:create-plan` - Check for related learnings before planning
- `/desplega:implement-plan` - Surface relevant patterns during implementation

### Phase 4: Auto-Trigger Hooks

Implement hooks for:
- Post-commit with feat/fix prefix
- Post-task-completion
- Phrase detection ("that worked", etc.)

### Phase 5: Critical Patterns System

- Store critical patterns with `importance: 1.0`
- Auto-load at session start
- UI for promoting learnings to critical patterns

---

## 7. Key Recommendations

### 7.1 Should compound actions trigger automatically after successful implementations?

**YES**, with these guidelines:
- **Always trigger** after `/desplega:implement-plan` completes successfully
- **Suggest** (don't force) after ad-hoc commits
- **Allow skip** for trivial changes

### 7.2 How should this integrate with database-backed memory?

- Store learnings in `agent_memories` table (not just filesystem)
- Use `memoryType` mapping: episodic for outcomes, semantic for conventions, procedural for patterns
- Critical patterns get `importance: 1.0` and auto-load at session start

### 7.3 What should our compound-docs skill capture?

Minimum viable capture:
1. **What was fixed/built** (summary)
2. **Key files changed** (paths)
3. **Solution approach** (brief description)
4. **Prevention guidance** (how to avoid issues)

Full capture (for significant changes):
5. What didn't work (failed attempts)
6. Root cause analysis
7. Related learnings (cross-references)
8. Code examples (before/after)

---

## 8. Conclusion

The compound-engineering-plugin provides a proven model for **institutionalizing learnings** through structured documentation and intelligent retrieval. By integrating these concepts with our database-backed memory system, we can create a more powerful knowledge compounding system that:

1. **Persists across sessions** via database storage
2. **Queries efficiently** via SQL indexes rather than grep
3. **Shares across agents** natively through the swarm database
4. **Auto-triggers** after successful implementations
5. **Surfaces critical patterns** at session start

The investment in building this system compounds: each documented solution makes future work faster and prevents repeated mistakes across all agents in the swarm.

---

## References

- [EveryInc/compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)
- [Compound engineering: how Every codes with agents](https://every.to/chain-of-thought/compound-engineering-how-every-codes-with-agents)
- [Database-Backed Memory System Research](./2026-01-29-database-backed-memory-system.md)
- [Mem0 AI Agent Memory](https://mem0.ai/)

---

## Appendix: Key Files Analyzed

| File | Purpose |
|------|---------|
| `commands/workflows/compound.md` | Main compound workflow command |
| `skills/compound-docs/SKILL.md` | 7-step documentation capture process |
| `skills/compound-docs/references/yaml-schema.md` | Frontmatter schema definition |
| `skills/compound-docs/assets/resolution-template.md` | Solution document template |
| `skills/compound-docs/assets/critical-pattern-template.md` | Critical pattern format |
| `agents/research/learnings-researcher.md` | Knowledge query agent |
| `commands/workflows/plan.md` | Planning workflow (references learnings) |
| `commands/workflows/work.md` | Execution workflow |
| `commands/workflows/review.md` | Review workflow (invokes learnings-researcher) |
| `commands/workflows/brainstorm.md` | Pre-planning exploration |
