---
date: 2026-04-23T00:00:00Z
topic: "Provider Traits Refactor"
status: completed
author: Gerard + Claude
---

# Provider Traits Refactor

## Overview

Replace all `provider === "devin"` / `isDevin` string-matching in prompt assembly with a `traits` object on `ProviderAdapter`. This makes the branching semantic ("does this provider have MCP?") rather than nominal ("is this Devin?"), so future remote providers get correct behavior automatically.

## Current State

- `ProviderAdapter` interface has `readonly name: string` but no behavioral metadata
- 9 branch sites in `base-prompt.ts` and `runner.ts` check `provider === "devin"` to skip MCP tools, local filesystem paths, identity files, services, artifacts, etc.
- These checks are semantically about "remote/independent provider" but syntactically coupled to the string `"devin"`

## Desired End State

- `ProviderAdapter` interface has `readonly traits: ProviderTraits` with `hasMcp` and `hasLocalEnvironment` booleans
- All 4 adapters declare their traits
- `BasePromptArgs` accepts `traits` instead of `provider` string for branching decisions
- All 9 branch sites in `base-prompt.ts` use `traits.hasMcp` / `traits.hasLocalEnvironment` instead of `isDevin`
- Runner passes `adapter.traits` instead of string-matching `adapter.name === "devin"`
- Tests updated to use traits-based args
- No behavioral change — prompts generated are identical before and after

## Out of Scope

- Changing truly Devin-specific code (adapter factory, credential mapping, entrypoint validation)
- Changing non-Devin branching (`adapter.name !== "claude"` for structured output fallback)
- Renaming session templates (they can keep "devin" in their names — that's the provider, not a capability check)
- Docker entrypoint changes

---

## Phase 1: Add `ProviderTraits` to the interface and all adapters

**Goal:** Define `ProviderTraits` type and add `readonly traits` to `ProviderAdapter`. Implement on all 4 adapters.

### Files to modify:
- `src/providers/types.ts` — Add `ProviderTraits` interface and `traits` to `ProviderAdapter`
- `src/providers/claude-adapter.ts:544` — Add `readonly traits`
- `src/providers/codex-adapter.ts:735` — Same
- `src/providers/pi-mono-adapter.ts:385` — Same
- `src/providers/devin-adapter.ts:682` — Add `readonly traits` with both `false`

### Changes:

In `src/providers/types.ts`, add before `ProviderAdapter`:
```ts
/** Behavioral traits that govern prompt assembly and feature gating. */
export interface ProviderTraits {
  /** Provider can call MCP tools (store-progress, task-action, skills, slack-reply, etc.) */
  hasMcp: boolean;
  /** Provider runs in the local Docker container with /workspace, identity files, agent-fs, PM2, etc. */
  hasLocalEnvironment: boolean;
}
```

Add to `ProviderAdapter`:
```ts
readonly traits: ProviderTraits;
```

Each adapter gets one line after `readonly name`:
```ts
readonly traits = { hasMcp: true, hasLocalEnvironment: true };   // claude, codex, pi
readonly traits = { hasMcp: false, hasLocalEnvironment: false };  // devin
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] All existing tests pass: `bun test`

#### Manual Verification:
- [ ] Confirm each adapter file has the `traits` property

---

## Phase 2: Thread traits through `BasePromptArgs` and replace branching in `base-prompt.ts`

**Goal:** Replace the `provider` string in `BasePromptArgs` with `traits: ProviderTraits`, and replace all `isDevin` checks with trait-based checks.

### Files to modify:
- `src/prompts/base-prompt.ts` — Update `BasePromptArgs` type and all branch sites

### Changes:

1. In `BasePromptArgs`, replace:
   ```ts
   /** Provider adapter name ("claude", "codex", "devin", "pi"). Gates provider-specific prompt assembly. */
   provider?: string;
   ```
   with:
   ```ts
   /** Behavioral traits from the provider adapter. Gates feature-specific prompt assembly. */
   traits?: ProviderTraits;
   ```
   Add the import for `ProviderTraits`.

2. Replace `const isDevin = args.provider === "devin";` with:
   ```ts
   const hasMcp = args.traits?.hasMcp !== false;
   const hasLocalEnv = args.traits?.hasLocalEnvironment !== false;
   ```
   Default to `true` (backwards-compatible: if traits are undefined, behave like a local provider).

3. Replace each branch site:

   | Line | Old guard | New guard | Rationale |
   |------|-----------|-----------|-----------|
   | 65-66 | `if (isDevin)` composite selection | `if (!hasMcp)` | Devin template omits MCP tools |
   | 75 | `!isDevin` for Slack | `hasMcp` | Slack needs MCP `slack-reply` |
   | 84 | `if (isDevin)` identity | `if (!hasLocalEnv)` | Identity files are `/workspace` artifacts |
   | 116 | `!isDevin` for skills | `hasMcp` | Skills need MCP `Skill` tool |
   | 122 | `!isDevin` for MCP servers | `hasMcp` | MCP servers need MCP connection |
   | 135, 145 | `if (isDevin)` repo context path | `if (!hasLocalEnv)` | Clone path is Docker-specific |
   | 190 | `if (!isDevin)` conditional suffix | `if (hasLocalEnv)` | agent-fs, services, artifacts, truncatable sections all need local env |

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] All existing tests still pass: `bun test`

#### Manual Verification:
- [ ] Read through `base-prompt.ts` and confirm no remaining `isDevin` or `provider === "devin"` checks

**Implementation Note**: At this point both `provider` and `traits` work (traits takes precedence). Tests still pass with old `provider` field until Phase 4 migrates them.

---

## Phase 3: Update runner.ts to pass traits instead of string-matching

**Goal:** Replace `isDevinProvider` in `runner.ts` with `adapter.traits` checks.

### Files to modify:
- `src/commands/runner.ts` — Lines 2284-2303

### Changes:

Replace:
```ts
const isDevinProvider = adapter.name === "devin";
const buildSystemPrompt = async () => {
  return getBasePrompt({
    ...
    provider: adapter.name,
    soulMd: isDevinProvider ? undefined : agentSoulMd,
    ...
  });
};
```

With:
```ts
const { traits } = adapter;
const buildSystemPrompt = async () => {
  return getBasePrompt({
    ...
    traits,
    soulMd: traits.hasLocalEnvironment ? agentSoulMd : undefined,
    identityMd: traits.hasLocalEnvironment ? agentIdentityMd : undefined,
    toolsMd: traits.hasLocalEnvironment ? agentToolsMd : undefined,
    claudeMd: traits.hasLocalEnvironment ? agentClaudeMd : undefined,
    ...
    skillsSummary: traits.hasMcp ? agentSkillsSummary : undefined,
    mcpServersSummary: traits.hasMcp ? agentMcpServersSummary : undefined,
  });
};
```

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] All tests pass: `bun test`

#### Manual Verification:
- [ ] No remaining `isDevinProvider` in runner.ts
- [ ] `adapter.name` is still used where appropriate (codex OAuth line 1606, logging lines 1838/1865)

---

## Phase 4: Migrate tests to use traits instead of `provider` string

**Goal:** Update test code to use `traits` in `BasePromptArgs` instead of `provider: "devin"`.

### Files to modify:
- `src/tests/base-prompt.test.ts`

### Changes:

1. Import `ProviderTraits` from `../providers/types`

2. Add trait constants at top of file:
   ```ts
   const localTraits: ProviderTraits = { hasMcp: true, hasLocalEnvironment: true };
   const remoteTraits: ProviderTraits = { hasMcp: false, hasLocalEnvironment: false };
   ```

3. Replace `devinArgs`:
   ```ts
   const remoteProviderArgs: BasePromptArgs = {
     ...minimalArgs,
     traits: remoteTraits,
   };
   ```

4. Update all test references from `devinArgs` to `remoteProviderArgs`

5. Rename describe blocks from "Devin provider" to "remote provider" to reflect the semantic shift

6. Update `non-Devin providers unaffected` tests to use `traits: localTraits` explicitly

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] All tests pass: `bun test`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] No remaining `provider: "devin"` in test file
- [ ] Test descriptions say "remote provider" not "Devin"

---

## Phase 5: Remove deprecated `provider` field from `BasePromptArgs`

**Goal:** Clean up — remove the `provider` field from `BasePromptArgs` now that all consumers use `traits`.

### Files to modify:
- `src/prompts/base-prompt.ts` — Remove `provider` from `BasePromptArgs` type

### Changes:

1. Remove the `provider?: string` field from `BasePromptArgs`
2. Verify no remaining references to `args.provider` in `base-prompt.ts`

### Success Criteria:

#### Automated Verification:
- [ ] Type check passes: `bun run tsc:check`
- [ ] All tests pass: `bun test`
- [ ] Lint passes: `bun run lint:fix`

#### Manual Verification:
- [ ] `BasePromptArgs` no longer has `provider` field
- [ ] Grep for `args.provider` in `base-prompt.ts` returns nothing

**Implementation Note**: Safe because Phase 2 already switched all branching to traits, and Phases 3-4 migrated all callers.

---

## Risk Assessment

- **Low risk**: Pure refactor — prompt output should be byte-identical before and after for all providers
- **Test coverage**: Existing tests cover all branch sites (exclusions, inclusions, identity, repo context, capabilities, truncation)
- **Backwards compatibility**: Phase 2 defaults traits to `true` when undefined, so any caller that hasn't been updated yet behaves like a local provider (safe default)
