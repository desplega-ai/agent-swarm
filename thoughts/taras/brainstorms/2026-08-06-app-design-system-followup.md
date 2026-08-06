---
date: 2026-08-06T01:30:00Z
topic: "App design system follow-up: animated icons, theme parametrization depth, json-render component quality backlog"
status: brainstorm
tags: [ui, theming, swarm-apps, json-render, design-system, motion]
related:
  - worktree: .claude/worktrees/app-theming (branch worktree-app-theming, uncommitted)
---

# App design system: morning follow-up

Written overnight; the theming + motion work sits UNCOMMITTED in worktree `.claude/worktrees/app-theming`, all gates green, full root suite 7090 pass / 0 fail.

Three threads to decide on, in order of how much thinking they need.

---

## 0. Default (Hive) theme refinements — proposal (per review comment)

Requested: general-level changes to our defaults, keeping colors and branding; dividers read too hard, roundings, etc. All of these are token-level, so every preset inherits them and app canvases get them for free.

1. **Two-tier lines (the "dividers too hard" fix).** Add `--color-border-subtle` (light ~oklch(0.945 0.003 286), between zinc-100/200; dark white/6%) and move NON-structural lines onto it: `Separator`, `divide-y` row rules, `InfoRow`/`DefinitionList` rules, AG Grid row borders, CollapsibleSection headers. Card outlines and inputs keep full `--color-border` (structure + affordance). One token + a targeted class sweep.
2. **Radius tune.** `--radius-xl` 12px → 10px so cards read tighter and more technical (Linear-adjacent); controls stay 8px, tags 6px. One-line token change, product-wide effect, and per-theme radius overrides become meaningful.
3. **Crisper focus ring.** 3px `ring/50` → 2px `ring/60` across button/input/select primitives. Same amber focus language, less chunky, still clearly visible.
4. **Dark hairlines.** Pair with (1): dark subtle lines at white/8 instead of white/10; inputs stay at /15 for affordance.
5. **Table chrome (optional, bigger).** AG Grid header: drop the muted fill, keep a subtle bottom rule + 11px uppercase tracking labels; rows on border-subtle. The single most Linear-looking change for data-heavy pages.

Items 1-4 ≈ one small PR; 5 is its own slice. Colors, Hive Amber, status/action vocabulary: untouched.

---

## 1. Animated icons: which project (2-minute decision)

The repo you linked, **`Avijit07x/animateicons`** (animateicons.in, 1.1k stars, MIT, created 2025-07), is almost certainly the one you saw on GH. What I vendored is **`pqoqubbw/icons`** ("lucide-animated", lucide-animated.com, 7.9k stars, MIT, ~350 icons). Both are the same model: lucide-style animated icons as per-icon vendored React components on `motion/react`, installed via shadcn registry URLs, we own the files.

Currently vendored: sun, moon, settings, refresh-cw in `apps/ui/src/components/icons/`, wired to the theme toggle and the app-surface refresh/gear. Swapping any icon's source later is a per-file operation.

**Answer (asked "which is better?"): pqoqubbw/icons.** Roughly 7x the adoption (7.9k vs 1.1k stars), ~350 icons vs a smaller set, exact lucide naming parity (drop-in mental model for a lucide codebase), and its animations are the more restrained of the two, which fits the Mission Control doctrine. animateicons stays useful as a per-icon cherry-pick source when a specific animation looks better. Staying on pqoqubbw as the default source.

---

## 2. How parametric can themes go? (the design-tokens question)

You asked whether a theme could own "margins, spacing and all", e.g. a user bringing their own design-token list.

### What is true today (verified against compiled CSS, not assumed)

Tailwind v4 resolves EVERY dimension of the system through CSS variables at runtime:

| Dimension | Compiled form | Themable via `[data-theme]` scope today? |
|---|---|---|
| Colors | `var(--color-*)` | YES (shipped: 7 presets) |
| Spacing/margins/gaps/heights | `.p-4 → calc(var(--spacing) * 4)` | YES as ONE density scalar (override `--spacing`) |
| Radius | `var(--radius-*)` | YES (additive data, no preset uses it yet) |
| Type scale | `.text-sm → var(--text-sm)` | YES (additive data) |
| Fonts | `var(--font-sans/mono)` | Var swap yes; font LOADING is separate (network/CSP) |
| Easing | `var(--ease-*)` | YES (new swift/snappy tokens) |

So the mechanism already carries a full design system, not just color. A preset is just a var map; the scope machinery (dashboard `<html>`, app canvas wrapper, portal re-stamping) is done and QA'd.

### The honest limits

1. **Spacing is a scalar, not semantic** (limitation ACCEPTED per review). Components say `p-4`, `gap-2` in fixed multiples. Overriding `--spacing` rescales everything proportionally (a real density knob: compact/cozy). A client token list like "card padding 24, page gutter 32, control height 40" cannot map 1:1 without introducing named semantic spacing vars and refactoring components onto them; the density scalar covers most of the perceived value.
2. **Arbitrary user values are a security/quality surface.** Accepting raw CSS values from an app definition or user input needs an allowlisted var set + strict value validation (only `oklch()`/hex/lengths; reject anything else, or it is a CSS injection hole).
3. **Coverage guarantees.** Color is lint-enforced token-only (CI gate), so custom themes can never miss. Spacing/type inherit automatically because they are utility-driven. AG Grid maps to our tokens. Monaco is the one exempt island.
4. **Status/action tones are deliberately NOT themable** (semantic language). Worth keeping this rule even for BYO tokens.

### Proposed shape (v2 of the theme field)

`theme: presetId | { extends?: presetId, vars: { light: {...}, dark: {...} } }` where `vars` keys come from a published allowlist (color set + `--spacing` + `--radius-*` + `--text-*`) and values pass format validation server-side. Renderer already degrades unknown ids; unknown/invalid vars would be dropped the same way. Fonts stay out of v1. Per-user override stays a preset id (viewers pick from known presets; only app AUTHORS bring raw tokens).

**DECIDED (review): (a) presets only for now.** The `vars` object (b) is parked until a concrete customer need; semantic spacing vars (c) shelved.

---

## 3. Component quality: concrete backlog (the "make the default better, every app inherits" thread)

Full audit ran over `lib/json-render/components.tsx` + `catalog.ts` + the shadcn primitives with file:line evidence. The framing holds: all 20 catalog components compose the dashboard primitives, so fixes here lift every app. Organized by your axes.

### Responsive / layout
- **`Grid columns: <number>` never reflows** (components.tsx:320-340): the bare-integer form (the natural way Metric strips get authored, and documented as equivalent) pins `grid-cols-N` at every viewport. Highest-leverage responsive bug in the catalog. Fix: bare number resolves to a breakpoint stepdown (`base:1, sm:2, md:N`).
- **`Stack direction="row"` has no collapse** (unlike `Split.collapseBelow`): the documented SearchInput+Select filter-bar pattern crushes on mobile. Add `collapseBelow` to Stack.
- **`Drawer` size prop is inert on mobile**: all four sizes render 75vw below `sm` (drawerSizeClass is all `sm:`-prefixed). Give mobile full-width or size-aware base widths.
- **`Grid`/`Split` lack the `padding` token Stack has**; the catalog comment claims all three share it (catalog.ts:93-97 is wrong today).
- Duplicate spacing vocabularies: legacy `Container` gapClass vs `Stack` stackGapClass; steer authors to Stack, deprecate Container in docs.

### Pills / badges / native feel
- **json-render badges are a third convention**: colored border/40 + bg/10 fill, matching neither the dot-based `StatusBadge` (all 18 native statuses) nor the documented border/30-no-fill chip style. Most visible "app doesn't look native" gap. Reconcile `badgeToneClass` to the StatusBadge look.
- **Typography drift**: app `Heading h1` = text-2xl/700 (bigger than any native page title; PageHeader is text-xl/600); `Metric` value text-2xl vs StatPanel's text-lg. Apps currently shout louder than the product chrome. Align both.

### States
- **`Button` has no disabled/loading/confirm** and fires unconditionally; the runtime already tracks `/actions/<name>/status`, so a busy state is wireable. Also: `Button`'s variant enum lacks `destructive-outline` (catalog.ts:197-200), forcing standalone destructive buttons into solid red (this, not Table rowActions, is the source of the heavy red Delete look).
- **Form submit errors are page-level only** (generic "Action failed" banner at the top, no catch in submit): scope errors inline to the form; add pending label/spinner on submit; add success feedback (toast or inline).
- **Loading gaps**: `Metric` renders the literal string "undefined" while its query loads; `DetailList` shows "no record" during the poll window (no `loading` prop). Use the existing `Skeleton`.
- One-liner bug: Form enum `Select` is missing `w-full` (components.tsx:1073-1088), so every enum field renders content-width next to full-width inputs.

### Tables
- **`pagination={false}` is hardcoded** (components.tsx:946) with a 520px scroll region: 200-row tables are an endless scroll. Expose pagination (or auto-enable past N rows).
- No column pinning (id/actions columns scroll away on mobile), no row-density option (DataGrid supports rowHeight), no column-state persistence across reloads.
- Empty state is a bare overlay string; apps are CRUD-first and deserve `EmptyState` (icon + "create your first row" CTA). This is a place apps can lead the dashboard.

### Missing vocabulary (primitives that exist in the dashboard but are not exposed to apps)
`Skeleton`, `EmptyState`, `Avatar`, `Progress`, `Tooltip`, charts (nivo layer exists!), standalone confirm `Dialog`, inline `Link`, `KeyValue` row, Metric trend/delta/tone/icon (StatPanel already has these). Form validation is `required`-only (no min/max/pattern).

### A11y notes
Standalone `Select` with no label has no aria-label fallback (SearchBox does this right); Drawer without description triggers a Radix warning; Table row actions unreachable via grid arrow-key navigation (Tab works).

### On swapping component bases (review question: "base-ui or shadcn? selects are super ugly")

We are already ON shadcn — every primitive in `components/ui/` is shadcn-generated on Radix, and the json-render catalog composes those. So there is no "switch to shadcn" available; the credible alternative BASE is **Base UI** (`@base-ui-components/react`, the newer headless library from the ex-Radix/MUI/Floating-UI team). Two honest observations:

1. **The ugliness is ours, not Radix's.** Both Radix and Base UI are unstyled; the visual layer is 100% our classes either way. The specific select ugliness has concrete causes already on the backlog: Form enum `Select` missing `w-full` (renders content-width), the dark-mode var leak (fixed), the dense `Select…` placeholder styling, and no size variant tuning. Swapping the headless base would reproduce the same look until we restyle anyway.
2. **Where a base swap WOULD pay:** Base UI ships primitives Radix lacks or half-ships (real Combobox/Autocomplete, NumberField, better Select positioning behavior). Migrating the existing 32 primitives wholesale is high churn for near-zero visual payoff.

**Recommendation:** keep Radix under the existing primitives; make "restyle Select/Form controls properly" an explicit slice-1 item; adopt Base UI selectively for NEW primitives where Radix is weak (combobox first, when apps need it); revisit wholesale only if shadcn ships first-class Base UI variants upstream.

### Suggested sequencing (three PR-sized slices)
1. **Native-feel + correctness slice** (small, high visual impact): badge reconciliation, Heading/Metric typography, Button destructive-outline + disabled/loading, Form w-full select, Form inline errors, Metric/DetailList loading via Skeleton.
2. **Responsive slice**: Grid bare-number reflow, Stack collapseBelow, Drawer mobile widths, Grid/Split padding, Table pinning + density + pagination.
3. **Vocabulary slice**: expose Skeleton/EmptyState/Avatar/Progress/Tooltip/Dialog/Link, Metric upgrades, Form validation kinds, charts (biggest, maybe its own plan).

---

## Also parked

(Review catch, FIXED in the worktree: Appearance was missing from the sidebar's Settings hover flyout — added to `footerNav` in `app-sidebar.tsx`; HMR-live on the running dev server.)
- `SWARM_BRAND_COLOR` → integrate as a real "org brand" theme instead of one sidebar span.
- `pages` (create_page) share the base 7 renderer components but have no theme wiring yet.
- `templates-ui` is a drifted fork of globals.css + 5 primitives (no shared package boundary).
- Table cell tooltips are native `title` only (matches dashboard, pre-existing).
