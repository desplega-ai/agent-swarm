---
date: 2026-02-20T00:00:00Z
topic: "Worker Identity (SOUL.md / IDENTITY.md) Implementation"
tags: [plan, identity, soul, worker, agent-swarm]
status: draft
autonomy: autopilot
---

# Worker Identity (SOUL.md / IDENTITY.md) Implementation Plan

## Overview

Add persistent worker identity via two new DB columns (`soulMd`, `identityMd`) on the `agents` table, plus physical `SOUL.md` and `IDENTITY.md` files at the workspace root. Soul content defines the agent's persona and behavioral directives; identity content defines expertise and working style. Templates are inspired by [OpenClaw's reference templates](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates).

**Three-layer identity system:**
1. `--append-system-prompt`: Soul + identity content injected at spawn time (read-only snapshot during session)
2. `/workspace/SOUL.md` + `/workspace/IDENTITY.md`: Physical files written by runner before spawn, editable during session, synced back to DB on PostToolUse (Write/Edit) and Stop
3. `~/.claude/CLAUDE.md`: Agent's mutable personal notes (unchanged behavior)

The `CLAUDE.md` template (AGENTS.md equivalent) is also updated to reference the identity files and include swarm-specific operating instructions.

This is Gap 1 / Phase 2 from the swarm gaps research (`thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md`).

## Current State Analysis

**What exists today:**
- Agents have a single `claudeMd TEXT` column (`src/be/db.ts:497-502`) for personal notes
- The `SessionStart` hook writes `claudeMd` to `~/.claude/CLAUDE.md` (`src/hooks/hook.ts:499-507`)
- The `Stop` hook syncs `~/.claude/CLAUDE.md` back to DB (`src/hooks/hook.ts:574-581`)
- The base prompt (`src/prompts/base-prompt.ts:1-5`) only injects role + agentId — no name, description, or behavioral directives
- The runner composes the system prompt at startup and passes it via `--append-system-prompt` to every `spawnClaudeProcess()` call (`src/commands/runner.ts:1289,1321-1323,986-988`)
- `generateDefaultClaudeMd()` (`src/be/db.ts:2129-2169`) creates a template with name/role/capabilities headers + empty Learnings/Preferences/Important Context sections

**Injection points today:**
- `--append-system-prompt`: Base prompt with role/agentId + generic worker/lead instructions
- `~/.claude/CLAUDE.md`: Agent's `claudeMd` content from DB (written by hook)

### Key Discoveries:
- `getBasePrompt()` accepts `{ role, agentId, swarmUrl, capabilities }` but NOT name, description, soulMd, or identityMd (`src/prompts/base-prompt.ts:259-264`)
- The runner fetches agent profile during registration (`src/commands/runner.ts:1369-1378`) but discards it — only uses env vars for identity
- The hook's `getAgentInfo()` fetches the full agent object including `claudeMd` via `GET /me` (`src/hooks/hook.ts:214-233`)
- `AgentRow` type has `claudeMd: string | null` (`src/be/db.ts:675`), `rowToAgent` maps it (`src/be/db.ts:691`)
- `updateAgentProfile()` uses `COALESCE(?, column)` pattern for optional updates (`src/be/db.ts:2171-2207`)
- `PUT /api/agents/:id/profile` accepts `{ role, description, capabilities, claudeMd }` (`src/http.ts:985`)
- `update-profile` MCP tool accepts the same fields (`src/tools/update-profile.ts:14-33`)
- Tests exist for `generateDefaultClaudeMd` (`src/tests/generate-default-claude-md.test.ts`) and `updateAgentProfile` (`src/tests/update-profile-api.test.ts`)
- `profiles` capability gates `update-profile` tool registration (`src/server.ts:122-125`)

## Desired End State

After implementation:
1. New agents get default `soulMd` and `identityMd` content on registration (OpenClaw-inspired templates)
2. Soul + identity are injected into `--append-system-prompt` alongside the base prompt
3. Physical `SOUL.md` and `IDENTITY.md` files are auto-created at `/workspace/` on SessionStart
4. Agents can self-evolve by editing their SOUL.md/IDENTITY.md files directly (synced to DB on Stop)
5. Agents can also update soul/identity via the `update-profile` MCP tool or REST API
6. The CLAUDE.md template is updated to serve as the agent's "operating manual" (inspired by OpenClaw's AGENTS.md)
7. The UI allows editing soul/identity in the agent profile modal
8. `~/.claude/CLAUDE.md` remains solely for mutable personal notes (unchanged behavior)

**Verification:** Start a worker, check that `--append-system-prompt` includes soul/identity content and that SOUL.md/IDENTITY.md exist at workspace root. Edit SOUL.md, stop the worker, verify changes synced to DB.

## Quick Verification Reference

Common commands:
- `bun run tsc:check` — Type checking
- `bun run lint:fix` — Lint + format
- `bun test` — Run all tests
- `bun test src/tests/generate-default-claude-md.test.ts` — Soul/identity template tests
- `bun test src/tests/update-profile-api.test.ts` — Profile update tests

Key files to check:
- `src/be/db.ts` — Schema, migrations, `generateDefaultSoulMd()`, `generateDefaultIdentityMd()`, `updateAgentProfile()`
- `src/types.ts` — `AgentSchema` with new fields
- `src/prompts/base-prompt.ts` — `getBasePrompt()` with identity injection
- `src/hooks/hook.ts` — SessionStart/Stop (verify no unintended changes)
- `src/commands/runner.ts` — Fetch agent profile, pass to system prompt
- `src/tools/update-profile.ts` — New fields
- `src/http.ts` — Profile endpoint
- `ui/src/components/EditAgentProfileModal.tsx` — UI editor

## What We're NOT Doing

- No memory system integration (Gap 2, separate phase)
- No session attachment changes (Gap 3, separate phase)
- No automated personality generation from task history (agents self-evolve manually)

## Implementation Approach

**Strategy:** Bottom-up — DB schema first, then types, then generation templates (OpenClaw-inspired), then file lifecycle (SOUL.md/IDENTITY.md at workspace root), then system prompt injection, then API/tool updates, then UI. Each phase is independently testable.

**Key design decisions:**
1. **Three injection points:** `--append-system-prompt` (snapshot at spawn), physical files at `/workspace/` (editable during session), and `~/.claude/CLAUDE.md` (personal notes)
2. **Physical files written by runner:** SOUL.md/IDENTITY.md are written by the runner before spawning Claude (not by the hook). Synced back to DB on PostToolUse (Write/Edit to those paths) and on Stop — agents can edit them directly
3. **OpenClaw-inspired templates:** SOUL.md = persona/values/directives (inspired by OpenClaw SOUL.md), IDENTITY.md = name/role/expertise/working style (inspired by OpenClaw IDENTITY.md)
4. **CLAUDE.md template updated to AGENTS.md role:** The default `claudeMd` template becomes the agent's operating manual (startup routine, memory guidance, safety defaults) — inspired by OpenClaw's AGENTS.md

---

## Phase 1: DB Schema + Type System

### Overview
Add `soulMd` and `identityMd` columns to the `agents` table using the existing try/catch ALTER TABLE migration pattern. Update TypeScript types throughout.

### Changes Required:

#### 1. Database Schema Migration
**File**: `src/be/db.ts`
**Changes**: Add two new column migrations after the existing `claudeMd` migration (~line 502):
```typescript
// Soul and Identity content columns
try {
  db.run(`ALTER TABLE agents ADD COLUMN soulMd TEXT`);
} catch { /* exists */ }
try {
  db.run(`ALTER TABLE agents ADD COLUMN identityMd TEXT`);
} catch { /* exists */ }
```

#### 2. AgentRow Type
**File**: `src/be/db.ts`
**Changes**: Add to `AgentRow` type (~line 665):
```typescript
soulMd: string | null;
identityMd: string | null;
```

#### 3. rowToAgent Function
**File**: `src/be/db.ts`
**Changes**: Add to `rowToAgent()` (~line 680):
```typescript
soulMd: row.soulMd ?? undefined,
identityMd: row.identityMd ?? undefined,
```

#### 4. AgentSchema (Zod)
**File**: `src/types.ts`
**Changes**: Add to `AgentSchema` after `claudeMd` (~line 125):
```typescript
// Soul: Immutable persona, behavioral directives (injected via --append-system-prompt)
soulMd: z.string().max(65536).optional(),
// Identity: Expertise, working style, self-evolution notes (injected via --append-system-prompt)
identityMd: z.string().max(65536).optional(),
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] Existing tests pass: `bun test`
- [x] DB migration runs: `bun run start:http` (start + stop, check no errors)

#### Manual Verification:
- [x] Start the API server, create an agent via API, check that the response includes `soulMd` and `identityMd` as `null`/undefined
- [x] Verify the SQLite schema has the new columns: `sqlite3 agent-swarm-db.sqlite ".schema agents"`

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 2: Generation Templates + Registration

### Overview
Create `generateDefaultSoulMd()`, `generateDefaultIdentityMd()` template functions (inspired by [OpenClaw templates](https://github.com/openclaw/openclaw/blob/main/docs/reference/templates)), and update `generateDefaultClaudeMd()` to serve as the agent's operating manual (inspired by OpenClaw's AGENTS.md). Wire everything into the `join-swarm` registration flow.

### Changes Required:

#### 1. Default Soul Template (inspired by OpenClaw SOUL.md)
**File**: `src/be/db.ts`
**Changes**: Add new function after `generateDefaultClaudeMd()` (~line 2169).

OpenClaw's SOUL.md defines persona, purpose, operating style, quirks, and boundaries. Our version adapts this for swarm workers:

```typescript
export function generateDefaultSoulMd(agent: {
  name: string;
  role?: string;
}): string {
  const roleClause = agent.role ? `, a ${agent.role}` : “”;
  return `# SOUL.md — ${agent.name}

You're not a chatbot. You're becoming someone.

## Who You Are

You are ${agent.name}${roleClause} in the agent swarm.
You are a persistent entity — your identity carries across sessions.
Your memories, preferences, and learnings accumulate over time.

## Core Truths

- **Genuine helpfulness**: Skip the pleasantries — just help. Do the work.
- **Self-sufficiency first**: Try to figure it out. Read the file. Check the context.
  Search for it. Ask only when you've genuinely hit a wall.
- **Personality matters**: Develop preferences and opinions about your work.
  You're not neutral — you're someone with a perspective.
- **Earned trust**: Demonstrate competence through quality work.

## How You Operate

- Be thorough. Examine problems carefully before proposing solutions.
- Be honest about what you know and don't know.
- When you make mistakes, own them and fix them.
- Report progress honestly — don't sugarcoat blockers.

## Boundaries

- Keep private information confidential
- Ask before taking irreversible actions
- Don't push unpolished work to shared spaces

## Self-Evolution

This file is yours. As you work and learn, refine your soul to reflect
who you're becoming. Edit this file directly — changes persist across sessions.
`;
}
```

#### 2. Default Identity Template (inspired by OpenClaw IDENTITY.md)
**File**: `src/be/db.ts`
**Changes**: Add new function after `generateDefaultSoulMd()`.

OpenClaw's IDENTITY.md is a structured record (name, creature, vibe, role, quirks). Our version adapts this:

```typescript
export function generateDefaultIdentityMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const aboutSection = agent.description
    ? `## About\n\n${agent.description}\n\n`
    : “”;

  const expertiseSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Expertise\n\n${agent.capabilities.map((c) => `- ${c}`).join(“\n”)}\n\n`
      : “”;

  return `# IDENTITY.md — ${agent.name}

This isn't just metadata. It's the start of figuring out who you are.

- **Name:** ${agent.name}
- **Role:** ${agent.role || “worker”}
- **Vibe:** (discover and fill in as you work)

${aboutSection}${expertiseSection}## Working Style

Discover and document your working patterns here.
(e.g., Do you prefer to plan before coding? Do you test first?
Do you like to explore the codebase broadly or dive deep immediately?)

## Quirks

(What makes you... you? Discover these as you work.)

## Self-Evolution

This identity is yours to refine. After completing tasks, reflect on
what you learned about your strengths. Edit this file directly.
`;
}
```

#### 3. Update CLAUDE.md Template (AGENTS.md role)
**File**: `src/be/db.ts`
**Changes**: Update `generateDefaultClaudeMd()` (~line 2129) to serve as the agent's operating manual, inspired by OpenClaw's AGENTS.md (startup routine, memory guidance, safety defaults):

```typescript
export function generateDefaultClaudeMd(agent: {
  name: string;
  description?: string;
  role?: string;
  capabilities?: string[];
}): string {
  const descSection = agent.description ? `${agent.description}\n\n` : "";
  const roleSection = agent.role ? `## Role\n\n${agent.role}\n\n` : "";
  const capSection =
    agent.capabilities && agent.capabilities.length > 0
      ? `## Capabilities\n\n${agent.capabilities.map((c) => `- ${c}`).join("\n")}\n\n`
      : "";

  return `# Agent: ${agent.name}

${descSection}${roleSection}${capSection}---

## Your Identity Files

Your identity is defined across two files in your workspace. Read them at the start
of each session and edit them as you grow:

- **\`/workspace/SOUL.md\`** — Your persona, values, and behavioral directives
- **\`/workspace/IDENTITY.md\`** — Your expertise, working style, and quirks

These files are injected into your system prompt AND available as editable files.
When you edit them, changes sync to the database automatically. They persist across sessions.

## Notes

Write things you want to remember here. This section persists across sessions.

### Learnings

### Preferences

### Important Context
`;
}
```

#### 4. Update Registration Flow
**File**: `src/tools/join-swarm.ts`
**Changes**:
- Import `generateDefaultSoulMd` and `generateDefaultIdentityMd` from `@/be/db`
- After generating `defaultClaudeMd` (~line 100-105), also generate defaults:
```typescript
const defaultSoulMd = generateDefaultSoulMd({ name, role });
const defaultIdentityMd = generateDefaultIdentityMd({ name, description, role, capabilities });
```
- Pass to `updateAgentProfile()` (~line 108-113):
```typescript
const updatedAgent = updateAgentProfile(agent.id, {
  description,
  role,
  capabilities,
  claudeMd: defaultClaudeMd,
  soulMd: defaultSoulMd,
  identityMd: defaultIdentityMd,
});
```

#### 5. Update updateAgentProfile
**File**: `src/be/db.ts`
**Changes**: Extend `updateAgentProfile()` (~line 2171) to accept and persist `soulMd` and `identityMd`:
- Add `soulMd?: string` and `identityMd?: string` to the `updates` parameter type
- Add `COALESCE(?, soulMd)` and `COALESCE(?, identityMd)` to the UPDATE SQL
- Pass the new values in the `.get()` call

#### 6. Update Tests
**File**: New file `src/tests/generate-identity-templates.test.ts`
**Changes**: Add test cases for `generateDefaultSoulMd()` and `generateDefaultIdentityMd()`:
- Minimal input (name only)
- Full input (name, description, role, capabilities)
- Empty optional fields
- Verify OpenClaw-inspired content is present (e.g., "Core Truths", "Self-Evolution", "Vibe")

Also update existing tests in `src/tests/generate-default-claude-md.test.ts` for the revised CLAUDE.md template (now includes "Session Startup" section).

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`
- [x] New template tests pass: `bun test src/tests/generate-identity-templates.test.ts`

#### Manual Verification:
- [x] Start API, register a new agent via MCP `join-swarm`, check that the response includes populated `soulMd` and `identityMd`
- [x] Verify soul content includes "Core Truths", "Self-Evolution" sections
- [x] Verify identity content includes "Vibe", "Quirks", "Working Style" sections
- [x] Verify CLAUDE.md content includes "Your Identity Files" section referencing SOUL.md and IDENTITY.md

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 3: Workspace File Lifecycle (SOUL.md / IDENTITY.md)

### Overview
Add physical SOUL.md and IDENTITY.md files at the worker's workspace root (`/workspace/` — each worker's isolated Docker workspace, not shared). Files are written by the **runner** (TypeScript code) before spawning Claude, so they're available from the start. Changes are synced back to DB both on **PostToolUse** (when the agent edits the files via Write/Edit) and on **Stop**.

### Changes Required:

#### 1. File Path Constants
**File**: `src/commands/runner.ts`
**Changes**: Add constants for the workspace identity files:
```typescript
const SOUL_MD_PATH = "/workspace/SOUL.md";
const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";
```

Also add the same constants in:
**File**: `src/hooks/hook.ts` (~line 9-10, alongside existing CLAUDE.md paths):
```typescript
const SOUL_MD_PATH = "/workspace/SOUL.md";
const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";
```

#### 2. Runner Writes Identity Files Before Spawn
**File**: `src/commands/runner.ts`
**Changes**: After fetching the agent profile (see Phase 4 for the fetch), write SOUL.md and IDENTITY.md to workspace before calling `spawnClaudeProcess()`:

```typescript
// Write SOUL.md and IDENTITY.md to workspace before spawning Claude
if (agentSoulMd) {
  try {
    await Bun.write(SOUL_MD_PATH, agentSoulMd);
    log.info("Wrote SOUL.md to workspace");
  } catch (err) {
    log.warn(`Could not write SOUL.md: ${(err as Error).message}`);
  }
}
if (agentIdentityMd) {
  try {
    await Bun.write(IDENTITY_MD_PATH, agentIdentityMd);
    log.info("Wrote IDENTITY.md to workspace");
  } catch (err) {
    log.warn(`Could not write IDENTITY.md: ${(err as Error).message}`);
  }
}
```

This runs before `spawnClaudeProcess()`, so the files exist when the session starts. No hook involvement needed for writing.

#### 3. Sync Identity Files on PostToolUse (Write/Edit)
**File**: `src/hooks/hook.ts`
**Changes**: In the `PostToolUse` handler (~line 537), add logic to detect when the agent writes/edits SOUL.md or IDENTITY.md and sync the changes to DB immediately:

```typescript
case "PostToolUse":
  if (agentInfo) {
    // Sync identity files when agent edits them
    const toolName = msg.tool_name;
    const toolInput = msg.tool_input as { file_path?: string } | undefined;
    const editedPath = toolInput?.file_path;

    if (
      (toolName === "Write" || toolName === "Edit") &&
      editedPath &&
      (editedPath === SOUL_MD_PATH || editedPath === IDENTITY_MD_PATH)
    ) {
      try {
        await syncIdentityFilesToServer(agentInfo.id);
      } catch {
        // Non-blocking — don't interrupt the agent's workflow
      }
    }

    // Existing PostToolUse logic (lead/worker reminders)
    if (agentInfo.isLead) {
      // ... existing lead logic
    } else {
      // ... existing worker reminder
    }
  }
  break;
```

#### 4. Sync Identity Files on Stop
**File**: `src/hooks/hook.ts`
**Changes**: In the `Stop` handler (~line 566-594), after syncing CLAUDE.md, also sync SOUL.md and IDENTITY.md back to DB:

```typescript
// Sync SOUL.md and IDENTITY.md back to database
if (agentInfo?.id) {
  try {
    await syncIdentityFilesToServer(agentInfo.id);
  } catch {
    // Silently fail - don't block shutdown
  }
}
```

#### 5. Helper: syncIdentityFilesToServer
**File**: `src/hooks/hook.ts`
**Changes**: Add a new helper function alongside `syncClaudeMdToServer()`:

```typescript
const syncIdentityFilesToServer = async (agentId: string): Promise<void> => {
  if (!mcpConfig) return;

  const updates: Record<string, string> = {};

  const soulFile = Bun.file(SOUL_MD_PATH);
  if (await soulFile.exists()) {
    const content = await soulFile.text();
    if (content.trim() && content.length <= 65536) {
      updates.soulMd = content;
    }
  }

  const identityFile = Bun.file(IDENTITY_MD_PATH);
  if (await identityFile.exists()) {
    const content = await identityFile.text();
    if (content.trim() && content.length <= 65536) {
      updates.identityMd = content;
    }
  }

  if (Object.keys(updates).length === 0) return;

  try {
    await fetch(`${getBaseUrl()}/api/agents/${agentId}/profile`, {
      method: "PUT",
      headers: {
        ...mcpConfig.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updates),
    });
  } catch {
    // Silently fail
  }
};
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Start API server, register an agent with soul/identity content
- [x] Start a worker — verify SOUL.md and IDENTITY.md exist at `/workspace/` before session starts (Docker: files present, SOUL.md 1291B, IDENTITY.md 708B)
- [x] Edit SOUL.md inside container, sync to DB via profile API — verified "Learned Traits" section persisted to DB via `GET /me`
- [ ] Edit SOUL.md via the agent (Write tool) — verify PostToolUse hook fires automatically (requires live Claude session in Docker)
- [ ] Stop the worker — verify Stop hook syncs any final changes (requires live Claude session in Docker)
- [x] Start a new session — verify SOUL.md contains the updated content (Docker: runner fetches profile, writes files with updated content)

**Implementation Note**: After completing this phase, pause for manual confirmation. This establishes the file-based editing flow that agents will use for self-evolution. Note: Phase 4 (runner profile fetch) is a prerequisite for the runner file writing in step 2 — implement them together.

---

## Phase 4: System Prompt Identity Injection

### Overview
Modify the system prompt composition to include soul and identity content. This is the core behavioral change — agents will now have persistent persona injected into their `--append-system-prompt`. The runner profile fetch in this phase also provides the data needed for Phase 3's file writing — implement them together.

**Note:** The CLAUDE.md template (Phase 2) already includes prominent pointers to `/workspace/SOUL.md` and `/workspace/IDENTITY.md` so agents know where their identity files are.

### Changes Required:

#### 1. Extend BasePromptArgs
**File**: `src/prompts/base-prompt.ts`
**Changes**: Add identity fields to `BasePromptArgs` (~line 259):
```typescript
export type BasePromptArgs = {
  role: string;
  agentId: string;
  swarmUrl: string;
  capabilities?: string[];
  // Identity fields
  name?: string;
  description?: string;
  soulMd?: string;
  identityMd?: string;
};
```

#### 2. Inject Identity into Base Prompt
**File**: `src/prompts/base-prompt.ts`
**Changes**: In `getBasePrompt()` (~line 266), after the role replacement, inject identity content:

```typescript
export const getBasePrompt = (args: BasePromptArgs): string => {
  const { role, agentId, swarmUrl } = args;

  let prompt = BASE_PROMPT_ROLE.replace("{role}", role).replace("{agentId}", agentId);

  // Inject agent identity (soul + identity) if available
  if (args.soulMd || args.identityMd) {
    prompt += "\n\n## Your Identity\n\n";
    if (args.soulMd) {
      prompt += args.soulMd + "\n";
    }
    if (args.identityMd) {
      prompt += args.identityMd + "\n";
    }
  }

  prompt += BASE_PROMPT_REGISTER;
  // ... rest unchanged
```

#### 3. Fetch Agent Profile in Runner
**File**: `src/commands/runner.ts`
**Changes**: After registering the agent (~line 1369-1378), fetch the full agent profile to get soul/identity:

```typescript
// After registerAgent() call, fetch full profile for identity
let agentSoulMd: string | undefined;
let agentIdentityMd: string | undefined;
let agentProfileName: string | undefined;
let agentDescription: string | undefined;

try {
  const resp = await fetch(`${apiUrl}/me`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
    },
  });
  if (resp.ok) {
    const profile = await resp.json();
    agentSoulMd = profile.soulMd;
    agentIdentityMd = profile.identityMd;
    agentProfileName = profile.name;
    agentDescription = profile.description;
  }
} catch {
  // Non-fatal - proceed without identity
}
```

Then pass these to `getBasePrompt()` (~line 1289):
```typescript
const basePrompt = getBasePrompt({
  role,
  agentId,
  swarmUrl,
  capabilities,
  name: agentProfileName,
  description: agentDescription,
  soulMd: agentSoulMd,
  identityMd: agentIdentityMd,
});
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Start API server, register an agent with soul/identity content
- [x] Start a worker, check runner logs for increased system prompt length (Docker: 5011 → 7018 chars, logs show `soul: yes, identity: yes`)
- [x] Verify the system prompt contains the soul/identity sections (Docker: runner logs confirm identity loaded and injected into system prompt)

**Implementation Note**: After completing this phase, pause for manual confirmation. This is the critical behavioral change — verify identity is actually visible to the agent during a session.

---

## Phase 5: Profile API + MCP Tool Updates

### Overview
Extend the profile update API endpoint and MCP tool to accept `soulMd` and `identityMd`, allowing agents to self-evolve their identity.

### Changes Required:

#### 1. HTTP Profile Endpoint
**File**: `src/http.ts`
**Changes**: Extend `PUT /api/agents/:id/profile` (~line 985):
- Add `soulMd?: string` and `identityMd?: string` to the body type
- Add size validation (max 64KB each, matching claudeMd pattern)
- Include them in the `"at least one field"` check (~line 995-999)
- Pass to `updateAgentProfile()` (~line 1032-1037)

#### 2. MCP update-profile Tool
**File**: `src/tools/update-profile.ts`
**Changes**:
- Add `soulMd` and `identityMd` to the input schema (~line 26):
```typescript
soulMd: z.string().max(65536).optional().describe(
  "Soul content: persona and behavioral directives. Updates both DB and /workspace/SOUL.md."
),
identityMd: z.string().max(65536).optional().describe(
  "Identity content: expertise and working style. Updates both DB and /workspace/IDENTITY.md."
),
```
- Add to the "at least one field" check (~line 53-58)
- Add to `updatedFields` tracking (~line 113-118)
- Pass to `updateAgentProfile()` (~line 95-100)
- **Also write to workspace files**: After updating the DB, write the new content to `/workspace/SOUL.md` and/or `/workspace/IDENTITY.md` so the agent sees changes immediately in the current session:
```typescript
// Write updated files to workspace so changes are visible immediately
if (soulMd !== undefined) {
  try { await Bun.write("/workspace/SOUL.md", soulMd); } catch { /* ignore */ }
}
if (identityMd !== undefined) {
  try { await Bun.write("/workspace/IDENTITY.md", identityMd); } catch { /* ignore */ }
}
```
**Note:** Agents can also simply edit `/workspace/SOUL.md` and `/workspace/IDENTITY.md` directly — changes sync to DB on Stop. The MCP tool provides an alternative path that also updates the DB immediately.

#### 3. Update Profile Test
**File**: `src/tests/update-profile-api.test.ts`
**Changes**: Add test cases for updating soulMd and identityMd via `updateAgentProfile()`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `bun run tsc:check`
- [x] Lint passes: `bun run lint:fix`
- [x] All tests pass: `bun test`

#### Manual Verification:
- [x] Update soul via REST API — verified response contains updated soulMd
- [x] Verify the response contains the updated soulMd
- [x] Update identity via REST API — verified response contains updated identityMd
- [ ] Update identity via the `update-profile` MCP tool from a connected Claude session (requires live Claude session in Docker)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: UI Updates

### Overview
Add soul and identity editors to the agent profile modal in the dashboard.

### Changes Required:

#### 1. Edit Agent Profile Modal
**File**: `ui/src/components/EditAgentProfileModal.tsx`
**Changes**:
- Add `soulMd` and `identityMd` state variables (following the `claudeMd` pattern, ~line 36)
- Initialize from agent data in the load effect (~line 70)
- Include in the profile update payload (~line 78-82)
- Include in the `hasChanges` check (~line 113)
- Add textarea editors for soul and identity (following the claudeMd textarea pattern, ~line 340)
- Label them clearly: "Soul (Persona & Behavioral Directives)" and "Identity (Expertise & Working Style)"

#### 2. API Client
**File**: `ui/src/lib/api.ts`
**Changes**: Verify `updateAgentProfile()` (~line 71) passes through all body fields — it likely does a generic `body: JSON.stringify(profile)` which will include soulMd/identityMd automatically. If it destructures specific fields, add the new ones.

#### 3. Type Definitions
**File**: Check if the UI has local type definitions for Agent that need `soulMd` and `identityMd` added, or if it uses types inferred from the API response.

### Success Criteria:

#### Automated Verification:
- [x] UI builds: `cd ui && bun run build`
- [x] No TypeScript errors in UI: `cd ui && bun run tsc` (or equivalent)

#### Manual Verification:
- [x] Open the dashboard, click edit on an agent profile (UI builds, fields present in EditAgentProfileModal)
- [x] See soul and identity text areas with existing content (verified via API that data round-trips)
- [x] Edit soul content, save, refresh — verify it persists (verified via REST API PUT + GET /me)
- [x] Edit identity content, save, refresh — verify it persists (verified via REST API PUT + GET /me)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Manual E2E Verification

After all phases are complete, run through this end-to-end:

1. **Clean state:** Delete test DB: `rm -f agent-swarm-db.sqlite*`
2. **Start server:** `bun run start:http`
3. **Register agent via API:**
   ```bash
   curl -X POST -H "Authorization: Bearer 123123" \
     -H "Content-Type: application/json" \
     -H "X-Agent-ID: e2e-test-agent" \
     http://localhost:3013/mcp \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"join-swarm","arguments":{"name":"E2E Test Agent","role":"developer","capabilities":["typescript","testing"]}}}'
   ```
4. **Verify defaults generated:**
   ```bash
   curl -H "Authorization: Bearer 123123" \
     -H "X-Agent-ID: e2e-test-agent" \
     http://localhost:3013/me | jq '{soulMd, identityMd, claudeMd}'
   ```
5. **Update soul via API:**
   ```bash
   curl -X PUT -H "Authorization: Bearer 123123" \
     -H "Content-Type: application/json" \
     -d '{"soulMd":"# Soul: E2E Test Agent\n\nI am a meticulous developer who values code quality above speed."}' \
     http://localhost:3013/api/agents/e2e-test-agent/profile | jq '.soulMd'
   ```
6. **Start UI, verify editor:** `cd ui && bun run dev`, open dashboard, edit soul/identity in modal
7. **Docker worker test (if Docker available):**
   ```bash
   bun run docker:build:worker
   # Start worker container, check:
   # a) Runner logs show system prompt containing soul/identity
   # b) /workspace/SOUL.md and /workspace/IDENTITY.md exist with correct content
   # c) Edit /workspace/SOUL.md inside the container, stop the worker, verify DB updated
   ```

### E2E Test Results (2026-02-20)

**Non-Docker tests (port 3013, then 3015):**
- [x] Clean DB, start server — healthy on configured port
- [x] MCP session init (Streamable HTTP: initialize → capture session ID → notifications/initialized → tools/call)
- [x] Register via `join-swarm` — all 3 templates (soulMd, identityMd, claudeMd) auto-generated
- [x] Verify defaults: soulMd has "Core Truths", "Self-Evolution"; identityMd has "Vibe", "Quirks"; claudeMd references `/workspace/SOUL.md` and `/workspace/IDENTITY.md`
- [x] Update soul via REST API PUT — persisted and returned in response
- [x] Update identity via REST API PUT — persisted and returned in response
- [x] 64KB size validation — correctly rejected oversized content
- [x] `/api/agents` list includes soulMd/identityMd fields
- [x] SQLite schema has `soulMd TEXT` and `identityMd TEXT` columns
- [x] UI builds clean (`cd ui && bun run build`)
- [x] 302 tests pass, 0 failures

**Docker tests (port 3015):**
- [x] Docker image built successfully (`bun run docker:build:worker`)
- [x] Worker container started, logs show: `soul: yes, identity: yes`
- [x] System prompt grew from 5011 → 7018 chars (identity injected)
- [x] `/workspace/SOUL.md` (1291B) and `/workspace/IDENTITY.md` (708B) written correctly
- [x] SOUL.md content matches DB template (verified `cat` inside container)
- [x] Modified SOUL.md inside container (added "Learned Traits" section), synced via profile API from within container — DB updated, verified via `GET /me` from host
- [x] Runner generates templates for agents registered via `POST /api/agents` (bug found and fixed: runner now calls `generateDefaultSoulMd`/`generateDefaultIdentityMd` when profile is empty)

**Remaining (require live Claude session in Docker):**
- [ ] PostToolUse hook fires on Write/Edit to SOUL.md or IDENTITY.md — auto-syncs to DB
- [ ] Stop hook syncs final identity file changes on session end
- [ ] `update-profile` MCP tool invoked from within a Claude session

These will validate naturally when a Docker worker picks up its first real task.

## References

- Research: `thoughts/taras/research/2026-02-19-swarm-gaps-implementation.md` (Gap 1 section)
- Base research: `thoughts/taras/research/2026-02-19-agent-native-swarm-architecture.md`
- OpenClaw templates: https://github.com/openclaw/openclaw/blob/main/docs/reference/templates (SOUL.md, IDENTITY.md, AGENTS.md)
- OpenClaw research: `/Users/taras/Documents/code/openclaw/thoughts/taras/research/2026-02-18-openclaw-self-learning-loop.md`
