---
date: 2026-05-06T00:00:00Z
topic: "new-ui Design System Migration Plan"
status: in-progress
author: Claude (planning)
last_updated: 2026-05-06T00:00:00Z
last_updated_by: Claude (phase 6)
---

# new-ui Design System Migration Plan

## Overview

Migrate the agent-swarm dashboard at `new-ui/` to consume components and theme tokens from `~/Downloads/swarm-design-system` exclusively, with a single source of truth for light/dark theming.

- **Motivation**: Centralize visual language across Swarm surfaces; eliminate ad-hoc UI primitives in `new-ui/`; standardize on a theme contract that other surfaces (landing, templates-ui, docs-site) can later adopt.
- **Related**: `new-ui/`, `~/Downloads/swarm-design-system`, project CLAUDE.md (frontend PR merge-gate rule requiring `qa-use` evidence).

## Current State Analysis

### The "design system" at `~/Downloads/swarm-design-system` is a Skill, not a package

- No `package.json` anywhere in the tree, no build, no `dist/`, no exports, no shadcn registry, no CLI installer.
- `SKILL.md:1-5` declares it `name: agent-swarm-design`, a Claude Code Skill / brand reference kit.
- `README.md:27-37` explicitly documents that it was *lifted from* `desplega-ai/agent-swarm` upstream paths: `landing/src/app/globals.css`, `new-ui/src/styles/globals.css`, `new-ui/src/components/ui/{button,badge,card,input}.tsx`. It is a *snapshot of the consumer*, not the source of truth.
- Component count: **7** ui primitives (`button, badge, card, dialog, alert-dialog, tabs, dropdown-menu`) — a strict subset of `new-ui/`'s **24**.
- Token CSS uses bare names (`--primary`, `--background`) at `colors_and_type.css:78-96`, while `new-ui/` uses Tailwind v4 `--color-*` convention. OKLCH **values match**; **variable names do not**.
- Dark mode: `.dark { ... }` selector at `colors_and_type.css:158`; new-ui uses `.dark, .dark *` at `globals.css:54-88`. Mechanism (class on `<html>`) is the same.
- Brand kit defines additional token groups not in new-ui: explicit `--space-*` scale, `--shadow-*` set incl. `--shadow-amber-glow`, type-scale tokens (`--t-display`, `--t-h1..h4`, `--t-body`, `--lh-*`), and helper classes `.gradient-text`, `.grid-bg`. These are present in the brand kit but unused by new-ui.
- Brand kit defines explicit semantic status tokens at `colors_and_type.css:71-76`: `--status-success`, `--status-active`, `--status-error`, `--status-info`, `--status-pending`. **new-ui has no equivalent** — it inlines `bg-emerald-*`, `text-amber-*`, etc. across components.

### `new-ui/` is Vite + React 19 + Tailwind v4 + shadcn/ui (NOT Next.js)

- The repo-root `CLAUDE.md` description ("Dashboard (Next.js, port 5274)") is **wrong for this surface**. Evidence: `new-ui/vite.config.ts:1-28`, `new-ui/index.html:1-25`, `new-ui/package.json:6-13` (`vite`, `tsc -b && vite build`), `new-ui/main.tsx:1-11` (`createRoot`), no `next.config.*`. `new-ui/CLAUDE.md` line 3 self-corrects: *"React + Vite + shadcn/ui + Tailwind + AG Grid + react-query"*.
- Versions: React 19.2.0, TypeScript 5.9.3, Tailwind v4.2.1 (config-less, via `@tailwindcss/vite`), Biome 2.4.5, pnpm. shadcn/ui style `"new-york"`, `cssVariables: true`, `baseColor: neutral`, `iconLibrary: lucide` (`new-ui/components.json`).
- Token surface: **Tailwind v4 `@theme {}` block** at `src/styles/globals.css:6-51` plus dark overrides at `:54-88`. Custom variant `@custom-variant dark (&:is(.dark *))` at `globals.css:4`. Both light and dark sets are complete.
- Theme switching: custom `ThemeProvider` at `src/hooks/use-theme.ts:1-60` (localStorage `agent-swarm-mode`, default dark, toggles `.dark` class on `<html>`). First-paint `<html class="dark">` baked into `index.html:2`. Switcher rendered at `src/components/layout/app-header.tsx:40-43`.
- `next-themes ^0.4.6` is declared in `package.json:27` but has **no imports** anywhere in `src/` (verified by enumeration agent). Dead dep.

### Component surface and ad-hoc smells (exact, from enumeration)

- 24 shadcn primitives in `src/components/ui/`. 6 layout. 15 shared. 7 integrations. 6 workflows. 33 page files.
- All Radix usage goes through the meta-package `radix-ui` ^1.4.3 (not per-primitive `@radix-ui/react-*`).
- **Layout-color literals** (`bg-(zinc|slate|gray|stone|neutral)-N`, `text-`, `border-`, with/without `dark:`): **41 occurrences across 20 files**. Top files: `pages/workflows/[id]/page.tsx` (4), `components/shared/status-badge.tsx` (8 — overlaps Phase 2 surface), `pages/dashboard/page.tsx` (5), `components/layout/swarm-switcher.tsx` (3), all four `components/integrations/*-oauth-section.tsx` (1 each + claude-managed: 1).
- **Status/accent-color literals** (`bg-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-N`, `text-`, `border-`, with/without `dark:`): **328 occurrences across 48 files**. Top files:
  - `components/workflows/action-node.tsx` (33) — 8 action types each define a `border/bg/text/handle` color quad
  - `components/workflows/condition-node.tsx` (21) — 5 condition types same pattern
  - `components/shared/status-badge.tsx` (25) — overlaps Phase 2
  - `components/shared/session-log-viewer.tsx` (12)
  - `components/workflows/step-card.tsx` (11)
  - `pages/tasks/[id]/page.tsx` (30)
  - `pages/workflows/[id]/page.tsx` (12)
  - `pages/dashboard/page.tsx` (20)
  - `pages/api-keys/page.tsx` (15)
  - `pages/mcp-servers/page.tsx` (9), `pages/mcp-servers/[id]/page.tsx` (8), `pages/mcp-servers/[id]/mcp-oauth-panel.tsx` (9)
  - `components/integrations/{claude-managed,field-renderer,jira-oauth,codex-oauth,linear-oauth,integration-status-badge}` (28 combined)
  - 25+ other pages with 1–8 occurrences each
- **Inline `style={{...}}`**: 10 occurrences across 6 files. **9 are necessary** (computed values: react-flow port positions in `action-node.tsx:124`, `condition-node.tsx:89`; depth-driven indents in `json-tree.tsx:26,110,117,155,160`; dynamic transform in `ui/progress.tsx:20`; computed width in `budgets/page.tsx:108`). **1 is replaceable** (`debug/page.tsx:195` — static `style={{ height: 200 }}` → `h-[200px]` or `h-50`).
- **Hardcoded hex literals**: 17 occurrences, **all in `pages/workflows/[id]/page.tsx`**. They define **Monaco editor themes** (`L635-L668`) — Monaco's `defineTheme` API requires hex strings, not CSS variables. **These are a legitimate exception** but should be (a) extracted into named theme objects with comments, (b) ideally lifted into `src/lib/monaco-themes.ts` with light + dark presets so the page is freed of color literals. Plus `L697` has `bg-[#0d1117]` — Tailwind arbitrary literal, replaceable with `bg-card` or a token.
- **`next-themes` is dead**: declared in `package.json:27`, present in `pnpm-lock.yaml`, **0 imports anywhere in `src/`** (verified). The custom `useTheme` hook at `src/hooks/use-theme.ts` is the only theme provider, used by 6 files.

### Charter already exists in `new-ui/CLAUDE.md` — but is incomplete

`new-ui/CLAUDE.md` already documents UI rules:
- *"Always use `DataGrid` from `@/components/shared/data-grid`. **Never** use HTML `<Table>` components for data lists — this is a hard rule."*
- *"Use the `tag` size on `Badge` … do not re-inline the className."*
- *"Use `variant=\"destructive-outline\"` on `Button` … Do not re-inline `border-red-500/30 text-red-400 hover:bg-red-500/10`."*
- *"Never hardcode dark-mode colors (no `bg-zinc-950`, `text-zinc-400`, etc.). Use CSS variable classes…"*
- *"Status colors (semantic): emerald (success), amber (active/busy), red (error), zinc (inactive)."*

The last bullet is the loophole — it explicitly **permits** hardcoded `emerald/amber/red/zinc` for status semantics, which is why `status-badge.tsx` looks the way it does. The user's chosen scope ("Full purge incl. status colors" + lint enforcement) tightens this charter: status colors must come from named semantic tokens, not raw Tailwind palette literals.

### Merge gate

- Frontend PRs touching `new-ui/` MUST include a `qa-use` session with screenshots — enforced by `.github/workflows/merge-gate.yml` and `new-ui/CLAUDE.md`. Plan must produce `qa-use` evidence per phase (light + dark) and a final cross-route session.

## Desired End State

After this plan ships, the following are simultaneously true:

### Token + theme contract
1. **Single source of truth for theme tokens.** All color, radius, font, status-semantic, and chart values are defined exactly once in `new-ui/src/styles/globals.css` (light + dark), via Tailwind v4 `@theme {}` + `.dark, .dark *` overrides. No component re-defines them.
2. **Named semantic tokens cover every visual usage.** Beyond shadcn defaults, the file defines:
   - `--color-status-{success, active, error, info, pending, neutral, paused, warning}` (semantic states) — light + dark
   - `--color-action-{webhook, http, slack, email, sms, agent, condition, branch}` or similar named action-type colors used by workflow nodes (current code uses `violet/cyan/teal/orange/indigo/pink/purple/blue/sky/yellow` literals to mean "action types")
   - Any other recurring semantic distinctions revealed by the cleanup
3. **No raw Tailwind color palette literals in app code.** Across `new-ui/src/`:
   - Zero `bg-(zinc|slate|gray|stone|neutral)-\d+`, `text-`, `border-`, with/without `dark:`
   - Zero `bg-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d+`, `text-`, `border-`, with/without `dark:`
   - Zero Tailwind arbitrary-color literals (`bg-[#...]`, `text-[#...]`, etc.)
   - Zero hardcoded `#hex` / `rgb(...)` / `hsl(...)` / `oklch(...)` in `.tsx`/`.ts` **except** the Monaco editor theme objects, which live in `src/lib/monaco-themes.ts` with named exports and a header comment explaining why hex is required (Monaco API contract).
4. **Inline `style={{...}}` retained only where genuinely required** (the 9 pre-identified necessary cases). Each kept occurrence has a one-line `// inline-style: <reason>` comment.

### Component contract — composition only, no ad-hoc UI
5. **Every page and composed component is built from primitives** in `src/components/ui/` and `src/components/shared/`. No raw `<div>` constructs that re-implement what a primitive already provides (cards, sections, dialogs, lists, key-value rows, etc.).
6. **Brand-kit primitive parity.** Every primitive shared between `~/Downloads/swarm-design-system/new-ui/src/components/ui/` (the 7 brand-kit primitives) and `new-ui/src/components/ui/` has been diffed; visual deltas resolved in favor of whichever side is the deliberate source of truth (decided per primitive in Phase 8 with `file:line` justification). new-ui's superset primitives (the other 17) remain as-is unless the parity work surfaces a brand-kit-derived improvement.
7. **New primitives created where the auto-discovery audit identifies recurring ad-hoc patterns.** Likely candidates (final list comes from the Phase 9 sub-agent sweep): `PageHeader`, `SectionHeader`, `InfoRow`/`DefinitionList`, `StatPanel`, `SettingsRow`, `EmptyStateSection`, `OAuthSection`, `IntegrationStatusRow`, `WorkflowNodeShell`. Each new primitive has a single canonical implementation in `src/components/ui/` or `src/components/shared/`, is documented in `new-ui/CLAUDE.md`, and is used everywhere its pattern previously appeared.
8. **Catalog quality bar** (per Taras's "design system should contain 30+ pages and 20+ scripts"):
   - **30+ composed pages**: every one of the 33 routes in `src/app/router.tsx:40-80` is built from primitives only, counted as a "page" in the design-system catalog
   - **20+ scripts** (utilities + hooks): `src/lib/` and `src/hooks/` collectively expose ≥20 named utilities/hooks. Current count: ~7 (`utils.cn`, `formatters`, `content-preview*`, `use-theme`, `use-auto-scroll`, plus a few more). Reach 20 by extracting recurring inline logic into named utilities/hooks during Phase 10's composition sweep — only when the same logic appears 2+ times. Do **not** invent utilities to hit a number.

### Enforcement + hygiene
9. **Lint gate in CI** (`merge-gate.yml`) fails the build on any color-literal regex match or any `<div>` pattern flagged as "should be a primitive" (the latter is best-effort — see Phase 7).
10. **Updated `new-ui/CLAUDE.md`** documents (a) the token contract incl. status + action-type tokens, (b) the new primitives with one-line usage examples, (c) the lint gate, (d) the "compose-only" rule.
11. **Brand-truth audit doc** at `thoughts/taras/research/2026-05-06-design-system-audit.md` captures the divergence between `~/Downloads/swarm-design-system` and `new-ui/` (var-name mismatch, missing token groups in new-ui, components present only in new-ui, primitive parity decisions).
12. **`next-themes` removed** from `package.json` (declared but unused).
13. **CI green**: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm exec tsc -b`, `pnpm run check:tokens` all pass.
14. **`qa-use` evidence**: light + dark screenshots of all 33 routes captured in `thoughts/taras/qa/2026-05-06-design-system-audit/` per phase, plus a final cross-route session.

### Verification of the end state (commands)

- `rg -n 'bg-(zinc|slate|gray|stone|neutral|emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/` → 0 results
- `rg -n 'text-(zinc|slate|gray|stone|neutral|emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/` → 0 results
- `rg -n 'border-(zinc|slate|gray|stone|neutral|emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/` → 0 results
- `rg -n '\b(bg|text|border|fill|stroke|ring|from|via|to|shadow)-\[#[0-9a-fA-F]+\]' new-ui/src/` → 0 results
- `rg -n '#[0-9a-fA-F]{6}' new-ui/src/ -g '!**/monaco-themes.ts'` → 0 results in `*.{ts,tsx}`
- `rg -n 'next-themes' new-ui/` → 0 results
- `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b && pnpm run check:tokens` → green
- Toggle theme via header switcher → no visual regression in light or dark mode (qa-use evidence)
- `ls new-ui/src/components/ui/ new-ui/src/components/shared/ | wc -l` ≥ design-system catalog size from Phase 9
- `find new-ui/src/lib new-ui/src/hooks -name "*.ts" -not -name "*.test.ts" | wc -l` ≥ 20

## What We're NOT Doing

- **Not extracting a published / workspace package.** No `packages/swarm-design-system/`. `new-ui/` remains the canonical implementation. Multi-surface reuse (`landing/`, `templates-ui/`, `docs-site/`) is out of scope; can be a follow-on plan.
- **Not modifying `~/Downloads/swarm-design-system`.** It stays as a brand-reference Skill; read-only truth-source for the audit.
- **Not migrating away from shadcn/ui or Tailwind v4.** The foundation stays.
- **Not touching `landing/`, `templates-ui/`, `docs-site/`.** Even if they have similar smells.
- **Not adding new Tailwind config files.** Tailwind v4 config-less posture is preserved.
- **Not importing the brand kit's `colors_and_type.css` directly.** Var names mismatch Tailwind v4 conventions; we extract values into `globals.css`.
- **Not changing visual design (colors, sizing, spacing) deliberately.** Pixel parity required across all phases except Phase 8 (brand-kit primitive parity), where any visual delta must be approved before landing.
- **Not removing primitives from `new-ui/src/components/ui/` that aren't in the brand kit.** new-ui's 17 extra primitives stay.
- **Not inventing primitives speculatively.** New primitives are added only when the auto-discovery audit (Phase 9) shows the pattern appears 2+ times in app code.
- **Not adding shadow / type-scale / explicit spacing tokens from the brand kit beyond what's used.** Audit doc captures these as backlog.
- **Not adding Storybook or a separate `/design-system` route.** "30+ pages" means the existing 33 routes count toward the catalog; no new route surface needed.

## Implementation Approach

- **Sequencing rationale**: tokens first (Phase 1), so all later phases have utility classes to migrate to. Then highest-leverage refactor (`status-badge.tsx` in Phase 2) to prove the new token contract end-to-end on a 33-smell file. Color cleanup spreads across Phases 3–6 because 380+ literals can't safely land in one phase. Phase 7 lands the lint gate at zero violations. Phase 8 (brand-kit parity) is decoupled — it touches `src/components/ui/` not pages, so it can run any time after Phase 7 and is sequenced here for narrative coherence. Phase 9 + 10 handle the bigger composition mandate. Phase 11 is final cross-cutting QA.
- **Why split status colors into components vs. pages**: components define color *vocabularies* (`statusConfig`, `actionConfig` maps); pages mostly *consume* them. Migrating components first means many page touches are reduced to dropping the literal `className=` overrides because the component now ships the right token.
- **Pixel parity is the contract through Phase 7**. Phase 8 may surface deliberate visual changes; those are flagged in the brand-truth audit and require approval before landing.
- **Risk control**: `qa-use` snapshots taken *before* Phase 1 (baseline) and *after* each phase enable visual diffing. New token OKLCH values match the existing utility OKLCH values in both modes — exact, not approximate.
- **Lint gate posture**: ship in `error` mode (not warn) once landed, since cleanup phases bring it to zero violations before it's enabled.
- **`new-ui/CLAUDE.md`** rides along: Phase 1 adds tokens section; Phase 7 adds lint section; Phase 8 adds primitive parity notes; Phase 9 adds new-primitive docs; Phase 10 adds compose-only rule.
- **Brand-truth audit doc** lives at `thoughts/taras/research/2026-05-06-design-system-audit.md` (Phase 1 deliverable; updated by Phase 8 with parity decisions and Phase 9 with new-primitive catalog).
- **PR strategy**: each phase commits independently per the commit-per-phase preference. PR cadence (one PR per phase vs. grouped) decided at hand-off.
- **Plan size disclosure**: this is 11 phases, several large. It will not fit one implementation session. Phases 1–7 (token + color hygiene + gate) are a coherent first PR group; 8–11 (primitive parity + new primitives + compose-only refactor + final QA) are the second group. Splitting between sessions is recommended even though the plan is unified.

## Quick Verification Reference

- `cd new-ui && pnpm install --frozen-lockfile`
- `cd new-ui && pnpm lint`
- `cd new-ui && pnpm exec tsc -b`
- `cd new-ui && pnpm dev` (visual verification)
- Project-wide: `bun run lint`, `bun run tsc:check`, `bun test`
- Frontend PR merge-gate: `qa-use` session with screenshots (light + dark)

---

## Phase 1: Brand-truth audit + token foundation

### Overview

Produce the brand-truth audit doc, add semantic status + action-type tokens to `new-ui/src/styles/globals.css` (light + dark), and update `new-ui/CLAUDE.md` to document the new tokens and tighten the theming charter. Concrete deliverables: `thoughts/taras/research/2026-05-06-design-system-audit.md`, modified `globals.css`, modified `new-ui/CLAUDE.md`. **No behavioral or visual changes** — additive only.

### Changes Required:

#### 1. Brand-truth audit doc (new)
**File**: `thoughts/taras/research/2026-05-06-design-system-audit.md`
**Changes**: Side-by-side table comparing every CSS variable in `~/Downloads/swarm-design-system/colors_and_type.css` vs `new-ui/src/styles/globals.css`. Sections: (a) variable-name mismatch matrix; (b) OKLCH value parity per token; (c) groups present in brand kit but absent in new-ui (`--space-*`, `--shadow-*`, `--t-*`, `--lh-*`, status semantics); (d) dark-mode override coverage; (e) helper classes (`.gradient-text`, `.grid-bg`); (f) component count delta (7 vs 24, listed); (g) explicit list of net-new tokens added in this phase with values + source rationale (e.g. "`--color-status-success` ← `oklch(0.696 0.17 162.48)` derived from existing `bg-emerald-500` literal in `status-badge.tsx:30`").

#### 2. Add `--color-status-*` tokens
**File**: `new-ui/src/styles/globals.css`
**Changes**: Inside the existing `@theme {}` block (`globals.css:6-51`), add light-mode status tokens. Inside `.dark, .dark *` (`globals.css:54-88`), add the dark-mode parallels. Names cover the 8 semantic states the codebase already uses:

```css
/* Inside @theme {} — light defaults */
--color-status-success: oklch(0.696 0.17 162.48);   /* emerald-500 */
--color-status-success-foreground: oklch(0.985 0 0);
--color-status-active: oklch(0.769 0.188 70.08);    /* amber-500 */
--color-status-active-foreground: oklch(0.141 0.005 285.823);
--color-status-error: oklch(0.577 0.245 27.325);    /* red-600 */
--color-status-error-foreground: oklch(0.985 0 0);
--color-status-info: oklch(0.685 0.169 237.323);    /* sky-500 */
--color-status-info-foreground: oklch(0.985 0 0);
--color-status-pending: oklch(0.795 0.184 86.047);  /* yellow-500 */
--color-status-pending-foreground: oklch(0.141 0.005 285.823);
--color-status-warning: oklch(0.705 0.213 47.604);  /* orange-500 */
--color-status-warning-foreground: oklch(0.985 0 0);
--color-status-paused: oklch(0.623 0.214 259.815);  /* blue-500 */
--color-status-paused-foreground: oklch(0.985 0 0);
--color-status-neutral: oklch(0.552 0.013 285.938); /* zinc-500 */
--color-status-neutral-foreground: oklch(0.985 0 0);
```

(Exact OKLCH values pulled from the existing utility literals being replaced — captured in the audit doc with each source `file:line`.) Dark-mode parallels in `.dark, .dark *` use the lighter shade variants the codebase currently inlines (e.g. `text-emerald-400` → dark counterpart, etc.).

#### 3. Add `--color-action-*` tokens for workflow node types
**File**: `new-ui/src/styles/globals.css`
**Changes**: 11 action types are currently colored via raw literals in `components/workflows/{action-node.tsx, condition-node.tsx, trigger-node.tsx}`. Map each to a semantic name. Source: `action-node.tsx:18-72` and `condition-node.tsx:17-50`. Names (proposed; finalized in audit doc):

```css
--color-action-webhook: ...;   /* current: violet-500 */
--color-action-http: ...;      /* current: cyan-500 */
--color-action-agent: ...;     /* current: teal-500 */
--color-action-llm: ...;       /* current: orange-500 */
--color-action-script: ...;    /* current: indigo-500 */
--color-action-notification: ...; /* current: pink-500 */
--color-action-data: ...;      /* current: purple-500 */
--color-action-default: ...;   /* current: blue-500 */
--color-action-condition: ...; /* current: amber-500 / sky-500 / yellow-500 / orange-500 — pick canonical */
--color-action-trigger: ...;   /* current: emerald-500 */
```

Plus `-foreground` for each, plus `-bg` (the `/10` translucent fill currently used) — define as separate tokens with the alpha baked in, OR use a Tailwind opacity class on the base token.

#### 4. Tighten `new-ui/CLAUDE.md` theming charter
**File**: `new-ui/CLAUDE.md`
**Changes**: Replace the "Status colors (semantic): emerald (success), amber (active/busy), red (error), zinc (inactive)" line with: *"Status colors come from named semantic tokens — `bg-status-success`, `text-status-error`, `bg-status-active`, etc. — defined in `src/styles/globals.css`. Action-type colors (workflow nodes) come from `bg-action-*` tokens. Do not use raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, etc.) in app code. The lint gate (Phase 7) enforces this."* Append a token reference table.

### Success Criteria:

#### Automated Verification:
- [x] `cd new-ui && pnpm exec tsc -b` passes
- [x] `cd new-ui && pnpm lint` passes
- [x] `cd new-ui && pnpm dev` boots clean (kill after start)
- [x] Smoke test: temporarily add `<div className="bg-status-success text-status-success-foreground p-4">test</div>` in any page, confirm rendered color matches `bg-emerald-500` baseline; remove before commit (verified via built-CSS inspection: `--color-status-success` light = `oklch(69.6% .17 162.48)` = `--color-emerald-500`)

#### Automated QA:
- [ ] Pre-phase `qa-use` baseline: capture light + dark screenshots of `/`, `/agents`, `/tasks`, `/workflows/<id>`, `/integrations`, `/dashboard`, `/api-keys`, `/budgets` into `thoughts/taras/qa/2026-05-06-design-system-audit/baseline/`. Used for visual diffing in every later phase. [skipped — qa-use deferred to PR-time]
- [ ] Post-phase `qa-use` re-capture of the same routes; **expect pixel-identical** to baseline (Phase 1 is additive only — no usage migrated yet). [skipped — qa-use deferred to PR-time]

#### Manual Verification:
- [ ] Audit doc reviewed: every divergence captured; net-new token sources cited per `file:line`.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 1] add semantic status + action tokens; brand-truth audit`.

---

## Phase 2: Migrate `status-badge.tsx` to status tokens

### Overview

Rewrite `src/components/shared/status-badge.tsx`'s `statusConfig` map (`L28-L99`, 18 statuses) to use `bg-status-*` / `text-status-*` utilities. Single-file refactor that proves the token contract works end-to-end. Concrete deliverable: zero color-palette literals in this file with pixel parity in light + dark.

### Changes Required:

#### 1. Refactor `statusConfig` map
**File**: `new-ui/src/components/shared/status-badge.tsx`
**Changes**: Replace 25 status-color literals + 8 zinc layout literals across `L28-L99` with token classes. Per-status mapping cheat sheet (cross-checked against Phase 1 token names):
- `bg-emerald-500` + `text-emerald-600 dark:text-emerald-400` → `bg-status-success` + `text-status-success`
- `bg-amber-500` + `text-amber-600 dark:text-amber-400` → `bg-status-active` + `text-status-active`
- `bg-red-500` + `text-red-600 dark:text-red-400` → `bg-status-error` + `text-status-error`
- `bg-yellow-500` + `text-yellow-600 dark:text-yellow-400` → `bg-status-pending` + `text-status-pending`
- `bg-blue-500` + `text-blue-600 dark:text-blue-400` → `bg-status-paused` + `text-status-paused`
- `bg-orange-500` + `text-orange-600 dark:text-orange-400` → `bg-status-warning` + `text-status-warning`
- `bg-zinc-400` + `text-zinc-500 dark:text-zinc-400` → `bg-status-neutral` + `text-status-neutral`

#### 2. Verify usage sites
**Files**: every file importing `StatusBadge` (`rg -l 'from "@/components/shared/status-badge"' new-ui/src/`).
**Changes**: None — props unchanged. Just a re-render check via QA.

### Success Criteria:

#### Automated Verification:
- [x] `rg -n '(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|zinc|slate|gray|stone|neutral)-\d' new-ui/src/components/shared/status-badge.tsx` → 0 results
- [x] `cd new-ui && pnpm lint && pnpm exec tsc -b`
- [x] `cd new-ui && pnpm dev` boots clean *(verified via `pnpm exec vite build` succeeding — same Vite pipeline)*

#### Automated QA:
- [ ] `qa-use` light + dark capture of `/`, `/agents`, `/tasks`, `/workflow-runs/<id>`, `/approval-requests`, `/schedules`, `/services`, `/integrations` into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-2/`. *(skipped — qa-use deferred to PR-time per orchestrator instruction)*
- [ ] Visual diff against Phase 1 post-baseline: target = pixel parity per status. Any delta logged in QA report and resolved before phase complete. *(skipped — qa-use deferred to PR-time)*

#### Manual Verification:
- [ ] Live spot-check three statuses (`pending`, `running`/`active`, `failed`/`error`) in both modes — confirms 18-status palette renders brand-correct.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 2] migrate status-badge to semantic status tokens`.

**Phase 2 amendment (2026-05-06)**: Token-shape divergence surfaced during the first migration attempt. User chose the "add `-strong` text-emphasis tokens — pixel parity preserved" option. Phase 2 now ships as **two commits**: (1) token foundation correction (add `-strong` variants, revert `--color-status-error` from red-600 → red-500); (2) the original status-badge.tsx migration. See decision #6 in `thoughts/taras/research/2026-05-06-design-system-audit.md`.

---

## Phase 3: Purge layout-color literals across pages + components

### Overview

Replace every `bg-(zinc|slate|gray|stone|neutral)-\d+`, `text-`, `border-` (with/without `dark:`) used for **layout** (not status semantics) with semantic token utilities. Concrete deliverable: zero layout-color matches in `new-ui/src/`.

### Changes Required:

Exact target list from enumeration (**41 occurrences across 20 files**):

#### 1. Page files
**Files**:
- `src/pages/services/page.tsx` (`L16, L65`)
- `src/pages/mcp-servers/page.tsx` (`L34, L49`)
- `src/pages/mcp-servers/[id]/page.tsx` (`L43`)
- `src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx` (`L44, L59`)
- `src/pages/skills/page.tsx` (`L33`)
- `src/pages/integrations/page.tsx` (`L116`)
- `src/pages/workflows/[id]/page.tsx` (`L705, L715, L1246, L1876`)
- `src/pages/dashboard/page.tsx` (`L47, L114, L123, L141, L150`)
- `src/pages/api-keys/page.tsx` (`L43, L44`)
- `src/pages/workflow-runs/[id]/page.tsx` (`L169, L170`)
- `src/pages/tasks/[id]/page.tsx` (`L89`)
- `src/pages/agents/[id]/page.tsx` (`L543, L599`)
**Changes**: Per-occurrence replacement using mapping cheatsheet:
- `bg-zinc-50/100/200` → `bg-muted` or `bg-card`
- `bg-zinc-800/900/950` → `bg-background` or `bg-card`
- `bg-zinc-400/500` (used as a "neutral" / "stopped" indicator) → `bg-status-neutral`
- `text-zinc-400/500` → `text-muted-foreground`
- `text-zinc-100/50` → `text-foreground`
- `border-zinc-*/30` → `border-status-neutral/30` or `border-border`
- `text-zinc-900` (light-mode hover) → `text-foreground`
Inspect each in context — cheatsheet is a guide, not a rule. Conditional dark/light forks (e.g. `theme === "dark" ? "border-white/10" : "border-zinc-200"`) collapse to a single `border-border` after migration.

#### 2. Component files
**Files**:
- `src/components/integrations/jira-oauth-section.tsx` (`L127`)
- `src/components/integrations/codex-oauth-section.tsx` (`L133`)
- `src/components/integrations/linear-oauth-section.tsx` (`L141`)
- `src/components/integrations/integration-status-badge.tsx` (`L33`)
- `src/components/integrations/claude-managed-section.tsx` (`L81`)
- `src/components/layout/swarm-switcher.tsx` (`L60`)
- `src/components/workflows/node-styles.ts` (`L4, L9`)
**Changes**: Same cheatsheet. `swarm-switcher.tsx:L60` (`bg-zinc-400 dark:bg-zinc-600`) collapses to `bg-status-neutral` (or `bg-muted-foreground/40` if a different intent surfaces during review).

### Success Criteria:

#### Automated Verification:
- [x] `rg -n 'bg-(zinc|slate|gray|stone|neutral)-\d' new-ui/src/` → 0 results
- [x] `rg -n 'text-(zinc|slate|gray|stone|neutral)-\d' new-ui/src/` → 0 results
- [x] `rg -n 'border-(zinc|slate|gray|stone|neutral)-\d' new-ui/src/` → 0 results
- [x] `rg -n 'dark:(bg|text|border)-(zinc|slate|gray|stone|neutral)-\d' new-ui/src/` → 0 results
- [x] `cd new-ui && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] `qa-use` sweep of all 20 touched files' routes in light + dark into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-3/`. *(skipped — qa-use deferred to PR-time per orchestrator instruction)*
- [ ] Visual diff vs. Phase 2 post-baseline; flag any unintended visual regressions per route. *(skipped — qa-use deferred to PR-time)*

#### Manual Verification:
- [ ] Eye-check every touched page in both modes — semantic tokens render with parity (slight tonal shifts acceptable for the `zinc-200 → muted` substitutions; structural deltas are NOT — escalate).

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 3] purge layout-color literals across new-ui`.

---

## Phase 4: Status-color literals — components layer

### Overview

Migrate ~130 status/accent-color literals across the **components** surface (excluding `status-badge.tsx`, already done in Phase 2) to status + action tokens. Components define the color *vocabularies* the pages consume — landing this first reduces the page-layer touch surface in Phase 5.

### Changes Required:

#### 1. Workflow node colors (the largest cluster)
**Files**:
- `src/components/workflows/action-node.tsx` (`L18-L72` — 8 action types × 4 props = 32 literals)
- `src/components/workflows/condition-node.tsx` (`L17-L50` — 5 condition types × 4 props = 20 literals)
- `src/components/workflows/trigger-node.tsx` (`L20, L31, L32, L39` — 4 literals)
- `src/components/workflows/node-styles.ts` (`L5-L8` — 4 literals)
**Changes**: Replace each `border-violet-500/50`, `bg-violet-500/10`, `text-violet-400`, `!bg-violet-500` quad (and analogues for cyan/teal/orange/indigo/pink/purple/blue) with the matching `border-action-*`, `bg-action-*/10`, `text-action-*`, `!bg-action-*` from Phase 1's tokens. Status-driven border colors in `node-styles.ts` use `border-status-*` instead.

#### 2. Step-card + session-log-viewer + json-tree
**Files**:
- `src/components/workflows/step-card.tsx` (11 literals at `L83, L141, L155, L268, L270, L271, L295, L297, L298, L354, L556`)
- `src/components/workflows/json-tree.tsx` (3 literals at `L53, L57, L60` — JSON token type colors: string/number/boolean → use `text-status-success / text-status-active / text-status-info`)
- `src/components/shared/session-log-viewer.tsx` (12 literals at `L604-L611, L770-L783` — session status badges + scissors divider)
**Changes**: Per-occurrence replacement using status / action tokens. The session-log-viewer status map at `L604-L611` is structurally identical to the `status-badge.tsx` map and uses the same token set.

#### 3. Integrations components
**Files**:
- `src/components/integrations/integration-status-badge.tsx` (`L19, L26`)
- `src/components/integrations/claude-managed-section.tsx` (`L73, L77, L116, L153, L155, L168, L170` — 7 literals)
- `src/components/integrations/jira-oauth-section.tsx` (5 literals — full file scan)
- `src/components/integrations/codex-oauth-section.tsx` (`L99, L122, L148`)
- `src/components/integrations/linear-oauth-section.tsx` (`L140, L200, L231`)
- `src/components/integrations/field-renderer.tsx` (8 literals at `L104, L109, L115, L126, L143, L177, L200, L217`)
**Changes**: Status-token migration. `border-emerald-500/30 text-emerald-400` → `border-status-success/30 text-status-success`. Connection state visual chips ("Connected"/"Failed"/"Partial") map cleanly to status tokens.

#### 4. Other components
**Files**:
- `src/components/shared/stats-bar.tsx` (`L16-L18` — `success/warning/danger` color map)
- `src/components/shared/error-boundary.tsx` (`L63, L65, L66`)
- `src/components/layout/app-header.tsx` (`L30` — health indicator)
- `src/components/ui/button.tsx` (`L18` — `destructive-outline` variant defines `border-red-500/30 text-red-400`)
**Changes**: Same status-token mapping. `button.tsx:L18` is special — it's the source of the `destructive-outline` variant. Replace inside the cva definition; downstream usage stays the same since the variant name doesn't change.

### Success Criteria:

#### Automated Verification:
- [x] `rg -n '(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/components/` → 0 results
- [x] `rg -n 'dark:(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/components/` → 0 results
- [x] `cd new-ui && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] `qa-use` sweep of routes touching every modified component (workflows graph, session-log viewer, stats bar, error boundary triggered, integrations, header health) in light + dark into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-4/`. *(skipped — qa-use deferred to PR-time per orchestrator instruction)*
- [ ] Visual diff vs. Phase 3 post-baseline. Workflow node colors and session-log status chips should match pre-migration exactly. *(skipped — qa-use deferred to PR-time)*

#### Manual Verification:
- [ ] Open `/workflows/<id>` with a representative workflow — every action-type and condition-type renders the correct hue.
- [ ] Trigger an error to render `ErrorBoundary` (e.g. throw in a debug page) — color treatment matches.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 4] migrate status/action color literals in components/`.

---

## Phase 5: Status-color literals — pages layer

### Overview

Migrate ~200 status/accent-color literals across the **pages** surface (`src/pages/`). Many sites are simply consuming components from Phase 4 — once the component renders correctly, the page-level `className=` overrides drop away.

### Changes Required:

Exact target list from enumeration (status-color literals only — layout colors already handled in Phase 3):

#### 1. High-density pages (>=15 literals each)
**Files**:
- `src/pages/tasks/[id]/page.tsx` (30 literals — full status/action color usage including progress-indicator selectors at `L384-L386`, `iconColor`/`borderColor`/`bgColor` props at `L753-L979`)
- `src/pages/dashboard/page.tsx` (20 literals — agent/task event color map at `L113-L139`, status indicators)
- `src/pages/api-keys/page.tsx` (15 literals — auth status map, claude/pi/codex provider color hints, stats panels at `L323-L339`)
- `src/pages/workflows/[id]/page.tsx` (12 status-color literals — separate from the 17 hex literals handled in Phase 6)

#### 2. Mid-density pages (5–10 literals each)
**Files**:
- `src/pages/mcp-servers/page.tsx` (9 literals — protocol/scope/status chips)
- `src/pages/mcp-servers/[id]/page.tsx` (8 literals)
- `src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx` (9 literals — connection state alerts)
- `src/pages/agents/[id]/page.tsx` (6 literals)
- `src/pages/budgets/page.tsx` (8 literals — utilization color thresholds at `L74-L101`, alert badges)
- `src/pages/config/page.tsx` (8 literals)
- `src/pages/repos/[id]/page.tsx` (7 literals)
- `src/pages/integrations/page.tsx` (5 literals — `StatusChip` colorClass props)
- `src/pages/workflow-runs/[id]/page.tsx` (4 literals)
- `src/pages/skills/page.tsx` (4 literals), `src/pages/skills/[id]/page.tsx` (4 literals)

#### 3. Low-density pages (1–3 literals each)
**Files**:
- `src/pages/services/page.tsx` (3)
- `src/pages/chat/page.tsx` (3)
- `src/pages/schedules/[id]/page.tsx` (3)
- `src/pages/approval-requests/[id]/page.tsx` (3)
- `src/pages/repos/page.tsx` (2)
- `src/pages/tasks/page.tsx` (2)
- `src/pages/schedules/page.tsx` (2)
- `src/pages/templates/[id]/page.tsx` (2)
- `src/pages/debug/page.tsx` (1 status-color)
- `src/pages/memory/page.tsx` (1)
- `src/pages/workflows/page.tsx` (1)
- `src/pages/agents/page.tsx` (1)
- `src/pages/integrations/[id]/page.tsx` (1)
- `src/pages/templates/[id]/history/[version]/page.tsx` (1)

**Changes**: Per-occurrence migration using the status / action token mappings established in Phases 1, 2, and 4. Common substitutions:
- `bg-emerald-500` → `bg-status-success`
- `text-amber-500` / `text-amber-600 dark:text-amber-400` → `text-status-active`
- `text-red-400` / `text-red-500` / `text-red-600 dark:text-red-400` → `text-status-error`
- `border-{emerald,amber,red,sky,orange,yellow}-500/30 text-{...}-400` → `border-status-*/30 text-status-*`
- `bg-red-600 hover:bg-red-700` (delete-confirm AlertDialogAction) → use existing `Button variant="destructive"` instead of inlining; if `AlertDialogAction` accepts variants, switch; otherwise add a destructive `<Button>` wrapper
- Threshold logic at `pages/budgets/page.tsx:L74-L76` and `pages/tasks/[id]/page.tsx:L384-L386` — replace `bg-emerald-500/bg-amber-500/bg-red-500` selectors with `bg-status-success/bg-status-warning/bg-status-error`
- `dashboard/page.tsx:L113-L139` event color map — restructure as a map of `{ icon, status: "success" | "active" | "info" | ... }` with classes derived from status tokens; reduces 16+ literal entries to 16 status-keyed entries

### Success Criteria:

#### Automated Verification:
- [x] `rg -n '(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/pages/` → 0 results
- [x] `rg -n 'dark:(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/pages/` → 0 results
- [x] Combined: `rg -n '(bg|text|border)-(emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d' new-ui/src/` → 0 results
- [x] `cd new-ui && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] `qa-use` sweep of all 30 touched pages in light + dark into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-5/`. [skipped — qa-use deferred to PR-time]
- [ ] Visual diff vs. Phase 4 post-baseline. Special attention to `tasks/[id]`, `dashboard`, `api-keys`, `budgets` (dense pages). [skipped — qa-use deferred to PR-time]

#### Manual Verification:
- [ ] Walk through `/tasks/<id>` for a task in each terminal state (completed, failed, active).
- [ ] Walk through `/dashboard` to verify agent/task event color treatment.
- [ ] Confirm `/budgets` utilization bars render correct thresholds (green/amber/red equivalents).

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 5] migrate status/action color literals in pages/`.

---

## Phase 6: Inline styles + Monaco hex extraction + arbitrary literals + drop next-themes

### Overview

Eliminate the remaining hygiene smells: 1 replaceable inline style, 17 Monaco hex literals (extract to `src/lib/monaco-themes.ts`), 1 Tailwind arbitrary-color literal, 9 necessary inline styles get explanatory comments, and `next-themes` is removed from `package.json`. Concrete deliverable: clean greps + simplified `pages/workflows/[id]/page.tsx`.

### Changes Required:

#### 1. Extract Monaco themes
**File (new)**: `new-ui/src/lib/monaco-themes.ts`
**Changes**: Create the file with two named exports:

```ts
// Monaco's `defineTheme` API requires hex color strings — CSS variables not supported.
// Light/dark theme objects mirror brand-palette values and stay in sync with globals.css.
export const monacoLightTheme = { /* ...the L631-L650 object... */ };
export const monacoDarkTheme = { /* ...the L657-L676 object... */ };
```

**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: Remove the inline theme object literals; import `monacoLightTheme`, `monacoDarkTheme` and pass them to `monaco.editor.defineTheme()`. Replace `bg-[#0d1117]` at `L697` with `bg-card` (or whichever token the audit flags as the brand-correct dark canvas).

#### 2. Replace replaceable inline style
**File**: `new-ui/src/pages/debug/page.tsx`
**Changes**: `L195` — `style={{ height: 200 }}` → `className="h-[200px]"` (or extract to a Tailwind utility if it appears elsewhere).

#### 3. Document necessary inline styles
**Files**: `src/components/ui/progress.tsx:20`, `src/components/workflows/action-node.tsx:124`, `src/components/workflows/condition-node.tsx:89`, `src/components/workflows/json-tree.tsx:26,110,117,155,160`, `src/pages/budgets/page.tsx:108`.
**Changes**: Add a one-line `// inline-style: <reason>` comment above each. Examples: `// inline-style: dynamic transform driven by value prop`, `// inline-style: react-flow port position computed per index`, `// inline-style: depth-driven indent`, `// inline-style: dynamic computed width %`.

#### 4. Remove dead `next-themes` dep
**File**: `new-ui/package.json`
**Changes**: Remove the `"next-themes": "^0.4.6"` line at `L27`. Run `pnpm install` to regenerate `pnpm-lock.yaml`.

### Success Criteria:

#### Automated Verification:
- [x] `rg -n '#[0-9a-fA-F]{6}' new-ui/src/ -g '*.{ts,tsx}' -g '!**/monaco-themes.ts'` → 0 results
- [x] `rg -n '\b(bg|text|border|fill|stroke|ring|from|via|to|shadow)-\[#[0-9a-fA-F]+\]' new-ui/src/` → 0 results
- [x] `rg -n 'next-themes' new-ui/` → 0 results (excluding lockfile pre-`pnpm install`; after re-install, lockfile is also clean)
- [x] `rg -n 'style={{' new-ui/src/` returns only the 9 documented occurrences, each with a `// inline-style:` comment on the preceding line
- [x] `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] `qa-use` capture of `/workflows/<id>` in light + dark — Monaco editor renders identically (it's now sourced from a separate theme file). [skipped — qa-use deferred to PR-time]
- [ ] `qa-use` capture of `/debug` — the 200px-height region renders at the same dimensions. [skipped — qa-use deferred to PR-time]
- [ ] Theme toggle works without any provider regression (validates that `next-themes` removal is invisible). [skipped — qa-use deferred to PR-time]

#### Manual Verification:
- [ ] Toggle theme on `/workflows/<id>` — Monaco editor switches between the two new theme objects.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 6] extract monaco themes; document inline-style necessities; drop next-themes`.

---

## Phase 7: Lint gate

### Overview

Ship the enforcement gate. After Phases 1–6, the codebase is at **zero color-literal violations** — the gate lands at error mode. Concrete deliverable: `new-ui/scripts/check-design-tokens.sh`, `pnpm run check:tokens` script, and a CI step in `.github/workflows/merge-gate.yml`.

### Changes Required:

#### 1. Lint script
**File (new)**: `new-ui/scripts/check-design-tokens.sh`
**Changes**: Idempotent shell script that uses `rg` to fail on any forbidden pattern in `src/`. Print offending `file:line` for every match. Exit code: 0 = clean, 1 = violations found. Patterns enforced:
- `bg|text|border|fill|stroke|ring|from|via|to|shadow` followed by `-(zinc|slate|gray|stone|neutral|emerald|amber|red|sky|orange|yellow|green|rose|blue|indigo|violet|purple|pink|fuchsia|teal|cyan|lime)-\d`
- Tailwind arbitrary color literals: `(bg|text|border|fill|stroke|ring|from|via|to|shadow)-\[#[0-9a-fA-F]+\]`
- Hardcoded hex outside `src/lib/monaco-themes.ts`: `#[0-9a-fA-F]{6}` in `*.{ts,tsx}` excluding allowlist
- `dark:` variants of the above

#### 2. pnpm script entry
**File**: `new-ui/package.json`
**Changes**: Add `"check:tokens": "bash scripts/check-design-tokens.sh"` to the `scripts` block.

#### 3. CI integration
**File**: `.github/workflows/merge-gate.yml`
**Changes**: Inside the existing `new-ui` job (next to `pnpm lint && pnpm exec tsc -b`), add `pnpm run check:tokens`. Cache: none needed.

#### 4. Pre-push hook (optional, dev convenience)
**File**: `new-ui/scripts/check-design-tokens.sh` referenced from a project-level pre-push hook if one exists. Skip if maintaining hooks adds friction.

#### 5. CLAUDE.md documentation
**File**: `new-ui/CLAUDE.md`
**Changes**: Add section under existing UI rules: *"**Color literal lint gate.** `pnpm run check:tokens` (also runs in CI) fails the build on any raw Tailwind color palette literal in `src/`. To use a new color, add a token to `src/styles/globals.css`. Monaco editor themes are exempt and live in `src/lib/monaco-themes.ts`."*

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm run check:tokens` → exits 0
- [ ] Insert a deliberate violation (`<div className="bg-zinc-500" />` in any page), re-run → exits non-zero with the offending `file:line` printed; revert
- [ ] `cd new-ui && pnpm lint && pnpm exec tsc -b` still green
- [ ] CI integration validated: push a test branch, watch `merge-gate.yml` run the new step

#### Automated QA:
- [ ] None — no UI changes.

#### Manual Verification:
- [ ] CLAUDE.md reads correctly; the gate's failure output is grep-friendly enough to debug from CI logs.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 7] add color-literal lint gate + CLAUDE.md docs`.

---

## Phase 8: Brand-kit primitive parity

### Overview

Diff each of the 7 shared primitives between `~/Downloads/swarm-design-system/new-ui/src/components/ui/*` and `new-ui/src/components/ui/*`. For each primitive, decide source-of-truth per delta with `file:line` justification, document in the brand-truth audit doc, and apply changes only where the brand kit reveals a deliberate, brand-correct improvement. Concrete deliverable: parity report + (possibly) modified `new-ui/src/components/ui/{button,badge,card,dialog,alert-dialog,tabs,dropdown-menu}.tsx`.

### Changes Required:

#### 1. Per-primitive diff + decision
For each of the 7 shared primitives:

**Files** (compare):
- brand kit: `/Users/taras/Downloads/swarm-design-system/new-ui/src/components/ui/{button,badge,card,dialog,alert-dialog,tabs,dropdown-menu}.tsx`
- new-ui: `/Users/taras/worktrees/agent-swarm/2026-05-06-ui-design-system/new-ui/src/components/ui/{button,badge,card,dialog,alert-dialog,tabs,dropdown-menu}.tsx`

For each primitive: create a section in the brand-truth audit doc capturing (a) variants present, (b) sizes present, (c) hover/active/focus treatment, (d) padding/radius, (e) icon slot conventions, (f) data-slot attribute usage, (g) type signatures. Mark each delta as **adopt brand kit** / **keep new-ui** / **non-issue**, with reasoning per `file:line`. Constraints:
- new-ui variants `Badge size="tag"` and `Button variant="destructive-outline"` stay (they're project-specific contracts already documented in CLAUDE.md).
- Brand-kit changes that conflict with status/action token usage from Phases 1–5 are skipped (status tokens are the canonical layer).

#### 2. Apply approved changes
Per-decision edits to the affected `src/components/ui/*.tsx` files. Each touched file gets a small, surgical change with rationale captured in the audit doc.

#### 3. Document in CLAUDE.md
**File**: `new-ui/CLAUDE.md`
**Changes**: Add a "Primitive parity with brand kit" subsection: *"new-ui's primitives are the canonical implementation. Brand-kit divergences are tracked in `thoughts/taras/research/2026-05-06-design-system-audit.md` and reconciled deliberately. Do not blindly copy from `~/Downloads/swarm-design-system` — consult the audit first."*

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm run check:tokens` (Phase 7) still passes
- [ ] `cd new-ui && pnpm lint && pnpm exec tsc -b`

#### Automated QA:
- [ ] `qa-use` capture of routes that exercise each touched primitive in light + dark into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-8/`.
- [ ] If any deliberate visual change lands, side-by-side before/after captured for review.

#### Manual Verification:
- [ ] Audit doc parity table reviewed: every primitive has an entry, every delta has a decision.
- [ ] Any deliberate visual changes approved before merge.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 8] reconcile brand-kit primitive parity + audit doc updates`.

---

## Phase 9: Auto-discovery pattern audit + new primitives

### Overview

Spawn an auto-discovery sub-agent to scan all 33 pages + composed components, cluster repeated layout patterns, and propose primitive names. Implement the agreed-upon new primitives. Concrete deliverable: pattern report + new files in `src/components/{ui,shared}/` for each promoted primitive + CLAUDE.md docs.

### Changes Required:

#### 1. Sub-agent sweep
**Trigger**: dispatch a `desplega:codebase-pattern-finder` sub-agent (during implementation, not planning) to scan all 33 pages + ~34 composed components for recurring layout patterns. Output: pattern report at `thoughts/taras/research/2026-05-06-pattern-audit.md` listing each cluster with: name, occurrence count, file:line examples, proposed primitive, expected props.

Pattern targets to confirm:
- **PageHeader**: title + optional description + optional action button. Likely 30+ occurrences (one per page).
- **SectionHeader**: subtitle within a page, smaller scale. Likely 50+ occurrences.
- **InfoRow / DefinitionList**: key-value display (e.g. `pages/agents/[id]`, `pages/integrations/[id]`, `pages/repos/[id]` configuration sections).
- **StatPanel**: icon + label + numeric value (e.g. `pages/api-keys/page.tsx:L323-L339`, `pages/budgets/page.tsx`).
- **SettingsRow**: form label + input + helper text.
- **EmptyStateSection** (already exists as `EmptyState` in shared/) — confirm it covers all empty-state usage; remove ad-hoc duplicates.
- **OAuthSection**: pattern shared by `claude-managed-section`, `codex-oauth-section`, `linear-oauth-section`, `jira-oauth-section` — connection-state header + steps + buttons. Likely a high-leverage extraction.
- **IntegrationStatusRow**: status badge + label + status text. Used across integration pages.
- **WorkflowNodeShell**: shared header + body + handle layout for action/condition/trigger nodes (currently triplicated).
- **AlertCallout**: inline status alert (info/warning/error) — currently inlined in `mcp-oauth-panel.tsx:L279,L346`, `config/page.tsx:L1049`, etc.

#### 2. Promote each pattern to a primitive
For each pattern with **≥2 occurrences in app code**, create a primitive file. New primitives go in:
- `src/components/ui/` if they're brand-agnostic (buttons, headers, list rows)
- `src/components/shared/` if they're agent-swarm-specific (OAuthSection, IntegrationStatusRow, WorkflowNodeShell)

Each new primitive:
- Has a clear API surface (`type Props`, JSDoc-free unless invariant requires it)
- Composes from existing shadcn primitives (no raw `<div>` re-implementations of cards/sections)
- Is exported as a named export
- Comes with no tests in this phase (testing not in scope; see "What We're NOT Doing" in plan above)

#### 3. CLAUDE.md update
**File**: `new-ui/CLAUDE.md`
**Changes**: Add a "Primitives catalog" section listing every primitive (existing shadcn + newly added) with a 1-line usage example. Reinforce: *"Compose from primitives. Do not hand-roll a `<div>` layout if a primitive already exists. Add a new primitive when you'd otherwise repeat the pattern."*

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm run check:tokens && pnpm lint && pnpm exec tsc -b`
- [ ] Pattern report committed at `thoughts/taras/research/2026-05-06-pattern-audit.md`
- [ ] Every promoted primitive has a corresponding file under `src/components/{ui,shared}/`

#### Automated QA:
- [ ] `qa-use` capture of one route per new primitive demonstrating its render in light + dark, into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-9/`.
- [ ] No visual regression from Phase 8 baseline (this phase introduces primitives but does not yet replace usages — that's Phase 10).

#### Manual Verification:
- [ ] Pattern report reviewed: clusters meaningful, occurrence counts honest, primitive proposals reasonable.
- [ ] CLAUDE.md catalog accurate.

**Implementation Note**: Pause for manual confirmation. Commit: `[phase 9] pattern audit + new primitives (catalog grows)`.

---

## Phase 10: Composition-only refactor sweep

### Overview

Walk every page and composed component; replace ad-hoc layout `<div>` constructs with primitive compositions (existing shadcn + newly added in Phase 9). Hit the "30+ pages, 20+ scripts" quality bar. Largest phase by churn — likely needs internal split into 10a (high-density pages) and 10b (everything else) at implementation time.

### Changes Required:

#### 1. Per-page composition refactor
**Files**: all 33 pages in `src/pages/**/page.tsx`.
**Changes**: For each page, replace ad-hoc `<div className="...">` constructs with primitive compositions. Common rewrites:
- Page-top heading block → `<PageHeader title="..." description="..." action={...} />`
- Section heading + body → `<SectionHeader>` + `<Card>` or whatever the section primitive is
- Key-value lists in detail pages → `<InfoRow>` / `<DefinitionList>` from Phase 9
- Inline status alerts → `<AlertCallout>` from Phase 9
- Stats grids → `<StatPanel>` repeated
- Empty states → `<EmptyState>` (existing)
- OAuth/integration sections → `<OAuthSection>` / `<IntegrationStatusRow>` from Phase 9

#### 2. Per-composed-component refactor
**Files**: composed components under `src/components/{layout,shared,integrations,workflows}/`.
**Changes**:
- `claude-managed-section.tsx`, `codex-oauth-section.tsx`, `jira-oauth-section.tsx`, `linear-oauth-section.tsx` → rewrite as thin wrappers around `<OAuthSection>`
- `action-node.tsx`, `condition-node.tsx`, `trigger-node.tsx` → factor shared shell into `<WorkflowNodeShell>` from Phase 9; node-type files become small variant configs
- `integration-status-badge.tsx` → consider whether `<IntegrationStatusRow>` subsumes it; if yes, deprecate this file

#### 3. Extract recurring inline logic into named utilities
**Files**: `src/lib/`, `src/hooks/`.
**Changes**: When the composition refactor reveals a piece of inline logic appearing 2+ times (e.g. status formatter, time formatter, color-from-percent thresholder), extract to `src/lib/<name>.ts` or `src/hooks/<name>.ts`. **Do not invent utilities to hit the count of 20**; only extract when the refactor actually surfaces them. Track utility count in the phase's QA report.

#### 4. CLAUDE.md update
**File**: `new-ui/CLAUDE.md`
**Changes**: Add the "Compose-only" rule: *"Pages and composed components are built from primitives. Raw `<div>` layouts that re-implement a primitive's responsibility are forbidden. If you find yourself writing a `<div className=\"flex items-center gap-...\">` to recreate a header/section/row pattern, use or create the relevant primitive."*

### Success Criteria:

#### Automated Verification:
- [ ] `cd new-ui && pnpm run check:tokens && pnpm lint && pnpm exec tsc -b`
- [ ] `find new-ui/src/lib new-ui/src/hooks -name "*.ts" -not -name "*.test.ts" | wc -l` ≥ 20
- [ ] Manual count of touched pages = 33 (every route refactored at least once); recorded in phase QA report

#### Automated QA:
- [ ] `qa-use` sweep of all 33 routes in light + dark into `thoughts/taras/qa/2026-05-06-design-system-audit/phase-10/`.
- [ ] Visual diff vs. Phase 9 post-baseline: pixel parity expected; structural deltas flagged.

#### Manual Verification:
- [ ] Skim 3 representative pages (high-density: `tasks/[id]`, `dashboard`, `workflows/[id]`) — confirm they read as "compose from primitives" rather than "hand-rolled divs".
- [ ] CLAUDE.md catalog matches the actual code surface.

**Implementation Note**: This phase is large. Suggest internal split 10a (high-density pages: tasks, dashboard, workflows, api-keys, mcp-servers, integrations) + 10b (everything else). Commits: `[phase 10a] composition refactor: high-density pages`, `[phase 10b] composition refactor: remaining pages`. Pause for manual confirmation between sub-phases.

### QA Spec (optional):

This phase is the biggest visual surface area. A separate QA doc captures evidence systematically.

**QA Doc**: `thoughts/taras/qa/2026-05-06-design-system-audit.md` (generate via `desplega:qa` at handoff). Scenarios: per-route screenshot sweep in light + dark, primitive-composition smoke checks, theme-toggle interaction.

---

## Phase 11: Final cross-route QA evidence + CLAUDE.md final pass

### Overview

End-to-end evidence-heavy QA spanning all 33 routes in both modes. Final acceptance proof for the merge gate. Also: a single closing pass on `new-ui/CLAUDE.md` to ensure all rule additions across phases land coherently.

### Changes Required:

#### 1. CLAUDE.md final pass
**File**: `new-ui/CLAUDE.md`
**Changes**: Read the full file end-to-end. Reconcile the per-phase additions (tokens, lint gate, primitive parity, catalog, compose-only) into a coherent flow. Remove duplication. Confirm every rule has a clear "why" in 1 line.

#### 2. Brand-truth audit doc final pass
**File**: `thoughts/taras/research/2026-05-06-design-system-audit.md`
**Changes**: Add a closing section: "Open backlog vs. brand kit". List remaining divergences from the brand kit that are deliberately not addressed (e.g. `--space-*` not adopted, `--shadow-amber-glow` not adopted, `.gradient-text` not adopted) with rationale.

#### 3. Optional: backlog file
**File (new, optional)**: `thoughts/taras/research/2026-05-06-design-system-backlog.md`
**Changes**: If the audit's "open backlog" is non-trivial (likely yes), extract it into a separate backlog doc that future plans can reference.

### Success Criteria:

#### Automated Verification:
- [ ] Final green sweep: `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b && pnpm run check:tokens`
- [ ] All Desired End State verification commands return their target results

#### Automated QA:
- [ ] Full cross-route `qa-use` sweep covering all 33 routes in `src/app/router.tsx:40-80` in light + dark; saved under `thoughts/taras/qa/2026-05-06-design-system-audit/phase-11-final/`.
- [ ] Theme-toggle interaction recorded on at least two routes (validates the `next-themes` removal hasn't reintroduced provider regressions).
- [ ] Side-by-side baseline vs. final comparison gallery generated (Phase 1 baseline vs. Phase 11 final) — flag any unintended deltas.

#### Manual Verification:
- [ ] Full screenshot grid eyes-on review.
- [ ] CLAUDE.md final pass accepted.

**Implementation Note**: Plan complete after this phase. Commit: `[phase 11] qa: design-system audit final evidence + CLAUDE.md reconciliation`. Open the PR (or PR group, if Phases 1–7 and 8–11 were split).

### QA Spec (optional):

**QA Doc**: same `thoughts/taras/qa/2026-05-06-design-system-audit.md` referenced in Phase 10. Phase 11 closes the doc with the final-state evidence and the baseline-vs-final comparison.

---

## Appendix

- **Commit policy**: commit-per-phase enabled. After each phase's manual verification passes, create commit `[phase N] <brief description>`. Phase 10 may use `[phase 10a]` and `[phase 10b]`.
- **PR strategy**: leave to Taras at handoff. Phases 1–7 form one logical PR (token + color hygiene + lint gate). Phases 8–11 form a second (primitive parity + new primitives + composition refactor + final QA). Single mega-PR is technically possible but discouraged for review tractability.
- **Risk callouts**:
  - **Status-token OKLCH precision**: each `--color-status-*` value MUST exactly match the existing utility OKLCH at the migration point. Off-by-one tonal shifts will surface as visual diffs and require rollback.
  - **Workflow node colors**: 11 action types means the `--color-action-*` set is wider than typical status tokens. Resist consolidating semantically distinct types into the same token.
  - **AlertDialogAction with `bg-red-600 hover:bg-red-700`**: appears in 3+ pages. Verify shadcn's `AlertDialogAction` accepts a `variant` prop or wrap with `<Button variant="destructive">` consistently.
  - **CLAUDE.md drift**: 5 phases each touch CLAUDE.md. Phase 11's final pass is mandatory to keep it coherent.
  - **Phase 10 size**: largest phase. Internal split (10a / 10b) is strongly recommended at implementation time.
- **Derail notes** (captured during planning):
  - Brand kit's `--space-*`, `--shadow-*`, `--t-*`, `--lh-*`, `.gradient-text`, `.grid-bg` are not adopted by this plan. Captured in audit doc as backlog. Adopt if a future plan needs them.
  - Project-root `CLAUDE.md` says "Dashboard (Next.js, port 5274)" — wrong. Fix in a separate doc PR; out of scope here.
- **References**:
  - Project root CLAUDE.md merge-gate: `qa-use` required for `new-ui/` PRs
  - CI checks: `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b`
  - Brand kit: `~/Downloads/swarm-design-system/`
  - Enumeration source: smell enumeration sub-agent run on 2026-05-06 (full output: 41 layout literals / 328 status literals / 10 inline styles / 17 hex literals)
  - Brand-truth audit doc: `thoughts/taras/research/2026-05-06-design-system-audit.md` (Phase 1 deliverable)
  - Pattern audit doc: `thoughts/taras/research/2026-05-06-pattern-audit.md` (Phase 9 deliverable)
  - QA evidence root: `thoughts/taras/qa/2026-05-06-design-system-audit/`
