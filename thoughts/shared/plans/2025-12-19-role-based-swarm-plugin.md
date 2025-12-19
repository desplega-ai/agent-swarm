# Role-Based Agent Swarm Plugin Implementation Plan

## Overview

Extend the agent-swarm plugin to support specialized worker and lead roles (Developer, Tester, PM, Reviewer, Marketer for workers; Founder, CEO, PM for leads) with role-specific commands, agents, and system prompts.

## Current State Analysis

- **Commands**: 2 generic commands (`setup-leader.md`, `start-worker.md`)
- **Agents**: Empty directory (`.gitkeep` only)
- **Copying**: All files in `cc-plugin/commands/` and `cc-plugin/agents/` are copied to container
- **Roles**: Only `lead` and `worker` via `AGENT_ROLE` env var

### Key Discoveries:
- Docker entrypoint: `docker-entrypoint.sh` creates `.mcp.json` dynamically
- Dockerfile.worker copies `cc-plugin/commands/*` to `/home/worker/.claude/commands/`
- Runner uses `defaultPrompt` from config: `src/commands/worker.ts:8`, `src/commands/lead.ts:8`
- System prompts passed via `--append-system-prompt` flag: `src/commands/runner.ts:56-58`

## Desired End State

1. Role-organized directory structure under `cc-plugin/`
2. New env var `WORKER_TYPE` / `LEAD_TYPE` to select role-specific content
3. Docker entrypoint selects appropriate commands/agents based on role type
4. System prompt templates in `prompts/` directory
5. Entry point command uses role-specific command (e.g., `/developer-worker` instead of `/start-worker`)
6. Base plugin agents (codebase-analyzer, codebase-locator, etc.) available to all roles

### Verification:
- Build container with `WORKER_TYPE=tester` and verify only tester commands/agents are active
- Run `/developer-worker` command and confirm it uses correct system prompt
- All roles have access to base plugin agents

## What We're NOT Doing

- **Changing lead/worker hierarchy** - Keep existing `AGENT_ROLE` distinction
- **Multi-plugin architecture** - All roles stay in agent-swarm plugin
- **Runtime role switching** - Role is set at container start, not changeable
- **Complex role inheritance** - Each role is independent, no inheritance chain

## Implementation Approach

Directory-based role organization with Docker entrypoint selecting content at startup based on environment variables. Commands trigger role-specific behavior, agents provide specialized capabilities.

---

## Phase 1: Directory Structure and Common Commands

### Overview
Reorganize `cc-plugin/` with role-based subdirectories.

### Changes Required:

#### 1. Create directory structure

```
cc-plugin/
├── commands/
│   ├── common/                    # Shared by all roles
│   │   ├── setup-leader.md        # (move existing)
│   │   └── start-worker.md        # (move existing)
│   ├── lead/
│   │   ├── founder/
│   │   │   └── founder-lead.md
│   │   ├── ceo/
│   │   │   └── ceo-lead.md
│   │   └── pm/
│   │       └── pm-lead.md
│   └── worker/
│       ├── developer/
│       │   └── developer-worker.md
│       ├── tester/
│       │   └── tester-worker.md
│       ├── reviewer/
│       │   └── reviewer-worker.md
│       ├── pm/
│       │   └── pm-worker.md
│       └── marketer/
│           └── marketer-worker.md
├── agents/
│   ├── common/
│   │   └── task-reporter.md
│   ├── developer/
│   │   ├── code-implementer.md
│   │   └── refactorer.md
│   ├── tester/
│   │   ├── test-generator.md
│   │   └── test-runner.md
│   ├── reviewer/
│   │   └── code-reviewer.md
│   ├── pm/
│   │   └── task-planner.md
│   └── marketer/
│       └── content-creator.md
├── prompts/
│   ├── lead/
│   │   ├── founder.txt
│   │   ├── ceo.txt
│   │   └── pm.txt
│   └── worker/
│       ├── developer.txt
│       ├── tester.txt
│       ├── reviewer.txt
│       ├── pm.txt
│       └── marketer.txt
└── hooks/
    └── hooks.json
```

### Success Criteria:

#### Automated Verification:
- [ ] `ls cc-plugin/commands/common/` shows `setup-leader.md`, `start-worker.md`
- [ ] `ls cc-plugin/commands/worker/*/` shows role subdirectories

#### Manual Verification:
- [ ] Directory structure matches specification

---

## Phase 2: Create Role-Specific Commands

### Overview
Create specialized commands for each worker and lead type.

### Changes Required:

#### Worker Commands:

**`commands/worker/developer/developer-worker.md`**
- Focus on code implementation
- Uses `code-implementer` and `refactorer` agents
- Extends base `start-worker` behavior

**`commands/worker/tester/tester-worker.md`**
- Focus on test writing and QA
- Uses `test-generator` and `test-runner` agents

**`commands/worker/reviewer/reviewer-worker.md`**
- Focus on code review patterns
- Uses `code-reviewer` agent

**`commands/worker/pm/pm-worker.md`**
- Focus on task breakdown
- Uses `task-planner` agent

**`commands/worker/marketer/marketer-worker.md`**
- Focus on content creation
- Uses `content-creator` agent

#### Lead Commands:

**`commands/lead/founder/founder-lead.md`**
- Strategic vision, high-level direction

**`commands/lead/ceo/ceo-lead.md`**
- Execution focus, multi-stream coordination

**`commands/lead/pm/pm-lead.md`**
- Sprint planning, backlog management

### Success Criteria:

#### Automated Verification:
- [ ] All command files exist
- [ ] Each has valid YAML frontmatter

---

## Phase 3: Create Role-Specific Agents

### Overview
Create specialized agents for each role.

### Changes Required:

| Agent | Role | Purpose |
|-------|------|---------|
| `task-reporter.md` | common | Reports progress to lead |
| `code-implementer.md` | developer | Implements features |
| `refactorer.md` | developer | Refactors code |
| `test-generator.md` | tester | Generates test cases |
| `test-runner.md` | tester | Runs and validates tests |
| `code-reviewer.md` | reviewer | Reviews code changes |
| `task-planner.md` | pm | Breaks down tasks |
| `content-creator.md` | marketer | Creates content |

### Success Criteria:

#### Automated Verification:
- [ ] All agent files exist with valid frontmatter

---

## Phase 4: System Prompt Templates

### Overview
Create role-specific system prompts.

### Format:
Plain text files appended via `--append-system-prompt`

### Contents per prompt:
- Role identity and focus
- Key responsibilities
- Communication style
- Quality standards

### Success Criteria:

#### Automated Verification:
- [ ] All prompt files exist in `prompts/lead/` and `prompts/worker/`

---

## Phase 5: Update Docker Configuration

### Changes Required:

#### 1. Dockerfile.worker
**File**: `Dockerfile.worker`

Add environment variables:
```dockerfile
ENV WORKER_TYPE=developer
ENV LEAD_TYPE=founder
```

Update COPY commands:
```dockerfile
# Copy all plugin content (entrypoint selects what's active)
COPY --chown=worker:worker cc-plugin/commands/ /home/worker/.claude/plugin-commands/
COPY --chown=worker:worker cc-plugin/agents/ /home/worker/.claude/plugin-agents/
COPY --chown=worker:worker cc-plugin/prompts/ /home/worker/.claude/prompts/

# Copy base plugin agents
COPY --chown=worker:worker work/ai-toolbox/cc-plugin/base/agents/ /home/worker/.claude/base-agents/
```

#### 2. docker-entrypoint.sh
**File**: `docker-entrypoint.sh`

Add role selection logic:
```bash
WORKER_TYPE="${WORKER_TYPE:-developer}"
LEAD_TYPE="${LEAD_TYPE:-founder}"

# Copy common content
cp -r /home/worker/.claude/plugin-commands/common/* /home/worker/.claude/commands/ 2>/dev/null || true
cp -r /home/worker/.claude/plugin-agents/common/* /home/worker/.claude/agents/ 2>/dev/null || true

# Copy base plugin agents
cp -r /home/worker/.claude/base-agents/* /home/worker/.claude/agents/ 2>/dev/null || true

# Copy role-specific content
if [ "$AGENT_ROLE" = "lead" ]; then
    cp -r /home/worker/.claude/plugin-commands/lead/${LEAD_TYPE}/* /home/worker/.claude/commands/ 2>/dev/null || true
    SYSTEM_PROMPT_FILE="/home/worker/.claude/prompts/lead/${LEAD_TYPE}.txt"
else
    cp -r /home/worker/.claude/plugin-commands/worker/${WORKER_TYPE}/* /home/worker/.claude/commands/ 2>/dev/null || true
    cp -r /home/worker/.claude/plugin-agents/${WORKER_TYPE}/* /home/worker/.claude/agents/ 2>/dev/null || true
    SYSTEM_PROMPT_FILE="/home/worker/.claude/prompts/worker/${WORKER_TYPE}.txt"
fi

# Auto-set system prompt
if [ -z "$WORKER_SYSTEM_PROMPT" ] && [ -z "$WORKER_SYSTEM_PROMPT_FILE" ] && [ -f "$SYSTEM_PROMPT_FILE" ]; then
    export WORKER_SYSTEM_PROMPT_FILE="$SYSTEM_PROMPT_FILE"
fi
```

### Success Criteria:

#### Automated Verification:
- [ ] `docker build -f Dockerfile.worker .` succeeds
- [ ] Container starts with `WORKER_TYPE=tester`

#### Manual Verification:
- [ ] Correct commands/agents copied based on role

---

## Phase 6: Update Runner Commands

### Changes Required:

#### 1. src/commands/worker.ts

```typescript
const workerConfig: RunnerConfig = {
  role: "worker",
  defaultPrompt: `/${process.env.WORKER_TYPE || 'developer'}-worker Start your assigned tasks!`,
  // ... rest unchanged
};
```

#### 2. src/commands/lead.ts

```typescript
const leadConfig: RunnerConfig = {
  role: "lead",
  defaultPrompt: `/${process.env.LEAD_TYPE || 'founder'}-lead Setup and coordinate the swarm!`,
  // ... rest unchanged
};
```

### Success Criteria:

#### Automated Verification:
- [ ] `bun run tsc` passes
- [ ] Runner uses dynamic command

---

## Testing Strategy

### Unit Tests:
- Verify environment variable parsing
- Verify command path construction

### Integration Tests:
- Build container with each WORKER_TYPE
- Verify correct files in `/home/worker/.claude/commands/`

### Manual Testing Steps:
1. `docker build -f Dockerfile.worker -t test-worker .`
2. `docker run -e WORKER_TYPE=tester -it test-worker ls /home/worker/.claude/commands/`
3. Verify only tester + common commands present

---

## Environment Variables Summary

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_ROLE` | `worker` | Lead or worker |
| `WORKER_TYPE` | `developer` | Worker specialization |
| `LEAD_TYPE` | `founder` | Lead specialization |

**Available worker types**: `developer`, `tester`, `reviewer`, `pm`, `marketer`
**Available lead types**: `founder`, `ceo`, `pm`

---

## Base Plugin Agents

All roles have access to base plugin agents:
- `codebase-analyzer.md`
- `codebase-locator.md`
- `codebase-pattern-finder.md`
- `web-search-researcher.md`

Source: `work/ai-toolbox/cc-plugin/base/agents/`

---

## References

- Docker config: `Dockerfile.worker`, `docker-entrypoint.sh`
- Runner config: `src/commands/worker.ts:5-11`, `src/commands/lead.ts:5-11`
- Existing commands: `cc-plugin/commands/setup-leader.md`, `cc-plugin/commands/start-worker.md`
- Base plugin: `work/ai-toolbox/cc-plugin/base/`
