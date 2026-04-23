---
date: 2026-04-23T00:00:00Z
topic: "Provider-Aware System Prompts for Remote Agents (Devin)"
status: draft
branch: feat/devin-harness-provider
---

# Plan: Provider-Aware System Prompts for Remote Agents (Devin)

## Problem

The system prompt pipeline (`base-prompt.ts` -> `session-templates.ts` -> `runner.ts`) was built for local Claude Code agents. It assembles a single prompt from 12 template blocks, identity files, and conditional sections — then delivers it identically to all providers. For Devin (a fully remote agent with no MCP connection, no Docker container, no local filesystem), the resulting prompt contains many irrelevant or misleading sections:

| Section | Template ID | Problem for Devin |
|---|---|---|
| `join-swarm` instruction | `system.agent.register` | Devin has no MCP — can't call `join-swarm` |
| Worker tools (`store-progress`, `task-action`, `read-messages`) | `system.agent.worker` | MCP tools unavailable to Devin |
| `/workspace` filesystem, shared dirs, memory dirs | `system.agent.filesystem` | Devin has its own workspace, not our Docker layout |
| "How You Are Built" (hooks, runner, MCP) | `system.agent.self_awareness` | Describes Claude Code internals, not Devin |
| Context window management (`context-mode` tools) | `system.agent.context_mode` | MCP tools unavailable |
| System packages (Ubuntu, apt-get) | `system.agent.system` | Wrong environment description |
| VCS CLI tools (gh/glab table) | `system.agent.system` | Devin has its own git integration |
| External Swarm / Service Registry / PM2 | `system.agent.services` | Not applicable |
| Identity files (SOUL.md, IDENTITY.md, TOOLS.md) | `base-prompt.ts` identity section | Self-evolution model doesn't apply; should be a simpler Devin-specific identity |
| Agent CLAUDE.md + TOOLS.md truncatable sections | `base-prompt.ts` truncatable | Reference `/workspace` files that don't exist |
| Code Quality & Repository Guidelines | `system.agent.code_quality` | Optional — Devin already understands CI/PR workflows natively |

The current `devin-playbook.md` is a dump of the full generic prompt, sent verbatim as a Devin playbook. This wastes Devin's context with irrelevant instructions and can confuse it (references to tools and paths that don't exist).

---

## Goal

Make the prompt assembly pipeline **provider-aware** so that remote providers like Devin get a tailored system prompt that only contains relevant sections, while preserving the existing behavior for Claude, Codex, and pi-mono.

### Design Principles

1. **Minimal blast radius** — Don't restructure the entire template system. Thread `provider` through the existing pipeline and branch at the composite template level.
2. **Composition over conditions** — Create a new Devin composite template that includes only relevant blocks, rather than adding `if (provider !== "devin")` checks throughout `base-prompt.ts`.
3. **New Devin-specific blocks where needed** — Where Claude-specific content must be replaced (not just removed), create new template blocks (e.g., `system.agent.worker.devin` for task completion instructions).
4. **Preserve customizability** — The DB template override system should still work for Devin templates, so operators can customize the Devin prompt without code changes.

---

## Architecture

### Current prompt data flow

```
runner.ts:2284 buildSystemPrompt()
  -> getBasePrompt({ role, agentId, capabilities, soulMd, identityMd, ... })
    -> resolveTemplateAsync("system.session.worker", vars)
      -> expands {{@template[system.agent.role]}}
      -> expands {{@template[system.agent.register]}}
      -> expands {{@template[system.agent.worker]}}
      -> expands {{@template[system.agent.filesystem]}}
      -> expands {{@template[system.agent.self_awareness]}}
      -> expands {{@template[system.agent.context_mode]}}
      -> expands {{@template[system.agent.system]}}
      -> expands {{@template[system.agent.code_quality]}}
    -> appends identity (SOUL.md + IDENTITY.md)
    -> appends skills, MCP servers
    -> appends repo context
    -> appends truncatable (CLAUDE.md + TOOLS.md)
    -> appends conditional suffix (agent_fs, services, artifacts, capabilities)
  -> combines with additional system prompt
  -> ProviderSessionConfig.systemPrompt
    -> DevinAdapter.createSession() -> playbook body
```

### Proposed prompt data flow

```
runner.ts buildSystemPrompt()
  -> getBasePrompt({ ..., provider: "devin" })            <-- NEW: provider field
    -> compositeEventType = "system.session.worker.devin"  <-- NEW: provider-specific composite
      -> expands {{@template[system.agent.role]}}           (shared, still relevant)
      -> expands {{@template[system.agent.worker.devin]}}   <-- NEW: Devin-specific worker block
      -> expands {{@template[system.agent.code_quality]}}   (shared, optional, keep)
    -> appends Devin identity (simplified, no SOUL.md/IDENTITY.md self-evolution)
    -> appends repo context (shared, still relevant)
    -> skips: truncatable CLAUDE.md/TOOLS.md, conditional suffix
```

---

## Phases

### Phase 1: Thread `provider` through the prompt pipeline

**Files:** `src/prompts/base-prompt.ts`, `src/commands/runner.ts`

1. Add `provider?: string` to `BasePromptArgs` (default `undefined` = current behavior).

2. In `runner.ts:2284` `buildSystemPrompt()`, pass `provider: adapter.name` to `getBasePrompt()`:
   ```ts
   return getBasePrompt({
     ...existingArgs,
     provider: adapter.name,  // "claude" | "codex" | "devin" | "pi"
   });
   ```

3. In `getBasePrompt()`, use `provider` to select the composite template:
   ```ts
   const isDevin = args.provider === "devin";
   let compositeEventType: string;
   if (isDevin) {
     compositeEventType = role === "lead"
       ? "system.session.lead.devin"
       : "system.session.worker.devin";
   } else {
     compositeEventType = role === "lead"
       ? "system.session.lead"
       : "system.session.worker";
   }
   ```

4. Gate the identity, truncatable, and conditional-suffix sections on `!isDevin` (or handle Devin identity separately — see Phase 3).

**Tests:** Update `src/tests/base-prompt.test.ts` — add tests that `provider: "devin"` selects the Devin composite and omits irrelevant sections.

---

### Phase 2: Create Devin-specific templates

**File:** `src/prompts/session-templates.ts`

#### 2a. `system.agent.worker.devin` — Devin worker instructions

Replaces `system.agent.worker` (which references `store-progress`, `task-action`, `read-messages`). Content:

```markdown
As a worker agent of the swarm, you are responsible for executing tasks assigned by the lead agent.

- Each worker focuses on specific tasks or objectives, contributing to the overall goals of the swarm.
- Workers MUST report their progress back to the lead and collaborate with other workers as needed.

#### How Tasks Work

You receive tasks via the session prompt. Each task has a description of what needs to be done.

#### Completing Tasks

When you finish a task:
- Provide a clear summary of what you accomplished in your final message
- If you created a PR, include the PR URL
- If you encountered blockers, explain what blocked you and what you tried

Your output is captured automatically -- focus on doing the work and communicating results clearly.
```

This removes references to MCP tools (store-progress, task-action, read-messages) and explains the Devin interaction model where output is captured by the adapter's polling loop.

#### 2b. `system.session.worker.devin` — Devin worker composite

```
{{@template[system.agent.role]}}
{{@template[system.agent.worker.devin]}}
```

**Excluded from the composite:**
- `system.agent.register` — no MCP, can't join-swarm
- `system.agent.filesystem` — wrong filesystem layout, memory dirs, shared workspace
- `system.agent.self_awareness` — describes Claude Code internals
- `system.agent.context_mode` — MCP context-mode tools not available
- `system.agent.system` — wrong package list, VCS tools table
- `system.agent.code_quality` — Devin already understands PR/merge workflows natively; repo-specific rules come via repo context

**Kept:**
- `system.agent.role` — role + agentId identification is still useful
- `system.agent.worker.devin` — Devin-specific worker instructions

#### 2c. `system.session.lead.devin` — (future, optional)

For now, Devin is only used as a worker. We can skip the lead composite. If `role === "lead" && provider === "devin"`, fall back to the generic lead composite or throw an error.

**Tests:** Add tests that the Devin composites resolve correctly and contain expected content / don't contain excluded content.

---

### Phase 3: Devin identity handling in `base-prompt.ts`

**File:** `src/prompts/base-prompt.ts`

Currently, `base-prompt.ts:74-90` injects SOUL.md + IDENTITY.md as the "Your Identity" section. For Devin, we need a simpler identity that doesn't reference self-evolution, `/workspace` files, or session persistence.

**Approach:** When `provider === "devin"`, replace the identity section with a Devin-specific block:

```ts
if (isDevin) {
  // Simplified identity for Devin -- no self-evolution, no workspace files
  prompt += "\n\n## Your Identity\n\n";
  if (args.name) {
    prompt += `**Name:** ${args.name}\n`;
    if (args.description) {
      prompt += `**Description:** ${args.description}\n`;
    }
    prompt += "\n";
  }
  prompt += `You are part of an agent swarm managed by the Desplega platform. `;
  prompt += `You receive tasks from the swarm's lead agent and execute them independently. `;
  prompt += `Focus on quality work and clear communication of results.\n`;
} else {
  // Existing identity injection (SOUL.md + IDENTITY.md)
  ...existing code...
}
```

**Also skip for Devin:**
- Slack instructions (`system.agent.worker.slack`) — Devin can't call `slack-reply` MCP tool. Add `&& !isDevin` guard to the Slack injection block at `base-prompt.ts:66-72`.
- Installed Skills section (lines 92-96) — these are MCP skills, not available to Devin
- Installed MCP Servers section (lines 98-101) — Devin has no MCP
- Truncatable CLAUDE.md/TOOLS.md sections (lines 196-220) — reference `/workspace` files
- Conditional suffix: services, artifacts, agent_fs, capabilities list (lines 156-188)

**Keep for Devin:**
- Repository Context section (lines 103-154) — repo CLAUDE.md and guidelines ARE relevant when Devin works on a repo. However, strip the `clonePath` constraint text ("These instructions apply ONLY when working within...") since Devin's workspace layout differs from Docker agents.

**Tests:** Verify Devin prompt includes repo context but excludes skills, MCP servers, CLAUDE.md/TOOLS.md truncatables, and conditional suffix.

---

### Phase 4: Adjust runner identity field handling for Devin

**File:** `src/commands/runner.ts`

Currently, `runner.ts:2441-2611` fetches the agent profile and populates `agentSoulMd`, `agentIdentityMd`, `agentClaudeMd`, `agentToolsMd` from the DB or template defaults. For Devin, this work is wasted — none of these files are used in the Devin prompt.

**Approach:** In `buildSystemPrompt()` at line 2284, when `adapter.name === "devin"`, pass `undefined` for the identity fields:

```ts
const isDevin = adapter.name === "devin";
const buildSystemPrompt = async () => {
  return getBasePrompt({
    role,
    agentId,
    swarmUrl,
    capabilities,
    provider: adapter.name,
    // For Devin, skip identity files -- they reference /workspace and self-evolution
    name: agentProfileName,
    description: agentDescription,
    soulMd: isDevin ? undefined : agentSoulMd,
    identityMd: isDevin ? undefined : agentIdentityMd,
    toolsMd: isDevin ? undefined : agentToolsMd,
    claudeMd: isDevin ? undefined : agentClaudeMd,
    repoContext: currentRepoContext,
    slackContext: currentTaskSlackContext,
    skillsSummary: isDevin ? undefined : agentSkillsSummary,
    mcpServersSummary: isDevin ? undefined : agentMcpServersSummary,
  });
};
```

This is belt-and-suspenders — Phase 3 already skips these sections in `base-prompt.ts`, but not passing them makes the intent explicit and avoids edge cases.

---

### Phase 5: Capability adjustment for Devin workers

**File:** `.env.docker-devin` (config only, no code changes)

Since Devin has no MCP connection, most capabilities are meaningless. The capability list in the prompt ("Capabilities enabled for this agent: core, task-pool, messaging, ...") suggests features that don't actually work.

**Approach:** Document recommended `CAPABILITIES` for Devin workers:

```bash
# .env.docker-devin
CAPABILITIES=core
```

No code changes needed — just update `.env.docker-devin` and documentation. The conditional suffix in Phase 3 will skip the capabilities listing entirely for Devin anyway.

---

## Summary of changes by file

| File | Change |
|---|---|
| `src/prompts/base-prompt.ts` | Add `provider` to `BasePromptArgs`. Branch composite selection, identity, and conditional sections on `isDevin`. |
| `src/prompts/session-templates.ts` | Register `system.agent.worker.devin`, `system.session.worker.devin`. |
| `src/commands/runner.ts` | Pass `provider: adapter.name` to `buildSystemPrompt()`. Skip identity fields for Devin. |
| `src/tests/base-prompt.test.ts` | Tests for Devin composite selection, Devin identity handling, section inclusion/exclusion. |
| `.env.docker-devin` | Set `CAPABILITIES=core` (documentation/config only). |

---

## What this does NOT change

- **Template registry / resolver** — No changes to `registry.ts` or `resolver.ts`. Devin templates use the same registry and DB-override mechanism.
- **Devin adapter** — No changes to `devin-adapter.ts`. It already converts `config.systemPrompt` to a playbook correctly. The fix is upstream in what goes INTO that string.
- **Other providers** — Claude, Codex, pi-mono are unaffected. The `provider` field defaults to `undefined`, which preserves the existing code path.
- **Capability system internals** — No structural changes to how capabilities work. Just a recommended config change for Devin.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Devin templates diverge from generic ones, causing maintenance burden | Keep Devin composites small (only 3 blocks). Shared blocks (`system.agent.role`, `system.agent.code_quality`) are reused, not copied. |
| Future providers also need customization | The `provider` field in `BasePromptArgs` is generic. Adding another composite (e.g., `system.session.worker.gemini`) follows the same pattern. |
| Devin prompt is too sparse and misses important context | Start with the minimal set (role + worker instructions + code quality + repo context + identity). Iterate based on Devin task quality. |
| DB template overrides might target the wrong template IDs | Document the Devin template IDs clearly. The resolver falls back to code defaults if DB overrides don't exist. |

---

## Open questions

1. **Should `system.agent.code_quality` be included for Devin?** It's general PR/merge guidance that could help, but Devin might already know this. Included for now — easy to remove from the composite.

2. **Slack context for Devin workers?** Currently the Slack template (`system.agent.worker.slack`) is injected when a task has Slack context. Should Devin get Slack instructions? Probably not — it can't update Slack threads via MCP. Skip for now.

3. **Repository context for Devin?** Yes — when Devin works on a repo that has guidelines (PR checks, merge policy), it should know about them. Keep.

4. **Should we create a `system.agent.devin.identity` template instead of inline code?** Could go either way. Inline in `base-prompt.ts` is simpler for now. If we later need per-agent identity customization for Devin, we can extract it to a template.

5. **Lead role for Devin?** Currently out of scope. Devin is worker-only. Add a runtime guard (throw or warn) when `role === "lead" && provider === "devin"`.

6. **Should `SYSTEM_PROMPT` / `SYSTEM_PROMPT_FILE` env vars be respected for Devin?** Currently the `additionalSystemPrompt` is appended unconditionally at `runner.ts:2336`. This could be useful for operator-injected Devin instructions, but could also inject Claude-specific content. Keep for now — operators can control this via env vars.

---

## Review findings (post-review amendments)

The following issues were identified during plan review and incorporated above:

1. **Slack context must be gated** — The Slack injection at `base-prompt.ts:66-72` will inject MCP tool references (`slack-reply`) for Devin workers on Slack-originated tasks. Fixed: added explicit `!isDevin` guard to Phase 3's "Also skip" list.

2. **Repo context clone path** — The `clonePath` constraint text ("These instructions apply ONLY when working within `/workspace/repos/...`") is wrong for Devin. Fixed: Phase 3 now strips the path constraint for Devin while keeping the repo CLAUDE.md content and guidelines.

3. **Task output flow needs verification** — The proposed Devin worker template says "output is captured automatically." This depends on `DevinSession.handleTerminalSuccess()` correctly extracting `lastStructuredOutput` or session messages and passing them as `result.output` to the runner. The runner's `ensureTaskStatus()` fallback path for non-Claude adapters should be verified during implementation. If the output capture path is broken, the worker template's claim is misleading.

4. **Prompt may be too sparse** — The Devin composite is only 3 template blocks plus a short identity. Consider adding a `system.agent.devin.guidelines` template with Devin-specific operational guidance (git commit conventions, what NOT to try, communication format expectations). This can be iterated post-launch based on Devin task quality.

5. **Deployment ordering** — The API server and worker must both be redeployed with the new code for HTTP template resolution to work cleanly. If only the worker is updated, the HTTP resolver on the old API server won't know about `system.session.worker.devin`, but the worker's local fallback will still work. Document this in the deployment notes.
