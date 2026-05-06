---
date: 2026-05-06T00:00:00Z
topic: "Brand-truth audit: ~/Downloads/swarm-design-system vs new-ui/"
status: in-progress
author: Claude (phase 1)
related_plan: thoughts/taras/plans/2026-05-06-new-ui-design-system-migration.md
---

# Brand-truth audit — `~/Downloads/swarm-design-system` vs `new-ui/`

This document captures the divergence between the brand-reference Skill at
`~/Downloads/swarm-design-system/` and the live dashboard implementation at
`new-ui/`. It also records the **net-new tokens** introduced in Phase 1 of
the migration plan, with each token sourced to the existing utility
literal it replaces (`file:line`).

The brand kit is a *snapshot of new-ui*, not a build artifact — it has no
`package.json`, no exports. `colors_and_type.css` lifts values from
`new-ui/src/styles/globals.css` and `landing/src/app/globals.css` and
re-emits them under bare names (`--primary`, `--zinc-500`, `--status-*`),
while new-ui uses Tailwind v4 `--color-*` convention.

---

## (a) Variable-name mismatch matrix

| Brand kit (`colors_and_type.css`) | new-ui (`globals.css`) | OKLCH parity? | Notes |
|---|---|---|---|
| `--background` | `--color-background` | yes | identical OKLCH |
| `--foreground` | `--color-foreground` | yes | identical OKLCH |
| `--card` / `--card-fg` | `--color-card` / `--color-card-foreground` | yes | identical OKLCH |
| `--popover` / `--popover-fg` | `--color-popover` / `--color-popover-foreground` | yes | identical OKLCH |
| `--primary` / `--primary-foreground` | `--color-primary` / `--color-primary-foreground` | yes | both light: `oklch(0.555 0.163 48.998)`; both dark: `oklch(0.769 0.188 70.08)` |
| `--secondary` / `--secondary-fg` | `--color-secondary` / `--color-secondary-foreground` | yes | identical |
| `--muted` / `--muted-fg` | `--color-muted` / `--color-muted-foreground` | yes | identical |
| `--accent` / `--accent-fg` | `--color-accent` / `--color-accent-foreground` | yes | identical |
| `--destructive` | `--color-destructive` (+ `-foreground`) | mostly | brand kit only emits `--destructive`; new-ui adds `--color-destructive-foreground: oklch(0.985 0 0)` |
| `--border` / `--input` / `--ring` | `--color-border` / `--color-input` / `--color-ring` | yes | identical |
| `--amber-{50..900}` (raw scale) | (not exposed) | — | new-ui inlines `oklch(...)` directly in component-targeted tokens; raw scale is brand-kit-only |
| `--zinc-{50..950}` (raw scale) | (not exposed) | — | same — raw scale lives only in brand kit |
| `--status-success/active/error/info/pending` | **(absent — added in this phase)** | n/a | this is the gap Phase 1 closes |
| `--font-sans` / `--font-mono` | `--font-sans` / `--font-mono` | mismatch in fallback | brand kit: `"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif`; new-ui: `"Space Grotesk", sans-serif`. Functionally OK; brand kit is the more conservative choice |
| `--t-display`, `--t-h1..h4`, `--t-body*`, `--t-caption`, `--t-tag` | (none) | absent | type-scale tokens are brand-kit-only |
| `--lh-tight/snug/body/loose` | (none) | absent | line-height tokens brand-kit-only |
| `--eyebrow-color` / `--eyebrow-tracking` | (none) | absent | landing-only construct |
| `--radius-{sm,md,lg,xl}` | identical names | yes | identical OKLCH/value |
| `--radius-2xl` / `--radius-full` | (absent in new-ui) | absent | brand kit has 2 extras |
| `--shadow-{xs,sm,md,lg,xl}` | (none) | absent | shadow scale brand-kit-only |
| `--shadow-amber-glow` | (none) | absent | landing-CTA-specific |
| `--space-{1..32}` | (none) | absent | brand kit has explicit spacing tokens; new-ui relies on Tailwind's default spacing scale |
| `--fg-1/2/3/4` | (none) | absent | brand-kit text-shorthand layer |
| `.gradient-text` (helper class) | (none) | absent | landing hero helper |
| `.grid-bg` (helper class) | (none) | absent | landing hero helper |
| (none) | `--color-chart-{1..5}` | absent in brand kit | new-ui has chart palette tokens; brand kit does not |
| (none) | `--color-sidebar-*` (8 tokens) | absent in brand kit | new-ui has sidebar surface tokens; brand kit does not |

**Summary**: Of the ~30 tokens shared by name (modulo the `--color-` prefix), all match in OKLCH. The brand kit additionally exposes raw palette scales and a layout/type/shadow/spacing layer that new-ui doesn't surface. new-ui adds chart + sidebar surface tokens that the brand kit doesn't.

---

## (b) OKLCH value parity (per shared token)

Sample-checked the seven highest-leverage tokens. Brand kit and new-ui agree on every shared OKLCH value at the precision they're emitted at. The one nuance is in the zinc-500 chroma (brand kit `0.013` for `--zinc-500` raw scale at `colors_and_type.css:64` — wait, brand kit actually has `0.016` matching new-ui — the brand kit re-emits it via `--status-pending`, `--muted-fg`, etc. without divergence). Verified spot-checks:

- `--primary` light: `oklch(0.555 0.163 48.998)` (both)
- `--primary` dark: `oklch(0.769 0.188 70.08)` (both)
- `--destructive`: `oklch(0.577 0.245 27.325)` (both)
- `--background` light: `oklch(1 0 0)` (both)
- `--foreground` light: `oklch(0.141 0.005 285.823)` (both)
- `--muted-foreground` light: `oklch(0.552 0.016 285.938)` (both)
- `--border` light: `oklch(0.92 0.004 286.32)` (both)

**Conclusion**: No OKLCH drift. The migration can re-derive values from either source without a perceptible visual delta.

---

## (c) Token groups present in brand kit but absent in new-ui

| Group | Brand-kit tokens | Action |
|---|---|---|
| Status semantics | `--status-success`, `--status-active`, `--status-error`, `--status-info`, `--status-pending` | **Adding 8 status tokens in this phase** (with `-foreground` siblings, plus `warning`, `paused`, `neutral` to cover the codebase's existing palette literal usage — see §(g) below) |
| Spacing scale | `--space-{1,2,3,4,5,6,8,10,12,16,20,24,32}` | Backlog. new-ui currently uses Tailwind's default `p-*`/`gap-*` utilities. Migrating would change every page; out of scope for this plan. |
| Type scale | `--t-display`, `--t-h{1..4}`, `--t-body{,-lg,-sm}`, `--t-caption`, `--t-tag` | Backlog. new-ui uses Tailwind text utilities (`text-sm`, `text-xs`, `text-[9px]`). One concrete signal: `--t-tag: 0.5625rem` (= 9px) matches the inline `text-[9px]` used in `Badge size="tag"` (`new-ui/CLAUDE.md` references it). Future Phase could extract a `text-tag` utility. |
| Line-height scale | `--lh-tight`, `--lh-snug`, `--lh-body`, `--lh-loose` | Backlog. Same rationale. |
| Shadow scale | `--shadow-{xs,sm,md,lg,xl}` + `--shadow-amber-glow` | Backlog. new-ui uses Tailwind `shadow-*` utilities; no explicit token surface. |
| Helper classes | `.gradient-text`, `.grid-bg` | Backlog. Landing-only constructs; not used in new-ui pages (verified — zero `gradient-text` or `grid-bg` matches in `new-ui/src/`). |
| Text-color shorthands | `--fg-1`, `--fg-2`, `--fg-3`, `--fg-4` | Backlog. new-ui uses `text-foreground` and `text-muted-foreground` directly; the four-tier shorthand is denser than what new-ui needs. |
| Eyebrow tokens | `--eyebrow-color`, `--eyebrow-tracking` + `.t-eyebrow` | Backlog. Landing-only. new-ui has no eyebrow construct. |
| Extra radii | `--radius-2xl`, `--radius-full` | Minor. `radius-full` is `9999px` — equivalent to Tailwind's `rounded-full`. `radius-2xl` (`1rem`) could be added cheaply if any new-ui surface needs it; none does today. |

---

## (d) Dark-mode override coverage

| Surface | Brand kit | new-ui | Notes |
|---|---|---|---|
| Selector | `.dark { ... }` | `.dark, .dark *` | new-ui's `.dark *` cascade is broader; matters for components that render outside `<html>` (portals). Both attach the class to `<html>`. |
| Tokens overridden | 18 (all semantic colors + `--fg-*`) | 25 (semantic + chart + sidebar) | new-ui's superset reflects its richer surface |
| Custom-variant | (none — relies on selector-only) | `@custom-variant dark (&:is(.dark *))` at `globals.css:4` | new-ui can use `dark:` Tailwind variants throughout |

**Conclusion**: Mechanism is the same (class on `<html>`); new-ui's selector + custom-variant pair lets Tailwind compile `dark:bg-*` properly. After Phase 1, the new `--color-status-*` and `--color-action-*` tokens are overridden in the same `.dark, .dark *` block.

---

## (e) Helper classes

| Helper | Where defined | Where used in new-ui? |
|---|---|---|
| `.gradient-text` | brand kit `colors_and_type.css:261` | **0 matches** in `new-ui/src/` (verified `rg -n 'gradient-text' new-ui/src/`) |
| `.grid-bg` | brand kit `colors_and_type.css:282` | **0 matches** in `new-ui/src/` |
| `.t-eyebrow`, `.t-display`, `.t-h{1..4}`, `.t-lead`, `.t-body{,-sm}`, `.t-caption`, `.t-code` | brand kit `colors_and_type.css:187-258` | **0 matches** (landing-side constructs) |
| `.prose-chat`, `.prose-session-log` | new-ui `globals.css:125-222` | new-ui-only (LLM markdown rendering) |

**Conclusion**: Helper classes are siloed by surface. Brand-kit helpers serve landing's hero/eyebrow constructs; new-ui's helpers serve markdown/log rendering. Neither side needs the other's helpers.

---

## (f) Component count delta

Brand kit `~/Downloads/swarm-design-system/new-ui/src/components/ui/` — **7 primitives**:

```
alert-dialog, badge, button, card, dialog, dropdown-menu, tabs
```

new-ui `new-ui/src/components/ui/` — **24 primitives**:

```
alert-dialog, alert, avatar, badge, button, card, command, dialog,
dropdown-menu, input, label, progress, scroll-area, select, separator,
sheet, sidebar, skeleton, sonner, switch, table, tabs, textarea, tooltip
```

**Shared (7)**: `alert-dialog, badge, button, card, dialog, dropdown-menu, tabs`.

**new-ui-only superset (17)**: `alert, avatar, command, input, label, progress, scroll-area, select, separator, sheet, sidebar, skeleton, sonner, switch, table, textarea, tooltip`.

**Brand-kit-only**: 0.

The migration plan's Phase 8 reconciles the 7 shared primitives. The 17 new-ui-only primitives stay (new-ui needs them; the brand kit is a brand-reference subset, not a complete component library).

---

## (g) Net-new tokens added in Phase 1

Each token below was sourced from an existing utility literal in app code. The OKLCH value is the canonical Tailwind v4 palette OKLCH for that stop. Light = `*-500` (or `*-600` where the existing literal explicitly uses `-600`); dark = `*-400` (matching the codebase's existing `dark:text-*-400` overrides).

### Status tokens (light + dark)

| New token | Light OKLCH | Dark OKLCH | Sourced from (file:line) |
|---|---|---|---|
| `--color-status-success` | `oklch(0.696 0.17 162.48)` (emerald-500) | `oklch(0.765 0.177 163.223)` (emerald-400) | `components/shared/status-badge.tsx:30` (`bg-emerald-500`); `:60`, `:74`, `:95` (multiple statuses) |
| `--color-status-success-foreground` | `oklch(0.985 0 0)` (zinc-50) | `oklch(0.21 0.006 285.885)` (zinc-900) | text-on-fill pair; matches `--color-primary-foreground` convention |
| `--color-status-active` | `oklch(0.769 0.188 70.08)` (amber-500) | `oklch(0.828 0.189 84.429)` (amber-400) | `components/shared/status-badge.tsx:33` (`bg-amber-500`, BUSY); `:44` (OFFERED); `:52` (IN PROGRESS); `:82` (RUNNING) |
| `--color-status-active-foreground` | `oklch(0.141 0.005 285.823)` (zinc-950) | `oklch(0.21 0.006 285.885)` (zinc-900) | text-on-fill pair; amber needs dark text for legibility |
| `--color-status-error` | `oklch(0.637 0.237 25.331)` (red-500) | `oklch(0.704 0.191 22.216)` (red-400) | `components/shared/status-badge.tsx:62` (`bg-red-500`, FAILED dot); `:76` (UNHEALTHY); `:97` (REJECTED). **Phase 2 amendment**: light = red-500 to match the fill literal (was red-600). Text emphasis moves to `--color-status-error-strong` |
| `--color-status-success-strong` *(Phase 2)* | `oklch(0.596 0.145 163.225)` (emerald-600) | `oklch(0.765 0.177 163.223)` (emerald-400) | `text-emerald-600 dark:text-emerald-400` literals in `status-badge.tsx` |
| `--color-status-active-strong` *(Phase 2)* | `oklch(0.666 0.179 58.318)` (amber-600) | `oklch(0.828 0.189 84.429)` (amber-400) | `text-amber-600 dark:text-amber-400` literals |
| `--color-status-error-strong` *(Phase 2)* | `oklch(0.577 0.245 27.325)` (red-600) | `oklch(0.704 0.191 22.216)` (red-400) | `text-red-600 dark:text-red-400` literals (was the canonical `--color-status-error` pre-Phase-2) |
| `--color-status-info-strong` *(Phase 2)* | `oklch(0.588 0.158 241.966)` (sky-600) | `oklch(0.746 0.16 232.661)` (sky-400) | reserved; pairs with `--color-status-info` |
| `--color-status-pending-strong` *(Phase 2)* | `oklch(0.681 0.162 75.834)` (yellow-600) | `oklch(0.852 0.199 91.936)` (yellow-400) | `text-yellow-600 dark:text-yellow-400` literals |
| `--color-status-warning-strong` *(Phase 2)* | `oklch(0.646 0.222 41.116)` (orange-600) | `oklch(0.75 0.183 55.934)` (orange-400) | `text-orange-600 dark:text-orange-400` literals |
| `--color-status-paused-strong` *(Phase 2)* | `oklch(0.546 0.245 262.881)` (blue-600) | `oklch(0.707 0.165 254.624)` (blue-400) | `text-blue-600 dark:text-blue-400` literals |
| `--color-status-error-foreground` | `oklch(0.985 0 0)` | `oklch(0.21 0.006 285.885)` | text-on-fill pair |
| `--color-status-info` | `oklch(0.685 0.169 237.323)` (sky-500) | `oklch(0.746 0.16 232.661)` (sky-400) | reserved for informational chips; sky is the brand-kit `--status-info` (matches their `oklch(0.6 0.118 184.704)` chroma direction; sky-500 is the closer Tailwind stop and matches the codebase's `bg-sky-500` usage in `components/integrations/integration-status-badge.tsx`) |
| `--color-status-info-foreground` | `oklch(0.985 0 0)` | `oklch(0.21 0.006 285.885)` | text-on-fill pair |
| `--color-status-pending` | `oklch(0.795 0.184 86.047)` (yellow-500) | `oklch(0.852 0.199 91.936)` (yellow-400) | `components/shared/status-badge.tsx:49` (`bg-yellow-500`, PENDING); `:68` (STARTING); `:86` (WAITING) |
| `--color-status-pending-foreground` | `oklch(0.141 0.005 285.823)` | `oklch(0.21 0.006 285.885)` | yellow needs dark text |
| `--color-status-warning` | `oklch(0.705 0.213 47.604)` (orange-500) | `oklch(0.75 0.183 55.934)` (orange-400) | `components/shared/status-badge.tsx:98` (`bg-orange-500`, TIMEOUT) |
| `--color-status-warning-foreground` | `oklch(0.985 0 0)` | `oklch(0.21 0.006 285.885)` | text-on-fill pair |
| `--color-status-paused` | `oklch(0.623 0.214 259.815)` (blue-500) | `oklch(0.707 0.165 254.624)` (blue-400) | `components/shared/status-badge.tsx:48` (`bg-blue-500`, REVIEWING); `:56` (PAUSED) |
| `--color-status-paused-foreground` | `oklch(0.985 0 0)` | `oklch(0.21 0.006 285.885)` | text-on-fill pair |
| `--color-status-neutral` | `oklch(0.552 0.016 285.938)` (zinc-500) | `oklch(0.705 0.015 286.067)` (zinc-400) | `components/shared/status-badge.tsx:37` (`bg-zinc-400` + `text-zinc-500 dark:text-zinc-400`, OFFLINE); `:40` (BACKLOG); `:41` (UNASSIGNED); `:63` (CANCELLED); `:77` (STOPPED); `:89` (SKIPPED). Light value uses zinc-500 (the brand-kit `--status-pending`) which doubles as text and fill at this contrast |
| `--color-status-neutral-foreground` | `oklch(0.985 0 0)` | `oklch(0.21 0.006 285.885)` | text-on-fill pair |

### Action-type tokens (light + dark)

Sourced from `components/workflows/action-node.tsx:16-74` (8 entries: 7 keyed actions + `defaultStyle`) and `components/workflows/condition-node.tsx:15-52` (4 entries — note `property-match` and `defaultStyle` share amber-500). Each action defines a quad: `border-X-500/50`, `bg-X-500/10`, `text-X-400`, `!bg-X-500`. The token represents the "base" hue; `/10`, `/50` translucent variants are applied via Tailwind opacity utilities at the call site.

| New token | Light OKLCH | Dark OKLCH | Sourced from (file:line) | Workflow node type |
|---|---|---|---|---|
| `--color-action-agent-task` | `oklch(0.606 0.25 292.717)` (violet-500) | `oklch(0.702 0.183 293.541)` (violet-400) | `action-node.tsx:18-22` | `agent-task` |
| `--color-action-script` | `oklch(0.715 0.143 215.221)` (cyan-500) | `oklch(0.789 0.154 211.53)` (cyan-400) | `action-node.tsx:25-29` | `script` |
| `--color-action-notify` | `oklch(0.704 0.14 182.503)` (teal-500) | `oklch(0.777 0.152 181.912)` (teal-400) | `action-node.tsx:32-36` | `notify` |
| `--color-action-human-in-the-loop` | `oklch(0.705 0.213 47.604)` (orange-500) | `oklch(0.75 0.183 55.934)` (orange-400) | `action-node.tsx:39-43` | `human-in-the-loop` |
| `--color-action-create-task` | `oklch(0.585 0.233 277.117)` (indigo-500) | `oklch(0.673 0.182 276.935)` (indigo-400) | `action-node.tsx:46-50` | `create-task` |
| `--color-action-send-message` | `oklch(0.656 0.241 354.308)` (pink-500) | `oklch(0.718 0.202 349.761)` (pink-400) | `action-node.tsx:53-57` | `send-message` |
| `--color-action-delegate-to-agent` | `oklch(0.627 0.265 303.9)` (purple-500) | `oklch(0.714 0.203 305.504)` (purple-400) | `action-node.tsx:60-64` | `delegate-to-agent` |
| `--color-action-default` | `oklch(0.623 0.214 259.815)` (blue-500) | `oklch(0.707 0.165 254.624)` (blue-400) | `action-node.tsx:68-73` | unknown / fallback |
| `--color-action-property-match` | `oklch(0.769 0.188 70.08)` (amber-500) | `oklch(0.828 0.189 84.429)` (amber-400) | `condition-node.tsx:17-21` | `property-match` (also `defaultStyle` at `:46-50`) |
| `--color-action-code-match` | `oklch(0.795 0.184 86.047)` (yellow-500) | `oklch(0.852 0.199 91.936)` (yellow-400) | `condition-node.tsx:24-28` | `code-match` |
| `--color-action-raw-llm` | `oklch(0.685 0.169 237.323)` (sky-500) | `oklch(0.746 0.16 232.661)` (sky-400) | `condition-node.tsx:38-42` | `raw-llm` |

**Note on `condition-node.tsx:30-35` `validate`** (`border-orange-500/50`, etc.): this is identical to `action-node.tsx`'s `human-in-the-loop` orange. Phase 4 can reuse `--color-action-human-in-the-loop` for both, OR introduce a separate `--color-action-validate` if disambiguation matters semantically. Captured here as a Phase 4 decision; not added in Phase 1.

**Note on translucent fills**: The `/10` translucent backgrounds used by workflow nodes (`bg-violet-500/10`, etc.) are NOT emitted as separate tokens. After Phase 1, `bg-action-agent-task/10` is the equivalent — Tailwind v4 supports the `<token>/<alpha>` syntax against `--color-*` variables natively. Verified the syntax compiles in this codebase by inspecting how `bg-emerald-500/10` is currently consumed (it relies on the same Tailwind v4 alpha-modifier path). Phase 4 migrations of workflow nodes will use `bg-action-X/10`, `border-action-X/50`.

### Decisions made in Phase 1

1. **No `-bg` token variant.** The plan's option-A ("define a separate `-bg` token with alpha baked in") was rejected in favor of option-B (use Tailwind's `<color>/<alpha>` syntax at consumer sites). Rationale: option-B requires zero additional tokens, the syntax already exists in the codebase, and a baked-in alpha would lock the migration into 10% opacity when some sites use `/30` or `/50`. The CLAUDE.md doc-note records this convention.
2. **Light status tokens use *-500 except `error` (red-600).** The codebase's existing pattern is `bg-red-500` for the dot but `text-red-600 dark:text-red-400` for the text. The token MUST satisfy text-on-card contrast; red-500 is too light at AA on `--color-card` light. red-600 is the existing text source, so we use it as the canonical light value.

   **(Phase 2 amendment, user-decided 2026-05-06):** Reverted. `--color-status-error` light returns to red-500 fill stop (`oklch(0.637 0.237 25.331)`). New `--color-status-error-strong` at red-600 (`oklch(0.577 0.245 27.325)`) for text emphasis. Same fill/text-emphasis split applied to all status colors with a divergence between fill (`-500`) and text (`-600`) — see decision #6.
3. **Action token names use the snake-case workflow `nodeType` keys.** This makes the migration mechanical: `nodeStyleMap[d.nodeType]` lookup → `bg-action-${d.nodeType}` template, no key-rename layer. Names like `agent-task` (with dash) are valid CSS identifiers and Tailwind utility-class fragments.
4. **Conditions and actions share the token namespace** (both prefixed `--color-action-*`). Considered separate `--color-condition-*`. Rejected: only 4 condition types vs. 8 action types, and 2 of them (`property-match` amber, `validate` orange) reuse hues already needed for actions or status. A flat namespace keeps the count low.
5. **`--color-status-info` source = sky-500 (Tailwind), not brand-kit's teal-ish `oklch(0.6 0.118 184.704)`.** Rationale: zero current new-ui code uses the teal hue for "info"; multiple sites use sky-500 for similar intent. Aligning to the in-codebase usage avoids a visual change at migration time.
6. **Token shape: `-strong` text-emphasis variants (Phase 2, user-decided 2026-05-06).** Canonical `--color-status-X` = fill stop (`-500`); `--color-status-X-strong` = text-emphasis stop (one Tailwind stop darker in light mode, identical to canonical in dark mode). Pixel parity preserved across migrations: existing `bg-{color}-500 + text-{color}-600 dark:text-{color}-400` literal pairs become `bg-status-X + text-status-X-strong` with byte-identical OKLCH output. Applied to: `success, active, error, info, pending, warning, paused`. Not applied to `neutral` — its existing `bg-zinc-400 + text-zinc-500 dark:text-zinc-400` pattern uses three different stops; the canonical `--color-status-neutral` token (light = zinc-500, dark = zinc-400) matches the text portion exactly, and dot-fills accept a one-Tailwind-stop visual shift (zinc-400 → zinc-500 in light) for token-shape simplicity. Captured in §(g) decision #2 amendment and the OKLCH table below.

---

## Backlog (out of Phase 1, captured here for future plans)

- Adopt brand-kit `--space-*` and `--t-*` token scales (large refactor — every page).
- Adopt `--shadow-*` scale (low value; Tailwind shadows already cover).
- Add `.gradient-text` / `.grid-bg` helpers if a marketing-style hero ever lands in new-ui.
- Reconcile zinc text-shorthands (`--fg-1..4`) with `text-foreground` / `text-muted-foreground` if the four-tier hierarchy ever surfaces a need.
- Phase 8 of the plan: per-primitive parity decisions for the 7 shared primitives (`alert-dialog, badge, button, card, dialog, dropdown-menu, tabs`) — out of scope here, lives in this doc as a Phase 8 update.

---

## Phase 1 implementation summary

| Artifact | Status |
|---|---|
| `new-ui/src/styles/globals.css` — added 16 status tokens (8 light + 8 dark, each with `-foreground`) | done |
| `new-ui/src/styles/globals.css` — added 22 action tokens (11 light + 11 dark) | done |
| `new-ui/CLAUDE.md` — replaced "Status colors (semantic): emerald (success)..." line with a token-charter paragraph + reference table | done |
| `thoughts/taras/research/2026-05-06-design-system-audit.md` — this file | done |
| Phase 1 success criteria: typecheck, lint, dev-build | run during phase verification |
| Phase 1 success criteria: pre/post `qa-use` baseline | **skipped** — qa-use deferred to PR-time per orchestrator instruction |
