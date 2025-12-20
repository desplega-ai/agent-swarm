# Startup Team Swarm Implementation Plan

## Overview

Extend the agent-swarm to operate like a flat startup team with specialized worker agents (Dev Team + Security + Research), smart task routing based on capabilities, a human "board" for strategic oversight, and lightweight optional processes.

## Current State Analysis

- **Commands**: 2 generic commands (`start-leader.md`, `start-worker.md`)
- **Agents**: Empty directory (`.gitkeep` only)
- **Skills**: Empty directory (`.gitkeep` only)
- **Roles**: Workers can declare `role`, `capabilities[]`, `description` but nothing enforces routing
- **Tasks**: Support `taskType`, `tags[]`, `priority`, `dependsOn[]`

### Key Discoveries:
- Worker config: `src/commands/worker.ts:5-11`
- Lead config: `src/commands/lead.ts:5-11`
- Base prompt with role-specific instructions: `src/prompts/base-prompt.ts`
- Task assignment tool: `src/tools/send-task.ts`
- Database schema: `src/be/db.ts`
- Tool registration: `src/server.ts`

## Desired End State

1. Specialized worker templates in `plugin/agents/` for 8 roles
2. `suggest-assignment` tool for smart task-to-agent routing
3. Goals/milestones system for human board oversight (non-blocking)
4. Optional `request-review`/`submit-review` workflow
5. Reusable skills in `plugin/skills/`

### Verification:
- Workers join with role-specific capabilities from templates
- Lead uses `suggest-assignment` before `send-task`
- Human can create goals, review milestones via UI and #board channel
- Code review is opt-in, not required

## What We're NOT Doing

- **Multi-level hierarchy** - Keeping flat Lead + workers structure
- **Mandatory processes** - Code review stays optional
- **Blocking approvals** - Human board is strategic, doesn't block work
- **Role enforcement** - Workers can still join with any capabilities

## Implementation Approach

Add specialized agent templates, smart routing tool, goals/milestones database tables, board UI panel, and optional review workflow. Phases build incrementally - Phase 1 requires zero code changes.

---

## Phase 1: Agent Specialization Templates

### Overview
Create YAML templates in `plugin/agents/` defining specialized worker profiles.

### Changes Required:

#### 1. Create agent template files

**`plugin/agents/frontend-engineer.yaml`**
```yaml
name: "Frontend Engineer"
role: "frontend"
capabilities:
  - typescript
  - react
  - css
  - html
  - tailwind
  - ui-ux
  - accessibility
taskTypes:
  - frontend
  - ui
  - styling
  - component
description: |
  Frontend specialist focused on React/TypeScript UI development.
  Handles component creation, styling, accessibility, and user experience.
systemPromptAddition: |
  You are a frontend engineer. Your expertise includes:
  - React component architecture and hooks
  - TypeScript for type-safe frontend code
  - CSS/Tailwind for styling
  - Accessibility (a11y) best practices
  - Performance optimization (lazy loading, memoization)

  When receiving tasks, prioritize UI/UX quality and responsive design.
```

Create similar files for:
- `backend-engineer.yaml` - API, database, server (bun, sql, graphql)
- `devops-engineer.yaml` - Docker, CI/CD, deployment, automation
- `qa-engineer.yaml` - Testing, bun-test, e2e, quality-assurance
- `code-reviewer.yaml` - Code review, security, best-practices
- `security-auditor.yaml` - Vulnerability assessment, auth, encryption
- `researcher.yaml` - Research, documentation, web-search, context7
- `analyst.yaml` - Analysis, planning, estimation, metrics

#### 2. Update start-worker.md

**File**: `plugin/commands/start-worker.md`

Add section for template-based registration:
```markdown
## Specialized Worker Setup

If your user specified a specialization, check `plugin/agents/` for the template:
- `frontend` - Frontend Engineer
- `backend` - Backend Engineer
- `devops` - DevOps Engineer
- `qa` - QA Engineer
- `reviewer` - Code Reviewer
- `security` - Security Auditor
- `researcher` - Researcher
- `analyst` - Technical Analyst

Use the matching role and capabilities from the template when calling `join-swarm`.
```

### Success Criteria:

#### Automated Verification:
- [ ] `ls plugin/agents/*.yaml` shows 8 template files
- [ ] Each template has `name`, `role`, `capabilities`, `taskTypes`, `description`, `systemPromptAddition`

#### Manual Verification:
- [ ] Worker joins with capabilities from template

---

## Phase 2: Smart Task Routing

### Overview
Add `suggest-assignment` tool for lead to match tasks to workers by capability.

### Changes Required:

#### 1. Create suggest-assignment tool

**File**: `src/tools/suggest-assignment.ts`

```typescript
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAllAgents, getTasksByAgentId } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerSuggestAssignmentTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "suggest-assignment",
    {
      title: "Suggest Task Assignment",
      description: "Suggests best agent(s) for a task based on capabilities and availability.",
      inputSchema: z.object({
        taskDescription: z.string().describe("The task to be assigned"),
        taskType: z.string().optional().describe("Task type (frontend, backend, etc.)"),
        tags: z.array(z.string()).optional().describe("Task tags"),
        requiredCapabilities: z.array(z.string()).optional().describe("Required capabilities"),
      }),
      outputSchema: z.object({
        suggestions: z.array(z.object({
          agentId: z.string(),
          agentName: z.string(),
          role: z.string().optional(),
          matchScore: z.number(),
          matchReasons: z.array(z.string()),
          availability: z.enum(["idle", "busy", "offline"]),
          pendingTaskCount: z.number(),
          recommendation: z.enum(["strong", "good", "possible", "not-recommended"]),
        })),
      }),
    },
    async (input, requestInfo, _meta) => {
      const agents = getAllAgents().filter(a => !a.isLead);
      const suggestions = [];

      for (const agent of agents) {
        const pendingTasks = getTasksByAgentId(agent.id)
          .filter(t => ["pending", "in_progress"].includes(t.status));

        let score = 0;
        const reasons: string[] = [];

        // Capability matching (+10 per match)
        if (input.requiredCapabilities) {
          const matched = input.requiredCapabilities.filter(c =>
            agent.capabilities?.includes(c)
          );
          if (matched.length > 0) {
            score += matched.length * 10;
            reasons.push(`Matches: ${matched.join(", ")}`);
          }
        }

        // Role matching (+20)
        if (input.taskType && agent.role) {
          const roleMap: Record<string, string[]> = {
            frontend: ["frontend", "ui", "component"],
            backend: ["backend", "api", "database"],
            qa: ["testing", "qa", "bug"],
            devops: ["devops", "deployment", "infrastructure"],
            reviewer: ["review", "security-review"],
            security: ["security", "audit", "vulnerability"],
            researcher: ["research", "documentation"],
            analyst: ["analysis", "planning"],
          };
          if (roleMap[agent.role]?.includes(input.taskType)) {
            score += 20;
            reasons.push(`Role "${agent.role}" matches task type`);
          }
        }

        // Availability (+15 if idle)
        if (agent.status === "idle") {
          score += 15;
          reasons.push("Agent is idle");
        }

        // Workload penalty (-10 if >3 tasks)
        if (pendingTasks.length > 3) {
          score -= 10;
          reasons.push(`High workload (${pendingTasks.length} tasks)`);
        }

        const recommendation =
          score >= 30 ? "strong" :
          score >= 15 ? "good" :
          score > 0 ? "possible" : "not-recommended";

        suggestions.push({
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          matchScore: score,
          matchReasons: reasons,
          availability: agent.status,
          pendingTaskCount: pendingTasks.length,
          recommendation,
        });
      }

      suggestions.sort((a, b) => b.matchScore - a.matchScore);

      return {
        content: [{ type: "text", text: JSON.stringify(suggestions, null, 2) }],
        structuredContent: { suggestions },
      };
    },
  );
};
```

#### 2. Register tool in server

**File**: `src/server.ts`

Add import and registration:
```typescript
import { registerSuggestAssignmentTool } from "@/tools/suggest-assignment";

// In registration section:
registerSuggestAssignmentTool(server);
```

#### 3. Update lead prompt

**File**: `plugin/commands/start-leader.md`

Add routing guidance:
```markdown
## Smart Task Routing

Before assigning tasks, use `suggest-assignment` to find the best worker:

1. Identify task type and required capabilities
2. Call `suggest-assignment` with this info
3. Assign to "strong" or "good" matches
4. If no good matches, create unassigned task for pool
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc` passes
- [ ] `suggest-assignment` tool registered in server

#### Manual Verification:
- [ ] Lead receives ranked suggestions when routing tasks

---

## Phase 3: Human Board Interface

### Overview
Add goals/milestones system for strategic human oversight.

### Changes Required:

#### 1. Add database tables

**File**: `src/be/db.ts`

Add to `initDb()`:
```typescript
db.run(`
  CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'cancelled')),
    priority INTEGER DEFAULT 50,
    createdAt TEXT NOT NULL,
    completedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS milestones (
    id TEXT PRIMARY KEY,
    goalId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_review', 'approved', 'rejected')),
    reviewNotes TEXT,
    createdAt TEXT NOT NULL,
    submittedAt TEXT,
    reviewedAt TEXT,
    FOREIGN KEY (goalId) REFERENCES goals(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS goal_tasks (
    goalId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    PRIMARY KEY (goalId, taskId),
    FOREIGN KEY (goalId) REFERENCES goals(id) ON DELETE CASCADE,
    FOREIGN KEY (taskId) REFERENCES agent_tasks(id) ON DELETE CASCADE
  );
`);

// Seed #board channel
db.run(`
  INSERT OR IGNORE INTO channels (id, name, description, type, createdAt)
  VALUES ('00000000-0000-4000-8000-000000000002', 'board',
    'Strategic board for human direction and milestone approvals', 'public',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`);
```

#### 2. Add types

**File**: `src/types.ts`

```typescript
export const GoalStatusSchema = z.enum(["active", "completed", "cancelled"]);
export const MilestoneStatusSchema = z.enum(["pending", "in_review", "approved", "rejected"]);

export const GoalSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: GoalStatusSchema,
  priority: z.number().int().min(0).max(100).default(50),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

export const MilestoneSchema = z.object({
  id: z.uuid(),
  goalId: z.uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: MilestoneStatusSchema,
  reviewNotes: z.string().optional(),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().optional(),
  reviewedAt: z.iso.datetime().optional(),
});

export type Goal = z.infer<typeof GoalSchema>;
export type Milestone = z.infer<typeof MilestoneSchema>;
```

#### 3. Create board tools

| File | Tool | Purpose |
|------|------|---------|
| `src/tools/create-goal.ts` | `create-goal` | Create strategic goals |
| `src/tools/get-goals.ts` | `get-goals` | List goals with status |
| `src/tools/submit-milestone.ts` | `submit-milestone` | Agent submits milestone for review |
| `src/tools/review-milestone.ts` | `review-milestone` | Human approves/rejects |
| `src/tools/link-task-to-goal.ts` | `link-task-to-goal` | Associate tasks with goals |

#### 4. Create UI component

**File**: `ui/src/components/BoardPanel.tsx`

Features:
- List of active goals with progress
- Pending milestones awaiting review
- Quick approve/reject actions
- Create new goal form

#### 5. Add tab to Dashboard

**File**: `ui/src/components/Dashboard.tsx`

Add BOARD tab next to existing tabs.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc` passes
- [ ] Goals/milestones tables exist after db init
- [ ] Board tools registered

#### Manual Verification:
- [ ] Human can create goals in UI
- [ ] Agents can submit milestones
- [ ] Human can approve/reject in UI

---

## Phase 4: Optional Code Review Workflow

### Overview
Add request-based code review (opt-in, not mandatory).

### Changes Required:

#### 1. Create request-review tool

**File**: `src/tools/request-review.ts`

```typescript
export const registerRequestReviewTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "request-review",
    {
      title: "Request Code Review",
      description: "Request a code review. Creates a review task in the pool.",
      inputSchema: z.object({
        description: z.string().describe("What to review and focus areas"),
        files: z.array(z.string()).optional().describe("Files to review"),
        urgency: z.enum(["low", "normal", "high"]).default("normal"),
        originalTaskId: z.uuid().optional().describe("Link to original task"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        reviewTaskId: z.string().optional(),
        message: z.string(),
      }),
    },
    async (input, requestInfo, _meta) => {
      // Create review task with taskType="review"
      // Set priority based on urgency
      // Tag with files
    },
  );
};
```

#### 2. Create submit-review tool

**File**: `src/tools/submit-review.ts`

Accepts verdict (approved/changes-requested/blocked), summary, and structured issues.

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc` passes
- [ ] Review tools registered

#### Manual Verification:
- [ ] Agent can request review
- [ ] Reviewer can submit findings

---

## Phase 5: Skill Library

### Overview
Create reusable markdown skills in `plugin/skills/`.

### Changes Required:

| Skill | Description |
|-------|-------------|
| `git-operations.md` | Safe commit workflow, branch naming, PR creation |
| `bun-development.md` | Bun-first patterns (Bun.serve, bun:sqlite, bun test) |
| `service-registry.md` | PM2 + service registration workflow |
| `task-management.md` | Task lifecycle best practices |
| `code-review-checklist.md` | Security, quality, performance checklist |

### Success Criteria:

#### Automated Verification:
- [ ] `ls plugin/skills/*.md` shows 5 skill files

---

## Testing Strategy

### Unit Tests:
- `suggest-assignment` returns ranked suggestions
- Goals/milestones CRUD operations work
- Review tools create/complete tasks correctly

### Integration Tests:
- Worker joins with template capabilities
- Lead routes task to correct specialist
- Milestone approval workflow end-to-end

### Manual Testing Steps:
1. Start swarm with 2+ specialized workers
2. Lead receives task, uses `suggest-assignment`
3. Verify correct worker is suggested
4. Human creates goal, links tasks
5. Agent submits milestone, human approves

---

## Files Summary

### New Files (22)

**Agent Templates (8)**: `plugin/agents/*.yaml`
**Tools (8)**:
- `src/tools/suggest-assignment.ts`
- `src/tools/create-goal.ts`
- `src/tools/get-goals.ts`
- `src/tools/submit-milestone.ts`
- `src/tools/review-milestone.ts`
- `src/tools/link-task-to-goal.ts`
- `src/tools/request-review.ts`
- `src/tools/submit-review.ts`

**UI (1)**: `ui/src/components/BoardPanel.tsx`
**Skills (5)**: `plugin/skills/*.md`

### Modified Files (5)

| File | Changes |
|------|---------|
| `src/be/db.ts` | Add goals/milestones tables, seed #board |
| `src/types.ts` | Add Goal, Milestone types |
| `src/server.ts` | Register new tools |
| `plugin/commands/start-worker.md` | Add template references |
| `plugin/commands/start-leader.md` | Add routing guidance |
| `ui/src/components/Dashboard.tsx` | Add BOARD tab |

---

## References

- Worker config: `src/commands/worker.ts:5-11`
- Lead config: `src/commands/lead.ts:5-11`
- Base prompt: `src/prompts/base-prompt.ts`
- Task tools pattern: `src/tools/send-task.ts`
- Database schema: `src/be/db.ts`
- Tool registration: `src/server.ts`
- UI Dashboard: `ui/src/components/Dashboard.tsx`
