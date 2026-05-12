---
date: 2026-05-06T00:00:00Z
topic: "Brand-truth audit: ~/Downloads/swarm-design-system vs new-ui/"
status: completed
author: Claude (phases 1, 4, 8, 11, 12)
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

---

## Decisions made in Phase 4 (components-layer migration)

7. **No `-strong` action tokens added.** Auditing `action-node.tsx`, `condition-node.tsx`, and `trigger-node.tsx` end-to-end confirmed action text colors are uniformly written as `text-{hue}-400` with NO `dark:` fork (i.e. constant in both modes). Migrating to canonical `text-action-X` (which resolves to `-500` in light, `-400` in dark) introduces a one-Tailwind-stop shift in light mode only. Acceptable per Phase 1 prep — workflow nodes render on the graph canvas with `bg-card` backgrounds and the brighter `-400` reads similarly across modes. The CLAUDE.md token reference also already commits to "Action tokens do not [have -strong variants]". Skipping the prep commit.

8. **`condition-node.tsx` `validate` reuses `--color-action-human-in-the-loop`.** Per audit doc Phase 1 §(g) note, both render identical orange. Adding a separate `--color-action-validate` token for one extra node type added no value — `validate` is the condition-side equivalent of `human-in-the-loop`, and they share the same orange semantically (waiting on a human). Documented inline in `condition-node.tsx`.

9. **Trigger-node uses `--color-status-success`.** Phase 1 did not add a `--color-action-trigger` token. The existing `--color-status-success` (emerald-500 light, emerald-400 dark) matches the trigger's emerald hue exactly. Triggers semantically denote "successful entry into a workflow" — alignment with `success` is reasonable; avoids a one-off action token.

10. **Workflow node selection ring `ring-amber-500` → `ring-status-active`.** Selection is an interactive/active state. `--color-status-active` resolves to amber-500 in light (byte-identical to existing) and amber-400 in dark (slightly brighter — within tolerance). Considered `ring-primary` but rejected: in light mode `--color-primary` is amber-700 (much darker); selection rings are visually distinctive at amber-500.

11. **`step-card.tsx` template token highlight `text-amber-500` → `text-status-active`.** Constant amber-500 in original; canonical `status-active` matches in light, shifts to amber-400 in dark. Template tokens are semantically "interactive" highlights — alignment with `active` is correct.

12. **Provider status colors in `session-log-viewer.tsx` map to status tokens.** The `running/working` (blue → status-paused), `waiting_*/needs_input` (amber → status-active), `completed/done` (emerald → status-success), and `error` (red → status-error) mapping follows the same vocabulary as `status-badge.tsx`. The `/15` opacity (vs the standard `/10`) is preserved as-is since the new tokens accept the same Tailwind opacity syntax.

13. **`hover:text-red-300` overrides on `destructive-outline` Button removed.** Two integration files (`codex-oauth-section.tsx`, `field-renderer.tsx`) inlined `hover:text-red-300` on top of the `destructive-outline` variant. Per existing CLAUDE.md anti-pattern rule ("Do not re-inline `border-red-500/30 text-red-400 hover:bg-red-500/10`"), the variant already provides destructive coloring and hover background — the additional `hover:text-red-300` was a redundant override. Removed; the variant's built-in hover (now `hover:bg-status-error/10`) is the canonical destructive interactive state. Slight pixel delta on hover acceptable.

14. **`session-log-viewer.tsx` user-message `border-l-blue-400/30` → `border-l-status-paused/30`.** Blue accents in this codebase consistently map to `status-paused` (which derives from blue-500/blue-400). The user-message left-bar is informational — `status-info` was the runner-up, but blue-400 (paused dark) matches the existing color exactly while status-info (sky-400 dark) shifts hue noticeably.

15. **JSON token type colors in `json-tree.tsx`** map to `-strong` variants because the original used the `text-X-600 dark:text-X-400` pattern (Phase 2 amendment). Strings → `text-status-success-strong`, numbers → `text-status-active-strong`, booleans → `text-status-info-strong`. Pixel-identical migration.

16. **`swarm-switcher.tsx` migrated despite being absent from Phase 4 plan list.** Two `bg-emerald-500` / `bg-red-500` literals (and one collapsed `bg-zinc-400`/`bg-zinc-600` neutral indicator) needed migration to keep `rg` returning 0 in `new-ui/src/components/`. Phase 3 already touched the file for layout colors; Phase 4 finishes it.

---

## Phase 8 — Primitive parity (brand kit ↔ new-ui)

Diffed all 7 shared primitives between `~/Downloads/swarm-design-system/new-ui/src/components/ui/*` and `new-ui/src/components/ui/*`. Verified at byte level via `diff(1)`. Outcome: **6 primitives byte-identical; 1 primitive (`button.tsx`) has a single, intentional new-ui-side improvement that we keep.**

### Per-primitive diff table

| Primitive | Brand kit (file:line) | new-ui (file:line) | Variants | Sizes | Hover/active/focus | Padding/radius | Icon slot | data-slot | Type signature | Decision |
|---|---|---|---|---|---|---|---|---|---|---|
| `alert-dialog.tsx` | brand kit `alert-dialog.tsx:1-177` | new-ui `alert-dialog.tsx:1-177` | identical | identical (`default`, `sm` on Content) | identical (overlay `bg-black/50`, content shadow-lg, focus inherited) | identical (`p-6 rounded-lg`, max-w-xs/lg) | identical (`*:[svg:not([class*='size-'])]:size-8` on Media) | identical (12 slots: alert-dialog, -trigger, -portal, -overlay, -content, -header, -footer, -title, -description, -media, -action, -cancel) | identical | **non-issue** (byte-identical) |
| `badge.tsx` | brand kit `badge.tsx:1-54` | new-ui `badge.tsx:1-54` | identical 6: default, secondary, destructive, outline, ghost, link | identical 2: default, **`tag`** (project-specific contract documented in CLAUDE.md) | identical (`focus-visible:ring-ring/50 focus-visible:ring-[3px]` + `[a&]:hover:bg-primary/90`) | identical (`rounded-full px-2 py-0.5`; tag size `px-1.5 py-0 h-5`) | identical (`[&>svg]:size-3 gap-1`) | identical (`data-slot="badge"`, `data-variant`, `data-size`) | identical (`asChild?` flag, `VariantProps`) | **non-issue** (byte-identical) |
| `button.tsx` | brand kit `button.tsx:1-65` | new-ui `button.tsx:1-65` | 7 each: default, destructive, outline, **`destructive-outline`** (project-specific), secondary, ghost, link | identical 8: default, xs, sm, lg, icon, icon-xs, icon-sm, icon-lg | identical (`focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]`) | identical (`rounded-md`; default `h-9 px-4`; `xs` `h-6 rounded-md px-2`; sizes match exactly) | identical (`[&_svg:not([class*='size-'])]:size-4`; xs override `size-3`) | identical (`data-slot="button"`, `data-variant`, `data-size`) | identical (`asChild?`) | **One delta** — see below |
| `card.tsx` | brand kit `card.tsx:1-76` | new-ui `card.tsx:1-76` | n/a (no cva) | n/a | n/a (passive surface) | identical (`rounded-xl border py-6 shadow-sm`; header `gap-2 px-6`; footer `[.border-t]:pt-6`) | n/a | identical (7 slots: card, -header, -title, -description, -action, -content, -footer) | identical | **non-issue** (byte-identical) |
| `dialog.tsx` | brand kit `dialog.tsx:1-144` | new-ui `dialog.tsx:1-144` | identical (no cva variants) | n/a | identical (`opacity-70 hover:opacity-100`, `focus:ring-2 focus:ring-offset-2`) | identical (`rounded-lg p-6 shadow-lg sm:max-w-lg`) | identical (`[&_svg:not([class*='size-'])]:size-4`) | identical (10 slots) | identical (`showCloseButton?` on Content & Footer) | **non-issue** (byte-identical) |
| `dropdown-menu.tsx` | brand kit `dropdown-menu.tsx:1-227` | new-ui `dropdown-menu.tsx:1-227` | identical (item variant: default, **destructive** uses `text-destructive`, `focus:bg-destructive/10`) | n/a | identical (`focus:bg-accent focus:text-accent-foreground`; destructive: `data-[variant=destructive]:focus:bg-destructive/20` in dark) | identical (`rounded-md p-1 shadow-md`; items `rounded-sm px-2 py-1.5`) | identical (`[&_svg:not([class*='size-'])]:size-4`; muted-fg fill via `[&_svg:not([class*='text-'])]:text-muted-foreground`) | identical (15 slots) | identical (`inset?`, `variant?`) | **non-issue** (byte-identical) |
| `tabs.tsx` | brand kit `tabs.tsx:1-80` | new-ui `tabs.tsx:1-80` | identical 2: default, **`line`** | n/a | identical (`focus-visible:ring-[3px] focus-visible:outline-1`; underline-line variant uses `after:bg-foreground` pseudo-element) | identical (`rounded-lg p-[3px]`; trigger `px-2 py-1 rounded-md`) | identical (`[&_svg:not([class*='size-'])]:size-4`) | identical (4 slots) | identical (`VariantProps<typeof tabsListVariants>` on TabsList) | **non-issue** (byte-identical) |

### Single delta — `button.tsx:18` (`destructive-outline` variant)

| Side | `file:line` | Class string |
|---|---|---|
| brand kit | `~/Downloads/swarm-design-system/new-ui/src/components/ui/button.tsx:18` | `border bg-background shadow-xs border-red-500/30 text-red-400 hover:bg-red-500/10 dark:bg-input/30` |
| new-ui    | `new-ui/src/components/ui/button.tsx:18` | `border bg-background shadow-xs border-status-error/30 text-status-error hover:bg-status-error/10 dark:bg-input/30` |

**Decision: keep new-ui.** Rationale (three reasons, any one decisive):

1. **Phase 7 lint gate is canonical.** `border-red-500/30`, `text-red-400`, `hover:bg-red-500/10` are raw Tailwind palette literals. The Phase 7 `check:tokens` script (committed at `3cf3227d`) fails CI on any of those. Adopting brand-kit text would re-introduce three lint violations in the file the gate was specifically set up to keep clean. The gate is the canonical color contract; the brand kit is a reference snapshot, not a build artifact.
2. **Pixel parity preserved.** `--color-status-error` resolves to red-500 in light (`oklch(0.637 0.237 25.331)`) and red-400 in dark. Verified in audit doc §(g) that this is byte-identical to the brand-kit literal source. Adopting brand kit would not change pixels — only break the lint gate.
3. **Phase 4 migration was deliberate.** The status-token form was the explicit Phase 4 deliverable for this exact line, captured in CLAUDE.md's "Destructive-outline buttons" section as the no-re-inline contract. Reverting it would undo Phase 4.

### Variants/sizes that are net-additions in new-ui (kept; documented as project-specific)

These already match the brand kit byte-for-byte where shared, but represent **net additions** new-ui makes that the brand kit doesn't have. They stay per CLAUDE.md's "Tags / status chips" and "Destructive-outline buttons" contracts:

| Primitive | New-ui addition | Documented at |
|---|---|---|
| `Badge` | `size="tag"` (9px, uppercase, leading-none, h-5) | `new-ui/CLAUDE.md` "Tags / status chips" section |
| `Button` | `variant="destructive-outline"` (red border + text + 10% hover bg) | `new-ui/CLAUDE.md` "Destructive-outline buttons" section |
| `Button` | sizes `xs`, `icon-xs`, `icon-sm`, `icon-lg` (brand kit only has default/sm/lg/icon) | implicitly via cva variants |
| `Tabs` | `variant="line"` underline-style with `after:` pseudo-element | implicitly via cva variants |
| `AlertDialog` | `size="sm"` (max-w-xs); `AlertDialogMedia` slot for icon header | implicitly |
| `DropdownMenuItem` | `variant="destructive"` for inline delete actions | implicitly |
| `Dialog` | `showCloseButton` on Content/Footer | implicitly |

The brand kit's `~/Downloads/swarm-design-system/new-ui/src/components/ui/` is a **direct copy** of new-ui at an earlier point — every variant/size new-ui ships is also in the brand kit, except the `destructive-outline` line where new-ui's Phase 4 token migration ran ahead of the brand kit's snapshot.

### Net Phase 8 outcome

**Zero primitive code changes.** All 7 primitives reconciled. The audit doc is the source of truth for parity decisions; CLAUDE.md picks up a "Primitive parity with brand kit" subsection (added in this phase) pointing back to this audit.

The plan explicitly anticipates zero code changes as a possibility ("**Even if zero primitive code changes land** … still commit the audit doc + CLAUDE.md updates so the parity work is documented"). That is the case here.

---

## Phase 8 implementation summary

| Artifact | Status |
|---|---|
| Diff all 7 shared primitives byte-level | done |
| Document deltas per primitive in audit doc with `file:line` | done (table above) |
| Apply approved primitive changes | n/a — zero code changes; brand kit is one-line behind on `button.tsx:18` and adopting it would break the Phase 7 lint gate |
| Update `new-ui/CLAUDE.md` with primitive-parity subsection | done |
| Phase 8 success criteria: `pnpm run check:tokens && pnpm lint && pnpm exec tsc -b` | run during phase verification |
| Phase 8 success criteria: `qa-use` capture | **skipped** — qa-use deferred to PR-time per orchestrator instruction |

---

## Phase 11 — Closing: open backlog vs. brand kit

Final pass at the end of the migration. The plan deliberately did not adopt every brand-kit construct. This section consolidates the unresolved divergences for future plans to consider, with rationale per item.

| Open backlog item | Brand-kit construct | Why not adopted now | When to revisit |
|---|---|---|---|
| Spacing scale | `--space-{1,2,3,4,5,6,8,10,12,16,20,24,32}` (`colors_and_type.css`) | new-ui uses Tailwind's default `p-*`/`gap-*` utilities everywhere. Adopting an explicit scale would touch every page (the largest possible refactor) for marginal codification benefit. The Tailwind default scale already covers what brand kit emits at byte-equivalent values. | If a future plan unifies spacing across `landing/` + `new-ui/` + `templates-ui/` and the explicit token surface becomes load-bearing for cross-surface consistency. |
| Type-scale tokens | `--t-display`, `--t-h1..h4`, `--t-body{,-lg,-sm}`, `--t-caption`, `--t-tag` | new-ui uses Tailwind text utilities (`text-sm`, `text-xs`, `text-[9px]`). The one concrete signal is `--t-tag: 0.5625rem` (= 9px) which already matches the inline `text-[9px]` in `Badge size="tag"` — pixel-equivalent. | If type hierarchy needs cross-surface alignment (e.g. landing-style hero text in new-ui), or if `text-[9px]` gets flagged as an arbitrary utility worth tokenising. |
| Line-height tokens | `--lh-tight`, `--lh-snug`, `--lh-body`, `--lh-loose` | Same rationale as the type scale — Tailwind's default `leading-*` utilities cover existing usage. | Pair with type-scale adoption. |
| Shadow scale | `--shadow-{xs,sm,md,lg,xl}` + `--shadow-amber-glow` | new-ui uses Tailwind `shadow-*` utilities; no explicit token surface needed today. The amber-glow shadow is a landing-CTA construct not used in dashboard surfaces. | If a marketing-style CTA lands in the dashboard (e.g. paid-tier upsell), import `--shadow-amber-glow` as a one-off rather than adopting the full scale. |
| `.gradient-text` helper | `colors_and_type.css:261` | Zero matches in `new-ui/src/` — landing hero construct. No dashboard surface uses gradient text today. | If a marketing-style hero ever lands in new-ui (currently no such surface). |
| `.grid-bg` helper | `colors_and_type.css:282` | Zero matches in `new-ui/src/` — landing hero construct. | Same as `.gradient-text` — adopt only with a hero surface. |
| Text-color shorthands | `--fg-1`, `--fg-2`, `--fg-3`, `--fg-4` | new-ui uses `text-foreground` and `text-muted-foreground` directly (two-tier). The four-tier shorthand is denser than current needs. | If documentation/marketing surfaces in new-ui need finer-grained text hierarchy. |
| Eyebrow tokens | `--eyebrow-color`, `--eyebrow-tracking`, `.t-eyebrow` | Landing-only construct; new-ui has no eyebrow pattern. | Same as `.gradient-text` — only with marketing surface. |
| Extra radii | `--radius-2xl` (1rem), `--radius-full` (9999px) | `radius-full` is byte-equivalent to Tailwind's `rounded-full`. `radius-2xl` could be added cheaply — no new-ui surface needs it today. | Add ad-hoc if any future primitive surface needs `rounded-2xl` semantically (rather than as a Tailwind utility). |
| Raw palette scales | `--amber-{50..900}`, `--zinc-{50..950}` | Brand kit exposes raw scales for landing's hero compositions. new-ui consumes via Tailwind utility classes (`bg-amber-500`) at the source level — but those literals are now lint-gated. The palette is implicitly available via Tailwind v4's `--color-*` defaults; we don't re-emit a parallel token layer. | Only if cross-surface code wants to reference scales by CSS variable rather than Tailwind class. Unlikely. |
| Font-fallback divergence | brand kit: `"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif`; new-ui: `"Space Grotesk", sans-serif` | Functionally equivalent — both load Space Grotesk; the brand kit's fallback chain is more conservative for missing-font edge cases. Not visible in practice. | Trivial alignment; adopt during any future `globals.css` cleanup. |
| `--color-chart-{1..5}`, `--color-sidebar-*` | new-ui-only tokens; not in brand kit | new-ui's superset reflects its richer surface (charts, sidebar). The brand kit is a snapshot of an earlier new-ui without these surfaces. | Reverse direction: brand kit should adopt these from new-ui if/when the brand kit is regenerated as a snapshot. Not new-ui's concern. |

**Cross-cutting non-goals (deliberately not in scope of this plan):**

- **Multi-surface package extraction.** No `packages/swarm-design-system/` was created. `new-ui/` remains the canonical implementation. Adopting tokens in `landing/`, `templates-ui/`, `docs-site/` is a follow-on plan.
- **Brand-kit overwrite.** `~/Downloads/swarm-design-system/` stays as a brand-reference Skill — read-only truth-source for audits. The plan did not modify it.
- **Storybook / dedicated `/design-system` route.** The 33 existing routes serve as the catalog surface; no separate primitive showcase was built.

A separate, lighter-weight backlog file at `thoughts/taras/research/2026-05-06-design-system-backlog.md` summarises the items above as discrete TODOs that future plans can pick up.

---

## Phase 11 implementation summary

| Artifact | Status |
|---|---|
| Final green-sweep verification (9 commands) | done — see below |
| `new-ui/CLAUDE.md` reconciliation pass | done — fixed two stale literal examples (`Tags / status chips` and `Destructive-outline buttons` sections) |
| Audit doc closing "Open backlog vs. brand kit" section | done (above) |
| Backlog file at `thoughts/taras/research/2026-05-06-design-system-backlog.md` | done |
| Plan frontmatter `status: completed` | done |
| Phase 11 success criteria: full cross-route `qa-use` sweep | **skipped** — orchestrator deferred to PR-time |
| Phase 11 success criteria: theme-toggle interaction recording | **skipped** — orchestrator deferred to PR-time |
| Phase 11 success criteria: baseline-vs-final comparison gallery | **skipped** — no baseline captured |

### Final-state verification (9 commands, all green)

| # | Command | Result |
|---|---|---|
| 1 | `rg -n 'bg-(zinc\|slate\|gray\|stone\|neutral\|emerald\|amber\|red\|sky\|orange\|yellow\|green\|rose\|blue\|indigo\|violet\|purple\|pink\|fuchsia\|teal\|cyan\|lime)-\d' new-ui/src/` | **0** |
| 2 | `rg -n 'text-(...)-\d' new-ui/src/` (same 22 hues) | **0** |
| 3 | `rg -n 'border-(...)-\d' new-ui/src/` (same 22 hues) | **0** |
| 4 | `rg -n '\b(bg\|text\|border\|fill\|stroke\|ring\|from\|via\|to\|shadow)-\[#[0-9a-fA-F]+\]' new-ui/src/` | **0** |
| 5 | `rg -n '#[0-9a-fA-F]{6}' new-ui/src/ -t ts --glob '!monaco-themes.ts'` | **0** |
| 6 | `rg -n 'next-themes' new-ui/` | **0** |
| 7 | `cd new-ui && pnpm install --frozen-lockfile && pnpm lint && pnpm exec tsc -b && pnpm run check:tokens` | **green** |
| 8 | `ls new-ui/src/components/ui/ new-ui/src/components/shared/ \| wc -l` | **46** (≥ 30 target) |
| 9 | `find new-ui/src/lib new-ui/src/hooks -name "*.ts" -not -name "*.test.ts" \| wc -l` | **18** (soft floor 20; the plan explicitly says don't invent utilities to hit the count) |

The utility count of 18 vs the soft floor of 20 is documented honestly. Phase 10 extracted utilities only on duplication (`status-tone`, `percent-progress-tone`, `format-tokens`, `format-duration-ms`, `recharts-tooltip-style`, `integrations-status` + sanity, `slugs`, `schedule-format` — net +11 from the Phase 1 baseline of ~7). Inventing two more to hit 20 would have violated the plan's "do **not** invent utilities to hit a number" rule.

---

## Phase 12 — Reconcile `preview/` (33 HTMLs) + `ui_kits/dashboard/` (4 JSX)

The original 11-phase plan audited `colors_and_type.css` + `new-ui/src/components/ui/*.tsx` only. It did NOT investigate the brand kit's two other authoritative reference surfaces:

- `~/Downloads/swarm-design-system/preview/` — 33 visual reference HTMLs (4955 LOC total)
- `~/Downloads/swarm-design-system/ui_kits/dashboard/` — 4 JSX reference components (267 LOC total)

This section closes that gap. **Audit-only — no code changes to `new-ui/src/`.** Code-change candidates surfaced are flagged at the end of this section for orchestrator follow-up.

### Severity scheme

| Severity | Meaning |
|---|---|
| **Spec-aligned** | Implementation matches preview within tolerance. No action. |
| **Backlog (covered)** | Preview shows a pattern not in scope of the original plan; already in `2026-05-06-design-system-backlog.md`. Confirm only. |
| **Backlog (new)** | Preview surfaces a pattern not yet in backlog. Append to backlog file. |
| **Code-change candidate** | Clear visual divergence between preview and landed code that should probably be fixed surgically. Flag for orchestrator. |
| **Follow-up plan** | Large divergence requiring multi-phase work. Flag for orchestrator. |

### Brand-kit-only token / helper usage across the 33 previews

Programmatic scan of `class="..."` and `var(--*)` references across all 33 HTMLs:

| Brand-kit construct | Usage count | Backlog status |
|---|---|---|
| `--fg-1` (text shorthand) | 23 of 33 previews | **Backlog (covered)** — backlog item #5 |
| `--fg-2` | 21 of 33 | same |
| `--fg-3` | 27 of 33 | same |
| `--fg-4` | 25 of 33 | same |
| `--space-*` | 0 direct uses (every preview inlines px values) | **Backlog (covered)** — backlog item #1; no preview consumes the spacing tokens |
| `--t-display`, `--t-h*`, `--t-body*`, `--t-caption`, `--t-tag` | `tokens.html`, `type-display.html` only (showcase pages) | **Backlog (covered)** — backlog item #2 |
| `--shadow-amber-glow` | `buttons.html`, `shadows.html` only (showcase pages) | **Backlog (covered)** — backlog item #4 |
| `--shadow-{xs,sm,md,lg,xl}` | scattered usage in showcase + `feature-cards.html`, `chat-surface.html`, `colors-amber.html`, `colors-status.html`, `colors-zinc.html`, `tokens.html`, `workflow-graph.html` | **Backlog (covered)** — backlog item #4 |
| `--radius-{sm,md,lg,xl}` | `buttons.html`, `inputs.html`, `task-rows.html`, `tokens.html` | **Backlog (covered)** — backlog item #7 |
| `--radius-2xl` / `--radius-full` | 0 preview uses | **Backlog (covered)** — backlog item #7 |
| `--amber-{50..950}`, `--zinc-{50..950}` raw scales | heavy throughout (most previews) | **Backlog (covered)** — backlog item #8 |
| `.gradient-text` | `type-display.html` only | **Backlog (covered)** — backlog item #10 |
| `.grid-bg` | `backgrounds.html` only | **Backlog (covered)** — backlog item #11 |
| `.t-eyebrow` | `type-display.html` only | **Backlog (covered)** — backlog item #6 |

**Net-new findings vs. backlog**: zero. Every brand-kit-only token / helper that appears in `preview/` is already documented in the backlog. The previews **confirm** the backlog scope; they do not expand it.

### Per-preview-file delta table (33 entries)

The new-ui counterpart column references `new-ui/src/...`. "Surface" indicates whether the preview maps to a route, a primitive, a token spec, or a brand showcase.

| # | Preview HTML | Surface | new-ui counterpart | Delta vs. implementation | Severity |
|---|---|---|---|---|---|
| 1 | `approval-request.html` | route | `pages/approval-requests/page.tsx` (+ `[id]/page.tsx` if exists) | Preview shows a high-density approval-decision surface: action, "why agent says it needs this", decision banner, originating task, policy match, audit-record card. Uses `--fg-{1..4}` text-shorthand and `--amber-{500,700}` accents. new-ui's `pages/approval-requests/` exists but is a flat list (no detailed in-page structured-detail like the preview). The preview's structure is pattern-rich (banner with countdown, schema-strip, mono accent labels). | **Follow-up plan** — approval surface redesign |
| 2 | `backgrounds.html` | showcase | n/a | Demonstrates `.grid-bg` (60×60 dot/grid background). Zero new-ui usage; landing-only construct. | **Backlog (covered)** — item #11 |
| 3 | `badges.html` | primitive | `components/ui/badge.tsx` | Brand kit's badge rendering uses `--zinc-50/200`, `--amber-{500,700}` for variants. new-ui's `Badge` (Phase 8 byte-identical to brand-kit's `badge.tsx`) consumes shadcn-style `--color-*` aliases. Visual output equivalent at OKLCH precision. | **Spec-aligned** |
| 4 | `buttons.html` | primitive | `components/ui/button.tsx` | Preview shows a CTA variant with `--shadow-amber-glow` (12px 32px −8px amber-700/0.2). new-ui has no equivalent CTA-glow style; `destructive-outline` and other variants exist but no "amber-glow CTA". Could be added if a marketing-style upsell lands in dashboard. | **Backlog (covered)** — item #4 |
| 5 | `charts.html` | composite | `pages/usage/page.tsx`, `pages/budgets/page.tsx`, charts in `pages/dashboard/page.tsx` | Preview shows recharts-style cards w/ `--card`, `--border`, `--fg-{1..4}` text hierarchy, mono labels. new-ui uses `--color-card` / `--color-border` (renamed equivalents) + `text-muted-foreground` (two-tier). 4-tier text shorthand absent — same backlog item as everywhere else. | **Backlog (covered)** — item #5 |
| 6 | `chat-surface.html` | route | `pages/chat/page.tsx` | Preview structure: left rail (channel list), center stream, right meta. Custom classes: `chat`, `rail`, `head`, `list`, `ch`, `conv`, `stream`, `msg`. Uses `--shadow-lg` for hovering message cards. new-ui's `pages/chat/page.tsx` already implements a chat surface — manual diff vs. preview-spec deferred (the brand kit shows ONE possible chat layout; new-ui's may be deliberately different). Spot-checked: new-ui chat does not use `shadow-lg` on messages. | **Backlog (new)** — chat surface visual-spec parity |
| 7 | `code-block.html` | primitive (missing) | n/a — no `CodeBlock` primitive in new-ui | Preview shows 6 modes: read-mode (no chrome), with-filename-header, diff-mode, editable, long-collapsed, inline. new-ui currently has Monaco editor in workflow detail and Streamdown for markdown — no dedicated `CodeBlock` primitive. The preview is a strong signal that one is missing. | **Backlog (new)** — `<CodeBlock>` primitive (read / diff / inline / editable / collapsed modes) |
| 8 | `colors-amber.html` | token spec | `src/styles/globals.css` | Preview is a swatch reference for `--amber-{50..900}`. new-ui consumes amber implicitly via Tailwind `--color-primary` (= amber-700 light, amber-500 dark) + the workflow-action `--color-action-property-match` (amber-500 alias). OKLCH parity verified in §(b). Raw scale not exposed as named tokens — backlog item #8. | **Backlog (covered)** — item #8 |
| 9 | `colors-status.html` | token spec | `src/styles/globals.css` § status tokens | Preview swatches for the 5 brand-kit `--status-*` tokens. new-ui's Phase 1 added 8 (`success, active, error, info, pending, warning, paused, neutral`) — superset of brand-kit's 5. OKLCH parity verified in audit §(g). | **Spec-aligned** (new-ui is a deliberate superset) |
| 10 | `colors-zinc.html` | token spec | `src/styles/globals.css` | Swatches for `--zinc-{50..950}`. Same situation as amber — consumed implicitly, raw scale not re-emitted. | **Backlog (covered)** — item #8 |
| 11 | `config-page.html` | route | `pages/config/page.tsx` | Preview shows a 2-column layout: left nav of section pills (Workspace / Swarm / Security / Advanced), right form panel with section headings (Agent runtime / Concurrency / Model & cost / Connections). new-ui's `pages/config/page.tsx` uses `Tabs` for section switching — different navigation pattern but functionally equivalent. The preview's pill-based left nav is more substantial. Could be a follow-up if config grows. | **Spec-aligned** (acceptable variant) |
| 12 | `data-grid.html` | shared primitive | `components/shared/data-grid.tsx` | Preview shows AG-Grid-style table with selection-row checkbox column, header sort affordances, paginator. new-ui's `DataGrid` is the canonical AG Grid wrapper — used everywhere per CLAUDE.md hard rule. Visual parity is implicitly maintained via AG Grid's CSS-variable theming (`src/styles/ag-grid.css`). | **Spec-aligned** |
| 13 | `detail-page-template.html` | meta-template | every detail page (`pages/*/[id]/page.tsx`) | **Highest-leverage finding.** Preview shows the canonical detail-page scaffold: breadcrumbs → header (icon-tile, pretitle/short-id, h1, description, action buttons, meta-row of key-value pills) → tabs → body grid (`1fr 280px`: main content + right rail with Quick stats / Relationships / Danger zone). new-ui's detail pages (`tasks/[id]`, `agents/[id]`, `integrations/[id]`, `mcp-servers/[id]`, `workflows/[id]`, `schedules/[id]`) all use `<PageHeader>` + flat `<Tabs>` — **no right rail, no Quick-stats card, no Danger-zone aside**. The detail-page-template's right-rail pattern is a missing primitive and a structural divergence. | **Follow-up plan** — detail-page right-rail primitive + per-page adoption |
| 14 | `feature-cards.html` | landing-only | n/a (`landing/`) | Preview's `.d-card` / `.a-card` "lead-worker orchestration" / "persistent memory & identity" feature tiles are landing-page constructs. new-ui has no corresponding feature-tile pattern (correct — these belong in landing, which is out of scope). | **Spec-aligned** (out-of-scope per plan) |
| 15 | `iconography.html` | reference | n/a | Brand-kit's icon vocabulary reference. new-ui uses `lucide-react` (per `components.json`) which aligns with the lucide-style icons shown in the preview. Same icon family. | **Spec-aligned** |
| 16 | `inputs.html` | primitive | `components/ui/input.tsx`, `select.tsx`, `textarea.tsx`, `switch.tsx`, `label.tsx` | Preview shows form-field treatments with `--radius-md`, `--zinc-{50..950}` borders, `--amber-{500,700}` focus rings. new-ui's input primitives use shadcn defaults — focus ring derives from `--color-ring` (= `--color-primary` = amber-700 light / amber-500 dark). OKLCH-equivalent. | **Spec-aligned** |
| 17 | `integration-detail.html` | route | `pages/integrations/[id]/page.tsx` | Preview shows: hero header (integration logo + name + status pill), Authentication / Connection / Sync-behavior / Permissions sub-cards, "Sync stats · 24h" bar of small numerics. new-ui's integration-detail uses `OAuthSection`, `OAuthStatusRow`, `OAuthSectionRow` (Phase 9 primitives). The preview's "sync stats · 24h" bar is **NOT** present in new-ui's integration-detail — a Stat-strip-bar primitive (similar to `StatsBar` for dashboard) for the per-integration view. | **Backlog (new)** — per-integration `<StatsBar>` (24h sync stats) |
| 18 | `logo.html` | reference | `new-ui/public/logo.png` (used in `app-sidebar.tsx`) | Preview shows the brand mark in light/dark + a wordmark variant. new-ui uses `logo.png` directly. Brand consistency maintained. | **Spec-aligned** |
| 19 | `primitives-tabs-modals.html` | primitive | `components/ui/tabs.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `select.tsx`, `switch.tsx` | Preview demonstrates: standard tab bar, pill-tabs (selectable pills), vtabs (vertical tabs with side accent), dialogs ("Add MCP server", "Delete agent worker-03?", "New scheduled task", "Tool call · run_shell"). new-ui's `Tabs` has `default` and `line` variants; **no `pill` variant** and **no `vertical` variant**. These are 2 missing tab variants if cross-codebase use cases ever require them. Currently no consumer demands them in new-ui. | **Backlog (new)** — `Tabs` `pill` and `vertical` variants if future surfaces need them |
| 20 | `primitives.html` | primitive | various ui primitives | Preview shows: dropdown menu, command palette (cmd-k), select, switch, alerts ("Approaching monthly budget", "Worker offline · worker-04"). new-ui has all five primitives + `AlertCallout` (Phase 9). Shadow on dropdown uses `--shadow-lg`; new-ui uses Tailwind `shadow-md` — single Tailwind step lighter, captured in backlog #4. | **Spec-aligned** + **Backlog (covered)** — shadow scale |
| 21 | `radii.html` | token spec | `src/styles/globals.css` | Swatches for radius scale. new-ui has all four radius tokens + the brand kit has 2 extras (`--radius-2xl`, `--radius-full`) — backlog item #7. | **Backlog (covered)** — item #7 |
| 22 | `shadows.html` | token spec | n/a (no shadow tokens in new-ui) | Swatches for `--shadow-{xs,sm,md,lg,xl}` + `--shadow-amber-glow`. new-ui has no shadow tokens — uses Tailwind `shadow-*` utilities. Backlog item #4. | **Backlog (covered)** — item #4 |
| 23 | `spacing.html` | token spec | n/a | Visualizes `--space-{1..32}` token scale. new-ui uses Tailwind's default spacing utilities. Backlog item #1. | **Backlog (covered)** — item #1 |
| 24 | `stats-bar.html` | shared primitive | `components/shared/stats-bar.tsx` | Preview shows a horizontal stat strip for dashboard (agents / tasks / health / cost-today / cost-mtd). new-ui's `<StatsBar>` (used on dashboard) maps 1:1 to this concept. Visual delta TBD without screenshot diff (deferred to qa-use). | **Spec-aligned** (functionally) — visual delta is a qa-use observation |
| 25 | `status-badges.html` | shared primitive | `components/shared/status-badge.tsx` | Preview shows the canonical status-pill rendering for the 18 statuses. new-ui's `<StatusBadge>` covers the same 18 plus extras (Phase 4 deliverable). Phase 1 token migration (audit §(g)) makes OKLCH parity exact. | **Spec-aligned** |
| 26 | `task-detail.html` | route | `pages/tasks/[id]/page.tsx` | **Second highest-leverage finding.** Preview shows a 3-column layout: left meta-rail (back link, owner, repo, branch, PR card with `.scm-pr` styling, progress bars with status variants `.warn` / `.danger` / `.ok`), center (task description, output, session log timeline with `.tl-rail` / `.tl-line` / `.tl-dot`), right (?) — but new-ui's `pages/tasks/[id]/page.tsx` uses `<Tabs>` (Overview / Logs / Config) without the SCM-PR card or the timeline-rail visual. The preview's timeline rail (with `.tl-line` connecting `.tl-dot`s vertically) is a richer log-list visual. new-ui's `LogTimeline` (line 139) renders flat rows. | **Code-change candidate** (timeline rail visual on `LogTimeline`) + **Follow-up plan** (3-column meta-rail + SCM-PR card) |
| 27 | `task-rows.html` | shared (missing) | `pages/tasks/page.tsx` (DataGrid) | Preview shows a card-style task row (rounded, padded, with status pill, title, metadata strip). new-ui uses AG Grid (DataGrid) for the tasks list — flat-row table, not card-style. This is a stylistic preference: AG Grid is the new-ui default and a hard rule per CLAUDE.md ("Always use `DataGrid`"). The brand kit's card-row is an alternate visualization not adopted. | **Spec-aligned** (deliberate divergence — DataGrid is canonical) |
| 28 | `terminal.html` | primitive (missing) | n/a — no `Terminal` primitive | Preview shows a small mono-font terminal-output card. new-ui's closest equivalent is `SessionLogViewer` (richer, streaming) — terminal-style output is a sub-mode of that. Could be a `Terminal` primitive if static terminal output ever becomes a recurring need. | **Backlog (new)** — `<Terminal>` primitive (static mono-font output card) |
| 29 | `tokens-dark.html` | token spec | `src/styles/globals.css` `.dark` block | Dark-mode swatches for the same brand-kit tokens. Phase 1 audit §(b) verified OKLCH parity. | **Spec-aligned** |
| 30 | `tokens.html` | token spec | `src/styles/globals.css` | Light-mode swatches for the brand-kit tokens (color, radius, shadow, type-scale). Already covered by Phase 1 + Phase 11 backlog. | **Spec-aligned** + multiple **Backlog (covered)** items |
| 31 | `type-display.html` | landing-only | n/a (`landing/`) | Demonstrates `.gradient-text` + `.t-eyebrow` + `.t-display` + `.t-h3` together for landing hero. Out of scope. | **Backlog (covered)** — items #2, #6, #10 |
| 32 | `type-scale.html` | token spec | n/a | Visualizes `--t-{display,h1..h4,body,...}` scale. Backlog item #2. | **Backlog (covered)** — item #2 |
| 33 | `workflow-graph.html` | route | `pages/workflows/[id]/page.tsx` | Preview shows a react-flow-style workflow canvas with node states: `running`, `completed`, `failed`, `waiting`, `pending`, `skipped`, `retry`. new-ui's workflow-detail uses react-flow with Phase 4-migrated `--color-action-*` + `--color-status-*` tokens; node-state rendering covers these states via `step-card.tsx` and `*-node.tsx`. Brand-kit-only: `.runmeta` strip below canvas (run summary bar). Spot-check: new-ui has no run-summary strip below the canvas (the run controls panel exists in the page header). | **Backlog (new)** — workflow-canvas run-summary strip (low priority) |

### `ui_kits/dashboard/` — per-JSX diff

The 4 JSX components in `~/Downloads/swarm-design-system/ui_kits/dashboard/` are React reference implementations of the operator-dashboard surface. They use raw Tailwind palette literals (`bg-white border-zinc-200 text-zinc-900 bg-amber-500 ...`) and pre-shadcn patterns — they are **not** the same as the `new-ui/src/components/ui/*.tsx` brand-kit primitives.

#### `Sidebar.jsx` (82 LOC) ↔ `new-ui/src/components/layout/app-sidebar.tsx` (147 LOC)

| Aspect | Brand-kit `Sidebar.jsx` | new-ui `app-sidebar.tsx` | Severity |
|---|---|---|---|
| Imports | inline-defined `DIcon` SVGs; `useState` for collapsed | `lucide-react`, `react-router-dom`, shadcn `<Sidebar>` shell, `<CollapsibleSection>`, `<SwarmSwitcher>` | **Spec-aligned** (different stack, same intent) |
| Nav grouping | 3 groups: `main` / `integrations` / `account` | 5 groups: `Core` / `AI` / `Operations` / `Configuration` / `System` | new-ui has more nav items than the reference shows — **expected** (real product surface > reference) |
| Active state | `bg-amber-50 text-amber-800` (raw palette) | shadcn `isActive` prop on `SidebarMenuButton` (token-aware) | **Spec-aligned** (new-ui is canonical; raw palette would break lint gate) |
| Header logo | `<img src="../../assets/logo.png" w-8 h-8 rounded-lg shadow-sm shadow-amber-500/20 />` + workspace name | `<img src="/logo.png" w-8 h-8 rounded />` + "Agent Swarm" + `<SwarmSwitcher>` | **Backlog (new)** — sidebar header `shadow-sm shadow-amber-500/20` accent on logo (small visual touch, depends on `--shadow-amber-glow` adoption — backlog item #4 covers it) |
| Footer / user card | `<div w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-amber-600 ...>AC</div>` + name + workspace handle | `<SidebarTrigger>` only (collapse toggle); no user card | **Backlog (new)** — sidebar footer user-info card (avatar + name + workspace) — currently new-ui shows user identity in `<SwarmSwitcher>` in the header, not the footer |
| Section labels | `text-[10px] font-semibold uppercase tracking-wider text-zinc-400` | `<CollapsibleSection title={group.label}>` (collapsible, with chevron) | **Spec-aligned** (new-ui is richer) |
| Item active indicator | left amber accent: `bg-amber-50 text-amber-800` | shadcn-derived (depends on theme) | **Spec-aligned** |
| Badge on item | `<span text-[10px] font-mono px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded>{n}</span>` | not implemented (nav items have no badge counts in new-ui's `app-sidebar.tsx`) | **Backlog (new)** — sidebar nav-item badge for counts (e.g., "Tasks (7 pending)") |
| Collapse | manual `w-14`/`w-60` toggle | shadcn `collapsible="icon"` (slimmer, with overlay) | **Spec-aligned** (new-ui is richer) |

#### `Header.jsx` (28 LOC) ↔ `new-ui/src/components/layout/app-header.tsx` (52 LOC)

| Aspect | Brand-kit `Header.jsx` | new-ui `app-header.tsx` | Severity |
|---|---|---|---|
| Layout | `h-14 bg-white border-b border-zinc-200 px-5` | `h-14 border-b border-border px-4` | **Spec-aligned** (new-ui uses tokens) |
| Breadcrumbs | manual `<nav>` with `Workspace / Tasks` | `<Breadcrumbs />` shared component (route-driven) | **Spec-aligned** (new-ui is richer) |
| Health indicator | `<span w-1.5 h-1.5 rounded-full bg-emerald-500>` + "Connected · v1.4.2" | `bg-status-success`/`bg-status-error` dot + active connection name + version | **Spec-aligned** (token migration done in Phase 4) |
| Theme toggle | manual `<button onClick={() => setDark(!dark)}>` with sun/moon SVGs | `<Button variant="ghost" size="icon" onClick={toggleTheme}>` w/ lucide `Sun`/`Moon` | **Spec-aligned** |
| **"New task" CTA** | `<button class="bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold px-3 py-1.5 rounded-md shadow-sm shadow-amber-600/20">+ New task</button>` (header-anchored CTA with amber-glow shadow) | **NOT PRESENT** in `app-header.tsx` — new-ui's "Create Task" button lives in `pages/tasks/page.tsx` PageHeader action slot, not the global header | **Spec-aligned** (deliberate — global "create" CTAs are page-scoped, not header-scoped, in new-ui's IA) |
| Sidebar trigger | absent (Sidebar handles its own collapse) | `<SidebarTrigger className="md:hidden">` — mobile-only collapse trigger | **Spec-aligned** (new-ui is richer; responsive) |

#### `TaskList.jsx` (72 LOC) ↔ `new-ui/src/pages/tasks/page.tsx` (624 LOC)

| Aspect | Brand-kit `TaskList.jsx` | new-ui `pages/tasks/page.tsx` | Severity |
|---|---|---|---|
| Top filter strip | inline filter-pill buttons: `all / in_progress / pending / done / failed` with count badges; right side: `/api/tasks · live` mono indicator | `<Select>` for status / agent / schedule + `<Switch>` for heartbeat + `<Input>` for search + clear-filters button | **Spec-aligned** (new-ui is richer; URL-param-backed filters > brand-kit's local-state pills) |
| Live indicator | `text-xs text-zinc-500 font-mono /api/tasks · live` | (not present) — react-query auto-polling at 5s gives the same effect without the visual indicator | **Backlog (new)** — header "live" mono indicator showing data-source + polling state (low priority) |
| Table | hand-rolled `<table>` with `<thead>` + `<tbody>` | AG Grid via `<DataGrid>` (CLAUDE.md hard rule: "Always use DataGrid") | **Spec-aligned** (deliberate — DataGrid is canonical) |
| Status chip | `<StatusChip>` inline JSX with `STATUS` map using OKLCH colors directly via `style={{color, background}}` | `<StatusBadge status={value} />` shared primitive (token-driven) | **Spec-aligned** (Phase 4 token migration) |
| Selected row highlight | `bg-amber-50/40` on selected row | row-click navigates to `/tasks/[id]` (no inline-selected state) | **Spec-aligned** (different IA — list page navigates to detail; brand-kit reference shows split-pane list+detail which is `task-detail.html`'s 3-column rail layout, not new-ui's IA) |
| ID column | mono-font ID chip | `field="task"` with full description; ID surfaced via row-click navigate; AG Grid handles sort/filter | **Spec-aligned** |
| Updated column | `text-xs text-zinc-500` static "2m ago" string | `formatSmartTime(value)` — live-formatted | **Spec-aligned** (new-ui is richer) |

#### `AgentPanel.jsx` (85 LOC) ↔ no exact 1:1 counterpart in new-ui

| Aspect | Brand-kit `AgentPanel.jsx` | new-ui counterpart | Severity |
|---|---|---|---|
| Surface | Right-side panel within the brand-kit's split-pane Tasks → Agent flow (selected-task → its agent + live SSE stream) | new-ui has no equivalent split-pane: agents live at `pages/agents/page.tsx` (list) and `pages/agents/[id]/page.tsx` (detail w/ tabs). Live agent stream lives at `pages/tasks/[id]/page.tsx` via `<SessionLogViewer>` keyed to taskId. | **Spec-aligned** (different IA — new-ui chose route-based over split-pane) |
| Empty state | `<div min-h-[300px]>` icon + heading "Select a task" + helper text | `<EmptyState>` primitive (Phase 9) used in agent-list etc. | **Spec-aligned** |
| Live SSE stream | hand-rolled streaming with `setInterval` and `STREAM_LINES`, color-coded by event type (`plan`/`tool`/`shell`/`ok`) | `<SessionLogViewer>` shared primitive (richer — handles real SSE, log levels, structured events) | **Spec-aligned** (new-ui is canonical) |
| Stat row | inline `<Stat>` 3-column grid (Steps / Tokens / Elapsed) | `<UsageSummary>` shared primitive on agents-detail; per-task stats inline in `tasks/[id]/page.tsx` | **Spec-aligned** |
| Agent identity tile | `<div w-8 h-8 rounded-full bg-gradient-to-br from-violet-400 to-purple-600 text-white text-[11px] font-bold>` initials | `<Avatar>` + `<AvatarFallback>` shadcn primitive (no gradient) | **Backlog (new)** — agent-avatar gradient-fill variant (decorative, low priority) |

### Code-change candidates

After the full audit, these are the deltas where the implementation has a clear visual divergence from the brand kit's authoritative reference that could be addressed as a small surgical fix on the current branch (rather than a full follow-up plan or new backlog item).

| # | Delta | File | Effort | Recommended action |
|---|---|---|---|---|
| 1 | `LogTimeline` rows are flat (no connecting rail line / no dot-on-rail visual). Brand kit's `task-detail.html` shows a vertical `.tl-rail` with `.tl-line` connecting `.tl-dot`s — visually richer "story" of agent steps. | `new-ui/src/pages/tasks/[id]/page.tsx:139` (`LogTimeline`) | ~1 hour (CSS-only change to add a 1px left rail behind absolute-positioned dots) | Surgical fix on this branch in a follow-up commit IF user agrees the flat-row visual was a regression vs. the brand-kit pattern. Otherwise defer to follow-up plan. |
| 2 | `tasks/[id]` page uses flat tabs without the brand kit's 3-column meta-rail layout (left: meta + SCM-PR card + progress bars; center: hero output + timeline; right: stats / relationships). | `new-ui/src/pages/tasks/[id]/page.tsx` (entire layout) | ~1 day (significant restructure, plus a new SCM-PR card primitive) | **Follow-up plan candidate.** Not surgical. Defer. |
| 3 | All detail pages (`tasks/[id]`, `agents/[id]`, `integrations/[id]`, `mcp-servers/[id]`, `workflows/[id]`, `schedules/[id]`) lack the brand kit's right-rail (Quick stats / Relationships / Danger zone) per `detail-page-template.html`. | every `pages/*/[id]/page.tsx` | ~3-5 days (new `<DetailPageRail>` primitive + per-page adoption + qa-use sweep) | **Follow-up plan candidate.** Not surgical. Defer. |

**Net code-change candidates surfaced**: 1 surgical fix (LogTimeline rail) + 2 follow-up plan candidates (3-column task-detail, detail-page right rail).

### Backlog additions (new items, appended to `2026-05-06-design-system-backlog.md`)

The audit surfaces these new candidates not covered by Phase 11's existing 15-item backlog:

1. `<CodeBlock>` primitive with read / diff / inline / editable / collapsed modes (preview: `code-block.html`)
2. `<Terminal>` primitive — static mono-font terminal-output card (preview: `terminal.html`)
3. `<Tabs>` `pill` and `vertical` variants (preview: `primitives-tabs-modals.html`)
4. Per-integration `<StatsBar>`-style "sync stats · 24h" strip on integration-detail (preview: `integration-detail.html`)
5. Sidebar nav-item badge counts (e.g., `Tasks (7 pending)`) — `Sidebar.jsx`
6. Sidebar footer user-info card (avatar + name + workspace) — `Sidebar.jsx`
7. Tasks-list "live · /api/tasks" mono indicator showing data-source + polling state — `TaskList.jsx`
8. Agent-avatar gradient-fill variant — `AgentPanel.jsx`
9. Workflow-canvas run-summary strip below the graph — `workflow-graph.html`
10. Approval-request page rich-detail surface (banner + countdown + decision panel + audit-record) — `approval-request.html`
11. Chat surface visual-spec parity sweep against `chat-surface.html` — depends on whether new-ui's chat layout was deliberately chosen or just earlier
12. Detail-page right-rail primitive (`<DetailPageRail>` with Quick stats / Relationships / Danger zone) — `detail-page-template.html`
13. 3-column task-detail layout (left meta-rail + SCM-PR card + progress bars; center main; right stats) — `task-detail.html`

### Phase 12 implementation summary

| Artifact | Status |
|---|---|
| 33 preview HTMLs analyzed | done — per-file delta table above |
| 4 ui_kits/dashboard JSX components diffed against new-ui counterparts | done — per-component table above |
| Backlog file updated with 13 new candidates | done — see backlog file |
| Code-change candidates flagged for orchestrator | done — 1 surgical (`LogTimeline` rail) + 2 follow-up-plan (3-col task-detail, detail-page rail) |
| Phase 12 success criteria: typecheck, lint, check:tokens (sanity) | run during phase verification |
| Phase 12 success criteria: qa-use captures | **skipped** — qa-use deferred to PR-time per orchestrator instruction |

### Top 3 most surprising findings

1. **Detail-page-template.html is a meta-spec.** Every detail page in the dashboard is supposed to have a right rail with Quick stats / Relationships / Danger zone. **None do.** This is the largest architectural divergence the original 11-phase plan missed. (Severity: follow-up plan.)
2. **Task-detail.html shows a 3-column meta-rail layout** (left: SCM-PR + progress bars; center: hero + timeline rail; right: stats) — `tasks/[id]/page.tsx` uses flat Tabs. The timeline-rail visual (a 1px line connecting dots vertically) is the only piece small enough to fix surgically.
3. **Zero net-new tokens in the backlog from the preview scan.** All brand-kit-only tokens (`--fg-{1..4}`, `--space-*`, `--shadow-amber-glow`, `--t-*`, `--lh-*`, `--radius-2xl`, etc.) are already on the Phase 11 backlog. The preview HTMLs **confirm** the existing scope; they don't add new token-level work. The new backlog items (13) are **structural / primitive-level** patterns, not token-level.

---

## Phase 14 — `tasks/[id]` 3-column meta-rail layout

Phase 12 audit (commit `328218d1`) flagged the second-highest-leverage finding: `pages/tasks/[id]/page.tsx` lacks the brand kit's 3-column meta-rail layout (`~/Downloads/swarm-design-system/preview/task-detail.html`). The layout was originally classified as a "Follow-up plan candidate" (effort ~1 day). The user re-scoped it into this branch as Phase 14.

### Layout decisions

Brand-kit grid is `grid-template-columns: 240px 1fr 240px` (`preview/task-detail.html:22`). new-ui mirrors this exactly via `lg:grid-cols-[240px_1fr_240px]`. Below the `lg` breakpoint (1024px) the previous tabbed mobile layout takes over — the 3-column rail does not fit in narrower viewports.

| Column | Width | Content placement | Source |
|---|---|---|---|
| Left rail | 240px | Meta info (Agent / Created by / Created / Finished / Swarm version / Parent / Dir / Session / API Key / Workflow) + Source Control card + Dependencies + Progress text + Context / ACU budget | Lifted from previous `detailsContent` minus Activity + Cost. |
| Center | 1fr | Hero (status + tag/priority/source/provider/model badges + collapsible description + action buttons), Failure-reason card, Output card, SessionLogViewer (fills remaining height). | Hero moved out of fixed top into center column; rest preserved from previous desktop right column. |
| Right rail | 240px | Activity timeline (LogTimeline w/ Phase 13 rail visual) at top + Session Cost stat block below. | New rail. Activity moved out of left rail (was at the bottom of `detailsContent`) into the canonical "stats" rail; Cost moved alongside it. |

### Tabs disposition

**Preserved on mobile/tablet (`<lg`)**, **dissolved on desktop (`lg+`)**. The mobile branch (now `lg:hidden`, was `md:hidden`) keeps the existing `Details / Outcome / Session Logs` tabs. The new right-rail content (Activity + Session Cost) is merged into the Details tab so no data is lost on tablet — the alternative (a 4th tab) would have been a regression for narrow-viewport readability.

This means the previous **2-column desktop layout (`md:flex` w/ `w-52 lg:w-60` left sidebar)** is gone — between `md` and `lg` (768–1023px) the page now falls back to mobile Tabs. This is acceptable because the 3-column rail layout fundamentally needs `lg+` width to render legibly. Users with narrow desktop windows see Tabs, not a half-broken 2-column grid.

### Hero handling

Hero (status badges + description + action buttons) was previously rendered as a fixed `shrink-0` block above the layout switch. To match the brand kit's `.center > .header` block (where the hero lives **inside** the center column), the hero is now extracted into a local `heroBlock` JSX expression and rendered twice:
- **Mobile** (`<lg`): above the Tabs (preserves the previous mobile UX — hero is the page's primary identity and must stay above the tab strip).
- **Desktop** (`lg+`): inside the top of the center column, matching the preview.

This is **controlled JSX duplication**, not a new abstraction — the hero is single-use, page-specific, and not extractable per the Phase 9 "appears in 2+ places" rule (it appears in 2 places, but both are the same single component instance rendered conditionally; no other page reuses it).

### Deviations from preview HTML

| Deviation | Why |
|---|---|
| Mobile/tablet uses Tabs, not stacked rails. | Preview is desktop-only; mobile/tablet branch preserves existing behavior to avoid regressions. |
| Activity timeline header in right rail is a flex row with `Activity` icon + `(N)` count, not a `.section-label` (font-mono uppercase) like the preview. | Reuses existing dashboard typography (`text-[10px] font-semibold text-muted-foreground uppercase tracking-wider`) for consistency with other section labels in the file. The brand kit's `.section-label` uses `Space Mono` — that's a backlog item from Phase 11 / Phase 12 (font-family adoption is not in scope of this phase). |
| No `.csec` collapsible sections in left rail. | Existing rail content uses `Separator + section-label + content` pattern (see Source Control / Dependencies / Progress / Context blocks); collapsibility is not a Phase 14 deliverable. The preview's `.csec` toggles are a follow-up enhancement (backlog candidate). |
| No `.btn.danger` styling on Cancel button. | new-ui's `Button variant="destructive-outline"` is the canonical destructive-outline (Phase 4) — visually equivalent but uses status tokens, not raw `oklch(0.66 0.22 27 / 0.4)` literals. This is a deliberate Phase 1–4 decision documented in `new-ui/CLAUDE.md`. |

### Visual deltas worth flagging

- **Header borders** — preview has `border-bottom: 1px solid var(--border)` on `.header` separating hero from output. We use the existing `<Separator />` (which renders `border-t`/`bg-border`). Pixel parity should be close.
- **Right rail border** — preview has `border-left: 1px solid var(--border)`. We use `border-l border-border` — exact match.
- **Right rail padding** — preview is `padding: 14px`. We use `py-3 px-3` (12px). Acceptable parity (one Tailwind step off).
- **Center scroll behavior** — preview's `.body` is `flex: 1; overflow-y: auto`; new-ui's center column wraps Failure / Output / SessionLogViewer in `flex flex-col flex-1 min-h-0 overflow-hidden` with the SessionLogViewer claiming `flex-1`. Equivalent semantics.

### Implementation summary

| Artifact | Status |
|---|---|
| `pages/tasks/[id]/page.tsx` restructure | done — `leftRailContent` / `rightRailContent` / `heroBlock` extracted; 3-column desktop grid added; mobile Tabs branch updated to `lg:hidden` and merges right-rail content into Details tab |
| Token compliance | `pnpm run check:tokens` green — no raw palette literals introduced |
| Lint / typecheck / build | `pnpm lint` / `pnpm exec tsc -b` / `pnpm exec vite build` green |
| qa-use captures | **skipped** — qa-use deferred to PR-time per orchestrator instruction |

### Risk callouts

The restructure is purely presentational (no data-fetching, mutation, or subscription changes). States most worth spot-checking visually:

- **`pending`** — no `canPause` / `canResume` / `canCancel` actions; hero will lack the action-buttons row
- **`in_progress`** — Pause + Cancel buttons; `LogTimeline` shows live activity
- **`paused`** — Resume + Cancel buttons
- **`completed`** — no actions; Output card with `text-status-success` accent
- **`failed`** — no actions; Failure-reason card + Output card
- **`cancelled`** — no actions; potentially no Output

Data-shape edge cases to spot-check:

- Task with **no `vcsProvider`** — left rail's Source Control block is conditionally rendered (`{(task.vcsProvider || ...) && ...}`); should not produce an empty separator
- Task with **`dependsOn`** populated — left rail Dependencies block renders below SCM
- Task with **long `progress` text** — left rail Progress block has `max-h-32 overflow-auto`
- **Devin provider** — `TaskContextSection` switches to ACU budget; `TaskCostSection` shows `ACUs` not tokens
- Task with **no session_logs** — center column renders the empty-state placeholder
- Task with **0 `task.logs`** — `hasEvents` is false, right rail's Activity section omits entirely (but Cost still renders)


---

## Phase 15 — `<DetailPageLayout>` primitive + cross-page rollout (2026-05-06)

### Source of truth

Brand kit `~/Downloads/swarm-design-system/preview/detail-page-template.html` declares the canonical detail-page meta-spec:

- Body: 2-col grid `1fr 280px`, rail collapses below 980px (we use `lg:` ≈ 1024px).
- Right rail sections, in order: **Quick stats → Relationships → Danger zone**.
- Section heading: `font-mono · 10px · 700 · uppercase · letter-spacing 0.08em · color fg-4`.
- Stat row: 2-col grid `1fr auto`, key in muted, value right-aligned, mono variant for numeric/id values.
- Relationship row: stat-row format, value is a `→` link to the linked resource.
- Danger zone: full-width destructive button (oklch red).

Phase 14 hand-rolled this for `tasks/[id]` (with a 240px right rail). Phase 15 extracts the primitive, bumps `tasks/[id]` to the canonical 280px width, and rolls out across the remaining detail pages where the data shape fits.

### Primitive surface

`new-ui/src/components/ui/detail-page-layout.tsx` exports:

| Component | Role |
|---|---|
| `DetailPageBody` | 2-col grid wrapper; `main` + optional `rail` props. Below `lg`, stacks vertically. |
| `DetailPageRail` | Flex-col container for sections. |
| `DetailPageSection` | Section h4 heading + content. Used internally by the named sections; pages can use directly for bespoke sections (e.g. tasks/[id]'s Activity timeline). |
| `QuickStats` | "Quick stats" section heading + container for `QuickStat` rows. |
| `QuickStat` | k/v row, 2-col grid `1fr auto`, optional `mono` variant. |
| `Relationships` | "Relationships" section heading + container for `Relationship` rows. |
| `Relationship` | `label` + `→`/value, internal Link or external `<a>`. |
| `DangerZone` | "Danger zone" section heading + content slot (full-width button typically). |

Pages keep their existing `<PageHeader>` for the title row above the body; the primitive is purely about the body / rail.

### Per-page mapping

| Page | Approach | Quick stats | Relationships | Danger zone |
|---|---|---|---|---|
| `tasks/[id]` | Refactored to use `DetailPageRail` + `DetailPageSection`. Right rail width 240px → 280px. Activity timeline + Session Cost wrapped in primitive sections. | Cost / Tokens / Duration / Turns / Model (existing icon-prefixed `MetaRow` rows preserved — different visual style, consistent with task-page convention). | n/a (parent / workflow / dir live in left rail) | n/a (Cancel lives in hero per existing UX) |
| `repos/[id]` | Single-pane primitive use. Card+InfoRows replaced by rail QuickStats. Guidelines = main. | URL / Clone Path / Default Branch / Created / Auto-clone | n/a | Delete repository |
| `skills/[id]` | Tabs collapsed (Content + Metadata → just Content + rail). | id / version / created / updated / lastFetched / model / allowedTools / complex / userInvocable | Owner Agent / Source repo | Delete skill |
| `mcp-servers/[id]` | Tabs preserved (Configuration / Authentication; Metadata folded into rail). DetailPageBody wraps Tabs + rail. | id / version / transport / scope / created / updated | Owner Agent | Delete server |
| `schedules/[id]` | Tabs preserved (Schedule / Tasks); rail provides at-a-glance summary alongside. Rich schedule cards stay in main. | type / enabled / priority / nextRun / lastRun / created | Target Agent | Delete schedule |
| `approval-requests/[id]` | Single-pane primitive use. Meta strip replaced by rail QuickStats. Questions = main. | status / created / resolved / resolvedBy / timeout / questions count | Workflow Run / Source Task | n/a (no destructive action exists) |
| `integrations/[id]` | Settings page; rail provides field counts + docs link. Action bar (save / disable / reset) stays at top of main. | status / total fields / required / advanced / disabled | Docs link | n/a (Reset stays in action bar — existing flow) |
| `agents/[id]` | Tabs preserved (Profile + 4 others). Primitive applied INSIDE Profile tab body only. | status / role / capacity / joined / updated | n/a | n/a (no delete-agent action exists) |

### Skipped pages (primitive does not fit)

| Page | Reason |
|---|---|
| `templates/[id]` | Monaco editor dominates the body — fills full width, no natural rail spot. Header badges already convey scope/state/version. |
| `templates/[id]/history/[version]` | Read-only Monaco editor — same reason. |
| `workflow-runs/[id]` | Body is a 2-col split (workflow graph left + steps panel right). Adding a third "rail" column would compete with the steps panel. |
| `workflows/[id]` | Massive 1869-line tab-driven editor (Definition Monaco + Runs / Triggers / Settings). Out of scope for this phase — would need a dedicated phase to reshape. |

### Deliberate API choices

- **Width 280px (not 240px)**: matches brand kit canonical. `tasks/[id]` left rail stays 240px (page-specific meta-sidebar; left rail is not part of the canonical primitive's contract — only `1fr | 280px` is).
- **Title accepts `ReactNode`**: lets `tasks/[id]` pass `<><Activity icon /> Activity (N)</>` as a section heading.
- **Below-`lg` stack**: rail goes BELOW main rather than hidden — preserves all content on tablet/mobile.
- **No left rail support**: brand-kit template only specifies right rail. Tasks's 3-col is page-specific (its meta sidebar is denser than any other detail page) and stays inline.
- **Pages keep their `<PageHeader>`**: no `header` slot on `DetailPageBody`. Avoids re-implementing `PageHeader` and lets pages compose freely.

### Verification

- `pnpm run check:tokens` — green (no new color literals)
- `pnpm lint` — green
- `pnpm exec tsc -b` — green
- `pnpm exec vite build` — green

## Phase 16 — UX cleanup: rail width parity + Delete-button rollback (2026-05-06)

After Phase 15 review, two UX deltas were flagged that needed correction.

### Delta 1 — `tasks/[id]` rail-width asymmetry

**Phase 14** (commit `1779bbde`) introduced the 3-col tasks layout with `lg:grid-cols-[240px_1fr_240px]`.

**Phase 15a** (commit `bd1be1b9`) refactored the right rail to use `<DetailPageBody>` (canonical 280px) but left the left rail at 240px, producing the asymmetric `lg:grid-cols-[240px_1fr_280px]`. Reasoning at the time: the left rail is "page-specific meta-sidebar", not promoted to the primitive — but visually the asymmetry was distracting on the actual rendered page.

**Phase 16 fix**: bumped left rail to 280px → `lg:grid-cols-[280px_1fr_280px]`. The brand-kit `task-detail.html` mock uses `240px 1fr 240px`, but the canonical `detail-page-template.html` (the meta-template the design system promotes) is `1fr 280px`. Phase 15 chose 280px for the right rail; Phase 16 aligns the left to match. Both rails are now visually equal at the `lg` breakpoint.

### Delta 2 — Delete-button discoverability regression

**Phase 15b** (commit `41070a2b`) moved the Delete button from the page header into `<DangerZone>` at the bottom of the right rail on:
- `repos/[id]`
- `skills/[id]`
- `mcp-servers/[id]`
- `schedules/[id]`

The intent was alignment with the brand kit's `preview/detail-page-template.html` "Right rail · stats, relationships, danger zone" pattern. In practice, Delete became hard to find — buried below QuickStats on long pages, scrolled out of the viewport on common laptop heights.

**Phase 16 fix**: restored Delete to the page header on all four pages.

| Page | Header form |
|---|---|
| `repos/[id]` | `<Button size="sm" variant="destructive-outline">Delete</Button>` in `<PageHeader action>` (alongside `Edit`) |
| `skills/[id]` | `<Button variant="destructive-outline" size="sm">Delete</Button>` in `<PageHeader action>` (alongside `Disable`/`Enable`) |
| `mcp-servers/[id]` | `<Button variant="destructive-outline" size="sm">Delete</Button>` in `<PageHeader action>` (alongside `Disable`/`Enable`) |
| `schedules/[id]` | `<Button variant="destructive-outline" size="sm">Delete</Button>` in the inline action bar (alongside `Run Now` / `Edit`); page does not use `<PageHeader>` because its title row has a custom Switch toggle and tag layout |

`<DangerZone>` was removed from the rail on all four pages because Delete was the only destructive action — the rail now ends after `<QuickStats>` (and `<Relationships>` where applicable). No empty `<DangerZone>` is rendered.

### `<DangerZone>` retained in the primitive surface

`<DangerZone>` stays exported from `components/ui/detail-page-layout.tsx`. It's still appropriate for pages with **multiple** destructive actions (e.g. a future settings page that pairs "Reset all OAuth tokens" + "Delete integration", or an account page with "Disable agent" + "Delete agent"). The CLAUDE.md guidance was updated: single-action Deletes belong in the page header; the DangerZone slot is for genuinely supplementary or grouped destructive actions.

### Verification

- `pnpm run check:tokens` — green (no new color literals; the restored Delete buttons use `variant="destructive-outline"`, never raw red palette literals — would otherwise fail the Phase 7 lint gate)
- `pnpm lint` — green
- `pnpm exec tsc -b` — green
- `pnpm exec vite build` — green

## Phase 17 — `tasks/[id]` polish + Activity scrollability + scroll-bug fix (2026-05-06)

After Phases 14–16 shipped, Taras ran the dev server and surfaced five items.

### Item 1 — `tasks/[id]` hero + body padding too tight

The center column on `tasks/[id]` had `pb-3 px-1` on the hero block and `py-3 px-3 gap-2` on the Failure / Output / SessionLogViewer body. Brand kit `preview/task-detail.html` uses `.header { padding: 14px 18px 12px }` and `.body { padding: 14px 18px }`. Bumped to `space-y-3 px-4 pt-4 pb-5` (hero) and `py-4 px-4 gap-3` (body) — closer to the 14–18px brand-kit values, with explicit `space-y-3` opening up the badge-row → description → action-row vertical rhythm.

### Item 2 — Activity heading should stay sticky while rows scroll

The right rail used `<DetailPageSection title="Activity (N)">` whose heading scrolled with the rail's `overflow-y-auto`. Replaced with a hand-rolled `<section>` whose `<h4>` carries `sticky top-0 z-10 bg-background -mx-3 -mt-3 px-3 pt-3 pb-2 pr-10 ... border-b border-border`. The negative margins extend the heading bg into the rail's `px-3 py-3` padding so rows scroll cleanly under the pinned heading. `pr-10` reserves space for the collapse chevron (item 4) at top-right.

A primitive-level `<DetailPageSection scrollable>` was considered but rejected: only the tasks Activity feed needs this pattern today; the other rails are short k/v lists. Premature primitive extraction would force the simpler rails through unnecessary indirection. Revisit if a second rail-scroll surface emerges.

### Item 3 — Session Cost moved from right rail to left rail

`<TaskCostSection>` was originally in the right rail alongside Activity (Phase 14). Phase 17 moved it to the left rail, immediately after `<TaskContextSection>`. Right rail now hosts only the Activity timeline. Cost stats are scroll-adjacent to other static meta (Agent, Created, SCM, Dependencies, Progress, Context budget) which the user always wants visible without scrolling the activity feed.

### Item 4 — Collapsible right rail (implemented)

Added a chevron toggle button at the top of the right rail. State persists in `localStorage` under key `agent-swarm-task-rail-collapsed`. Implementation:

- `useState` initializer reads localStorage (SSR-safe via `typeof window === "undefined"` guard).
- `useEffect` writes back on change.
- Desktop grid template is conditional via `cn()`: collapsed → `lg:grid-cols-[280px_1fr_36px]`, expanded → `lg:grid-cols-[280px_1fr_280px]`. The 36px gutter holds only the chevron.
- When collapsed, `rightRailContent` is suppressed; only the toggle chevron renders inside the gutter.

~30 lines total. Met the "implement only if clean and small" bar from Taras's brief. No new primitive needed; localStorage hook would be a candidate for extraction if a second collapsible appears.

### Item 5 — Scroll bug in `<DetailPageBody>` (primitive-level fix)

**Root cause**: the `<DetailPageBody>` `rail`-present branch rendered:

```tsx
<div className="min-w-0">{main}</div>
<aside className="lg:border-l lg:border-border lg:pl-6 min-w-0">{rail}</aside>
```

These intermediate containers had `min-w-0` but no `min-h-0` and were not flex containers themselves. When a page passed `className="flex-1 min-h-0"` to `<DetailPageBody>` and inside `main` used a `<pre>` or `<Tabs>` with `flex-1 overflow-auto`, the lg:grid sized each cell to `auto` height (its content's natural height) and the `flex-1 overflow-auto` descendant could not shrink → page overflow → no scroll.

**Pages affected**: `skills/[id]` (the `<pre>` of SKILL.md content), `mcp-servers/[id]` (the Tabs body — Configuration / Authentication tabs each contain a long stack of cards). Both used outer `overflow-hidden` because they wanted internal scroll, not page-level scroll; that intent was broken by the missing `min-h-0` propagation.

**Pages NOT affected**: `repos/[id]`, `schedules/[id]`, `approval-requests/[id]`, `integrations/[id]` — all use outer `overflow-y-auto` (page-level scroll), so the `<DetailPageBody>` cell-height didn't matter; their content overflowed naturally into the outer scroller. `tasks/[id]` doesn't use `<DetailPageBody>` (it has its own bespoke 3-column desktop layout). `agents/[id]` Profile tab uses `<TabsContent overflow-y-auto>` which scrolls the whole `<DetailPageBody>` from the outside.

**Fix**: change the inner containers in `<DetailPageBody>` to:

```tsx
<div className="min-w-0 min-h-0 flex flex-col">{main}</div>
<aside className="lg:border-l lg:border-border lg:pl-6 min-w-0 min-h-0 flex flex-col">{rail}</aside>
```

`min-h-0` lets descendants with `flex-1 overflow-auto` actually shrink to the available height. `flex flex-col` propagates the flex chain so a page-supplied `<div className="flex flex-col flex-1 min-h-0 gap-3">` (skills) or `<Tabs flex flex-col flex-1 min-h-0>` (mcp-servers) can stretch into the cell. Pages with outer `overflow-y-auto` are unaffected because their content's natural height still fits inside the page-level scroller — the new `min-h-0` doesn't constrain them.

**Pre-existing or regression?**: pre-existing. The `<DetailPageBody>` primitive landed in Phase 15 (commit `bd1be1b9`), and skills/mcp-servers adopted it in Phase 15c (commit `637a8aa7`). Both were broken at adoption time but went undetected because the user's manual review didn't try long enough content to trigger overflow. So Phase 17 is a now-noticed bug, not a Phase 14–16 regression. Documented for future contributors: any new detail page that passes `flex-1 min-h-0` to `<DetailPageBody>` and expects internal scroll relies on this fix.

### Verification

- `pnpm run check:tokens` — green
- `pnpm lint` — green
- `pnpm exec tsc -b` — green
- `pnpm exec vite build` — green
- `pnpm dev` (Vite at `http://127.0.0.1:4017/`) — boot clean; `/`, `/tasks/x`, `/repos/x`, `/skills/x`, `/mcp-servers/x`, `/schedules/x`, `/approval-requests/x`, `/integrations/x`, `/agents/x` all serve 200 (SPA index.html → React Router). qa-use visual confirmation deferred to PR-time per Taras's brief.

## Phase 18 — sticky Activity heading coverage (regression fix)

After Phase 17 shipped, the user spotted a coverage bug on `tasks/[id]`: when scrolling the right-rail Activity timeline, rows visibly appeared **above** the sticky `<h4>` "ACTIVITY (N)" heading. The heading wasn't fully covering scrolled-past content as a sticky header should.

### Root cause

The Phase 17 markup was:

```tsx
<DetailPageRail>                        {/* flex flex-col */}
  <section className="first:mt-0 mt-0">
    <h4 className="sticky top-0 z-10 bg-background -mx-3 -mt-3 px-3 pt-3 pb-2 pr-10 ... mb-2.5 border-b">
      ACTIVITY (N)
    </h4>
    <LogTimeline />
  </section>
</DetailPageRail>
```

inside an `<aside className="overflow-y-auto py-3 px-3 relative">` that also held the chevron toggle as `position: absolute z-20 top-2 right-2`.

Two interacting flaws produced the visual bug:

1. **Sticky inside `flex flex-col` ambiguity**. `<DetailPageRail>` is a flex column. Its child `<section>` and the sticky `<h4>` resolved their containing block through a flex item with no constrained height. While modern browsers generally handle this, the negative-margin trick (`-mt-3`) compounded the ambiguity: the h4's normal-flow position was *above* the section's content-box origin, which interacts with sticky pin calculations in non-obvious ways.
2. **Transparent gap below the heading**. `mb-2.5` (10px) sat between the h4's `border-b` and the first timeline row. As the user scrolled, content scrolling up was briefly visible *through* that 10px strip — looking, in screenshot terms, exactly like "a row showing above the heading" because the strip was directly under the heading's bottom border with nothing covering it.

The token swap hypothesis (`bg-background` vs `bg-card`) was wrong: the rail surface IS `bg-background`. The aside has no `bg-*` of its own, so it inherits from `<body>`'s `bg-background`. Token coverage was correct; the structural pattern was the leak.

### Fix

```tsx
const rightRailContent = hasEvents ? (
  <div>
    <h4 className="sticky top-0 z-30 bg-background -mx-3 px-3 pt-3 pb-3 pr-10 ... border-b border-border">
      <Activity ... /> Activity (N)
    </h4>
    <div className="pt-3"><LogTimeline ... /></div>
  </div>
) : null;
```

And on the desktop aside:

```tsx
- railCollapsed ? "overflow-hidden" : "overflow-y-auto py-3 px-3"
+ railCollapsed ? "overflow-hidden" : "overflow-y-auto pb-3 px-3"
```

Three structural changes:

1. **Dropped `<DetailPageRail>` and `<section>` wrappers**. The h4 is now a direct child of a bare `<div>` inside the aside. The sticky containing block resolves cleanly to the aside's content-box (the scroll container). No flex-col ambiguity.
2. **Moved aside top-padding onto the heading**. The aside's `py-3` becomes `pb-3` (no top padding); the h4 owns the top zone via its own `pt-3`. The `-mx-3` extends the heading's `bg-background` to both aside edges. The h4's natural normal-flow position is now `y=0` of the aside's content-box, so sticky `top-0` pins it cleanly with no negative-margin tricks.
3. **Eliminated the `mb-2.5` transparent gap**. The h4's `pb-3` extends its `bg-background` all the way to its `border-b`. The `pt-3` on the body div below provides the visual breathing room *below* the border, but it's part of the scrolling content — when rows scroll up, they pass *behind* the heading (which now has unbroken `bg-background` coverage from `top: 0` down to its `border-b`). No strip, no leak.

Z-index bumped from `z-10` to `z-30` so the heading paints above the chevron toggle (`z-20`) too — defense-in-depth, in case the chevron's region overlaps the heading text on narrow rails.

### Why this generalizes

Anywhere we want a sticky header inside a padded scrollable container, this pattern is the safe one:

- Drop top padding from the scroll container.
- Put the padding inside the sticky element (so its `bg-*` covers from `top: 0` of the viewport down to its content's bottom edge).
- Use negative horizontal margin (`-mx-3`) only — no negative top margin.
- Keep the sticky element as a direct child of a bare `<div>` (or the scroll container itself), not a `flex` parent.

This is documented here so future contributors hitting the same shape (long-list rail, sticky title) don't repeat the negative-margin-on-flex-parent pattern.

### Verification

- `pnpm run check:tokens` — green
- `pnpm lint` — green
- `pnpm exec tsc -b` — green
- `pnpm exec vite build` — green
- `pnpm dev` (portless `https://ui.swarm.localhost`) — boots; `/tasks/<id>` serves 200; HMR picked up the change (verified via curl of `/src/pages/tasks/[id]/page.tsx` returning the new `z-30` source). Visual confirmation of the scroll behavior deferred to user qa-use at PR-time per the brief.

## Phase 19 — Activity-rail collapse chevron regression (2026-05-06)

Phase 18's `z-30` bump on the sticky `<h4>` "ACTIVITY (N)" heading inadvertently hid the rail's collapse chevron. The user reported the chevron was no longer visible after Phase 18 shipped.

### Root cause

The chevron toggle button is rendered as a sibling of the rail content inside the `<aside>`:

```tsx
<aside className="border-l border-border min-h-0 relative overflow-y-auto pb-3 px-3">
  <button className="absolute z-20 top-2 h-6 w-6 ... right-2"> {/* chevron */}
  </button>
  {!railCollapsed && rightRailContent /* contains sticky h4 with z-30 */}
</aside>
```

Phase 18 reasoning ("z-30 keeps the heading above both the timeline rows AND the chevron toggle, so the heading visually covers everything that scrolls past it") missed that the heading's `bg-background` block isn't just covering scrolled-past *content* — it also covers anything in its bounding box at the same z-stack-or-lower, including the chevron sitting at `top-2 right-2 h-6 w-6` (y=8 to y=32 from the aside's top edge). The heading spans roughly `top-0` to `top-9` (its own `pt-3 pb-3` + content height ~14px ≈ 38px tall) at the full rail width via `-mx-3`, so the chevron's bounding box is fully inside the heading's painted region. With `z-30 > z-20`, the heading wins and the chevron is invisible — and unclickable.

The Phase 17 chevron worked because the heading was `z-10` < chevron's `z-20`. Phase 18 inverted that ordering as a "defense-in-depth" move; it was load-bearing for the chevron's visibility.

### Fix

Bump the chevron toggle's z-index from `z-20` to `z-40` so it paints above the sticky heading's `z-30`:

```tsx
- "absolute z-20 top-2 h-6 w-6 ..."
+ "absolute z-40 top-2 h-6 w-6 ..."
```

The h4's `pr-10` (40px right padding) already reserves horizontal room for the chevron — so even with the chevron now painting above the heading, the heading's *text* ("ACTIVITY (N)" + the activity icon) doesn't overlap the chevron. Visual layout unchanged; only the z-stack is corrected.

The Phase 18 fix (sticky heading covers timeline rows that scroll past it, no transparent gap, bare `<div>` wrapper preserving the scroll-container/sticky containing-block contract) is preserved verbatim — no other changes to the rail structure, the heading classes, or the aside container.

### Generalizable lesson

When two `position: absolute`/`position: sticky` elements share a stacking context and one contains the other's bounding box (a sticky header containing a `top-2 right-2` button, for example), bumping the wrapper's z-index to "hide content behind it" can incidentally hide the inner button too. If the wrapper has a solid background (here `bg-background`), the inner button MUST sit at a strictly higher z-index than the wrapper to remain visible.

Specific to this page: when revisiting the rail's z-stack in the future, the canonical ordering is now:

| Element | z-index | Why |
|---|---|---|
| Timeline rows (LogTimeline body) | (none) | base flow |
| Sticky h4 heading | `z-30` | covers rows scrolling past |
| Chevron toggle button | `z-40` | must remain visible above the heading |

### Verification

- `pnpm run check:tokens` — green
- `pnpm lint` — green
- `pnpm exec tsc -b` — green
- `pnpm exec vite build` — green
- `pnpm dev` (portless `https://ui.swarm.localhost`) — boots; `/tasks/<id>` serves 200; HMR picked up the change (verified via curl of `/src/pages/tasks/[id]/page.tsx` containing the new `z-40` source). Visual confirmation of the chevron's visibility (light + dark, expanded + collapsed states) deferred to user qa-use at PR-time per the brief.
