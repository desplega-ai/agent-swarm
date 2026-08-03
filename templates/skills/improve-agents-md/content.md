# improve-agents-md

Progressively improve (or bootstrap from scratch) a project's agent-instruction file. Works on both `AGENTS.md` (vendor-neutral convention from OpenAI Codex, also read by Cursor, Claude Code, and others) and `CLAUDE.md` (Claude-specific). Keeps one canonical file on disk and symlinks the other, so every agent reads the same source of truth.

## When to Use

- User invokes `/improve-agents-md` (or `/improve-claude-md` pointed here)
- User asks you to "clean up", "shorten", "audit", or "rewrite" their CLAUDE.md / AGENTS.md
- User complains that Claude (or another agent) keeps ignoring their project rules
- User is about to onboard a new agent and wants to check their instructions are any good
- No AGENTS.md / CLAUDE.md exists and the user wants to set one up properly

## The Core Problem

Claude Code (and most other agents) inject the project agent-file with a system reminder that says:

> "this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task."

So the agent will **ignore parts it deems irrelevant**. The more content that isn't applicable to the current task, the more likely the agent is to ignore the entire file — including the parts that matter right now. Long, undifferentiated agent files are self-defeating.

Two levers fix this:

1. **Cut ruthlessly.** Anything a linter, formatter, or pre-commit hook can enforce does not belong here. Anything discoverable from existing code patterns (LLMs are in-context learners) does not belong here. Anything vague ("write clean code", "follow best practices") does not belong here.
2. **Wrap conditionally.** Domain-specific guidance gets wrapped in `<important if="...">` blocks with narrow, specific conditions. This piggybacks on the same XML tag pattern Claude Code uses in its own system prompt, giving the model an explicit relevance signal that cuts through the "may or may not be relevant" framing.

The result is a short file where foundational context is always visible and domain guidance only "lights up" when it matches the task at hand.

## File Resolution: which file is canonical?

The skill runs inside Claude Code, so the canonical on-disk file is `CLAUDE.md`. `AGENTS.md` exists as a symlink pointing to `CLAUDE.md` so vendor-neutral agents (Codex, Cursor, Copilot workspace) read the same source of truth.

Resolution logic at the start of every run:

1. Check for `CLAUDE.md` and `AGENTS.md` at the repo root (and in subdirectory if the user invokes from one).
2. Branch on what's present:
   - **Only `CLAUDE.md`** → operate on it; at the end, offer to create `AGENTS.md` as a symlink → `CLAUDE.md`.
   - **Only `AGENTS.md`** (real file, not a symlink) → offer to rename it to `CLAUDE.md` and create `AGENTS.md` → `CLAUDE.md` symlink. If user declines the rename, edit `AGENTS.md` directly.
   - **Both exist, one is a symlink** → edit the real file; leave the symlink alone.
   - **Both exist, both are real files** → this is a drift bug. Use **AskUserQuestion** to ask which one is canonical; offer to replace the other with a symlink after the edit.
   - **Neither exists** → use **AskUserQuestion**: 1. Bootstrap a new `CLAUDE.md` from the codebase, 2. Abort.

Always use `ls -la` (or equivalent) to detect symlinks; never assume from the filename.

## Interactive Flow

This skill is **progressive**, not one-shot. Use **AskUserQuestion** at decision points so the user stays in control. The flow below is the default; skip steps if the input file is already clean or the user asks to go faster.

### Step 1 — Resolve the target file

Follow the resolution logic above. State clearly which file you'll be editing and why.

### Step 2 — Read and categorize

Read the full file. Categorize every top-level section into one of:

| Category | Examples | Treatment |
|---|---|---|
| **Foundational (always relevant)** | project identity (1 sentence), project map (directory listing), tech stack (1-2 lines) | Leave bare at top. |
| **Commands** | build/test/lint/dev commands | Wrap in a single `<important if="you need to run commands to build, test, lint, or generate code">` block. Keep **all** commands. |
| **Conditional rule** | "use Zod for request validation", "API routes go in X" | Wrap in its **own** `<important if>` block with a narrow trigger. |
| **Domain section** | testing setup, state management, i18n, auth | Wrap in one `<important if>` per section. |
| **Lint/formatter territory** | camelCase, `const` over `let`, strict equality, JSDoc | **Delete.** Suggest a pre-commit hook instead. |
| **Vague exhortation** | "follow best practices", "leverage the X agent", "think carefully" | **Delete.** |
| **Stale code snippet** | 20-line example of a component | **Delete.** Replace with a file path reference (`see src/utils/example.ts`). |

### Step 3 — Propose cuts

Before rewriting, use **AskUserQuestion** to confirm the deletions that might be controversial. Don't ask about every cut — only the ones where reasonable people could disagree. Batch them into a single question with a multi-select list:

Example:
> "I'd like to drop the following from your CLAUDE.md because they're either linter territory or too vague to act on. Which of these are you OK losing?"
>
> - [ ] camelCase / PascalCase rules (linter territory)
> - [ ] "Write JSDoc for all public functions" (linter can enforce, also stale)
> - [ ] "Follow clean code principles" (too vague)
> - [ ] Keep all of them anyway

Skip this step if nothing controversial is being cut.

### Step 4 — Propose the new structure

Show the user the proposed section list with their `<important if>` conditions — not the full rewrite yet, just the outline. This is cheap and catches disagreements before you do the full rewrite.

Use **AskUserQuestion** to confirm, with options like:
- "Looks good — rewrite it"
- "Change some conditions" (collect which)
- "Add a section I'm missing" (collect which)

### Step 5 — Snapshot the original

Before writing anything, copy the current file so you can compute before/after metrics and so the user has a rollback:

```bash
cp CLAUDE.md /tmp/CLAUDE.md.before-$(date +%s)
```

Remember the snapshot path — you'll need it in Step 7.

### Step 6 — Rewrite and diff

Write the new file. Show the user a concise diff summary (sections added / removed / reworded). Don't dump the full file into chat — they can read it on disk.

### Step 7 — Report metrics

Compute and show a before/after comparison. The four numbers that matter:

| Metric | How to compute |
|---|---|
| **Chars** | `wc -c <file>` |
| **Lines** | `wc -l <file>` |
| **KB** | `ls -lk <file>` (or `du -k <file>`) |
| **Tokens (est.)** | `chars / 4` — rough English heuristic. Good enough to show direction; don't over-invest in precision. |

Run it for both `before` (the `/tmp/...` snapshot) and `after` (the rewritten file). Present as a compact table:

```
                  before      after       Δ
chars             8,412       3,104       −63%
lines               247          92       −63%
KB                  8.2         3.0       −63%
tokens (est.)     2,103         776       −63%
```

One-shot bash helper (adjust paths):

```bash
metrics() {
  local f=$1
  local chars=$(wc -c < "$f" | tr -d ' ')
  local lines=$(wc -l < "$f" | tr -d ' ')
  local kb=$(awk "BEGIN {printf \"%.1f\", $chars/1024}")
  local tokens=$((chars / 4))
  printf "%s\tchars=%s lines=%s kb=%s tokens~%s\n" "$f" "$chars" "$lines" "$kb" "$tokens"
}
metrics /tmp/CLAUDE.md.before-XXXXX
metrics CLAUDE.md
```

If the `after` file isn't meaningfully shorter (say, <10% reduction) *and* the user came in wanting a cleanup, that's a signal you didn't cut aggressively enough — consider a second pass before finalizing. If it got **longer**, you probably added invented rules; reread your output against the "What Not to Do" list.

#### Verdict thresholds

Label the `after` file so the user has a one-word takeaway. Tokens are primary; lines/chars are secondary signals.

| Tokens (est.) | Verdict | What it means |
|---|---|---|
| **< 500** | Lean ✓ | Foundational + a few focused `<important if>` blocks. Target for most projects. |
| **500 – 1,000** | Good | Healthy for mid-sized projects. Still fully attended-to by the model. |
| **1,000 – 2,000** | Fat ⚠ | Almost certainly has linter territory, stale snippets, or grouped rules without narrow triggers. Cut harder. |
| **> 2,000** | Bloated ✗ | Most of it will be ignored under "may or may not be relevant". Major rewrite warranted. |

Caveats to apply with judgment, not rigidly:

- **Monorepo root files legitimately run larger** than per-package ones. A root file covering many distinct domains may land in "Fat" without being unhealthy.
- **Well-tagged files pay a lower effective cost**. A 1,500-token file where most content is scoped by narrow `<important if>` triggers is healthier than a 900-token file of bare prose — the model only "spends attention" on blocks whose condition matches.
- **Lines-to-sections ratio is a secondary smell**: 300 lines across 25 blocks is fine; 300 lines across 3 blocks is a rewrite.

Report the verdict alongside the before/after table so the user sees direction + magnitude + label in one glance.

### Step 8 — Symlink

Offer to create the companion symlink if it doesn't exist:

```bash
ln -s CLAUDE.md AGENTS.md   # from repo root
```

Verify with `ls -la CLAUDE.md AGENTS.md` that the symlink resolves to a real file.

### Step 9 — Offer follow-ups

Use **AskUserQuestion** to offer:
- "Open the result in file-review so I can leave comments" (`/file-review:file-review`)
- "Also scan subdirectory CLAUDE.md files in this repo"
- "Done"

## Principles

### 1. Foundational context stays bare, domain guidance gets wrapped

If it's relevant to 90%+ of tasks, leave it as plain markdown at the top. If it's relevant to a specific kind of work, wrap it in `<important if>`.

### 2. Conditions must be specific and targeted

**Bad — one broad condition swallowing everything:**

```
<important if="you are writing or modifying any code">
- Use absolute imports
- Use functional components
- Use camelCase filenames
</important>
```

**Good — each rule gets its own narrow trigger:**

```
<important if="you are adding or modifying imports">
- Use `@/` absolute imports (see tsconfig.json for path aliases)
- Avoid default exports except in route files
</important>

<important if="you are creating new components">
- Use functional components with explicit prop interfaces
</important>

<important if="you are creating new files or directories">
- Use camelCase for file and directory names
</important>
```

The whole point of the mechanism is precision. A condition that matches "anytime you write code" is no signal at all.

### 3. Keep it inline — no progressive sharding

Do not shard the file into separate referenced docs that require the agent to make extra tool calls to discover — unless the extra content is genuinely verbose (say, >200 lines) and only rarely relevant. `<important if>` blocks are the progressive-disclosure mechanism; they make everything visible but conditionally weighted.

### 4. Less is more

Frontier models can reliably follow a few hundred instructions; Claude Code's own system prompt and tools already spend ~50 of that budget. Your file should be lean.

- Cut anything a linter, formatter, or hook can enforce.
- Cut anything the agent can discover from existing code patterns.
- Cut code snippets — they go stale. Reference a file path instead.
- Cut vague exhortations.

### 5. Keep all commands

Commands are the one section where completeness beats brevity. The agent needs to know what's available even if a command is used rarely. Keep every command from the original; you may drop redundant descriptions, not the command itself.

### 6. Explain the "why" on anything non-obvious

If a rule isn't self-explanatory, add a short reason. `Use prismaMock from packages/db/test` is clearer as `Use prismaMock from packages/db/test — real DB connections in tests flake on CI`. The agent uses the reason to make better judgment calls on edge cases.

## Output Structure

Target layout when rewriting. Use this as a skeleton:

```markdown
# CLAUDE.md

[one-line project identity — what it is, what it's built with]

## Project map

[directory listing with brief descriptions — keep bare]

<important if="you need to run commands to build, test, lint, or generate code">

[commands table — ALL commands from the original]

</important>

<important if="<specific trigger for rule 1>">

[rule 1]

</important>

<important if="<specific trigger for rule 2>">

[rule 2]

</important>

<important if="<specific trigger for domain area 1>">

[guidance for that domain]

</important>

... more sections, each with its own targeted condition ...
```

Notes:
- The title (`# CLAUDE.md` or `# AGENTS.md`) should match the canonical file's name.
- Project identity on line 3 is one sentence, not a paragraph.
- Blank lines inside `<important if>` blocks help rendering in some agents — keep them.

## Bootstrap Mode (greenfield)

When there's no existing file and the user opted into bootstrap:

1. Read the repo root: `ls`, `cat package.json` / `pyproject.toml` / equivalent, identify the primary language and runtime.
2. Detect scripts: parse `package.json` scripts, or `Makefile` / `justfile` / `Taskfile` targets, or `pyproject.toml` tool configs. Translate to a commands table.
3. Walk the directory tree one level deep (two levels if it's a monorepo) for the project map.
4. Ask the user via **AskUserQuestion** for anything that can't be inferred:
   - Is this a monorepo, single service, or library?
   - Are there non-obvious conventions (e.g., "routes live in X")?
   - Is there a testing framework in use, and any test setup the agent should know?
5. Draft a minimal file — foundational + commands only. Don't invent rules the user didn't give you. An agent file with fewer rules is better than one with invented rules.

## Example Transform

**Input** (`CLAUDE.md` before):

```markdown
# CLAUDE.md

This is an Express API with a React frontend in a Turborepo monorepo.

## Commands

| Command | Description |
|---|---|
| `turbo build` | Build all packages |
| `turbo test` | Run all tests |
| `turbo lint` | Lint all packages |
| `turbo dev` | Start dev server |
| `turbo db:generate` | Generate Prisma client |
| `turbo db:migrate` | Run database migrations |

## Project Structure

- `apps/api/` - Express REST API
- `apps/web/` - React SPA
- `packages/db/` - Prisma schema and client
- `packages/ui/` - Shared component library

## Coding Standards

- Use named exports
- Use functional components with TypeScript interfaces for props
- Use camelCase for variables, PascalCase for components
- Prefer `const` over `let`
- Always use strict equality (`===`)
- Write JSDoc comments for all public functions

## API Development

- All routes go in `apps/api/src/routes/`
- Use Zod for request validation
- Use Prisma for database access
- Error responses follow RFC 7807 format
- Authentication via JWT middleware

## Testing

- Jest + Supertest for API tests
- Vitest + Testing Library for frontend
- Mock database with `prismaMock` from `packages/db/test`
```

**Output** (`CLAUDE.md` after):

```markdown
# CLAUDE.md

Express API + React frontend in a Turborepo monorepo.

## Project map

- `apps/api/` — Express REST API
- `apps/web/` — React SPA
- `packages/db/` — Prisma schema and client
- `packages/ui/` — Shared component library

<important if="you need to run commands to build, test, lint, or generate code">

Run with `turbo` from the repo root.

| Command | What it does |
|---|---|
| `turbo build` | Build all packages |
| `turbo test` | Run all tests |
| `turbo lint` | Lint all packages |
| `turbo dev` | Start dev server |
| `turbo db:generate` | Regenerate Prisma client after schema changes |
| `turbo db:migrate` | Run database migrations |

</important>

<important if="you are adding or modifying imports or exports">
- Use named exports (no default exports).
</important>

<important if="you are creating new components">
- Functional components with TypeScript interfaces for props.
</important>

<important if="you are adding or modifying API routes">

- Routes live in `apps/api/src/routes/`.
- Use Zod for request validation.
- Use Prisma for database access.
- Error responses follow RFC 7807.
- Auth via JWT middleware — see `apps/api/src/middleware/auth.ts`.

</important>

<important if="you are writing or modifying tests">

- API: Jest + Supertest.
- Frontend: Vitest + Testing Library.
- Mock database with `prismaMock` from `packages/db/test` — real DB in tests flakes on CI.

</important>
```

**What was cut and why:**
- camelCase/PascalCase, `const` vs `let`, strict equality, JSDoc → linter/formatter territory.
- "Coding Standards" as a grouped section → split into targeted `<important if>` blocks.
- Prose padding ("This is an...") → collapsed to one line.

**What was preserved:**
- Every command.
- Project map (bare, foundational).
- All domain-specific rules, regrouped under narrower triggers.

## What Not to Do

- **Don't invent rules.** If a rule wasn't in the original and the user didn't confirm it, don't add it.
- **Don't strip commands.** Every command stays.
- **Don't group unrelated rules** under one `<important if>`. Specificity is the whole point.
- **Don't replace the file without showing the user the diff summary first.**
- **Don't blow away a real file for a symlink** without explicit confirmation.
- **Don't recurse into `node_modules/`, `dist/`, `.git/`, `vendor/`** during bootstrap.
