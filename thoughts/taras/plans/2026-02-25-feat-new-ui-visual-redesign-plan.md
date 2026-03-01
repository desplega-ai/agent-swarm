---
title: "feat: New UI Visual Redesign"
type: feat
status: active
date: 2026-02-25
deepened: 2026-02-25
generated_with: compound-engineering/workflows:plan + deepen-plan
---

# New UI Visual Redesign

## Enhancement Summary

**Deepened on:** 2026-02-25
**Research agents used:** repo-research-analyst, learnings-researcher, best-practices-researcher, Context7 (shadcn/ui, Tailwind v4, AG Grid), pattern-recognition-specialist, architecture-strategist, kieran-typescript-reviewer, browser-navigator

### Key Improvements
1. **Concrete CSS variable values** — Exact oklch values for the new Zinc-based palette, sourced from shadcn/ui v4 official theming docs
2. **AG Grid theming code** — Specific CSS variable overrides and JS theme API usage for neutral dark/light modes
3. **shadcn/ui native patterns** — Sidebar CSS variables, chart color tokens, component customization patterns from official docs
4. **Systematic approach for Phase 4** — Grep-and-replace strategy with token mapping table
5. **Critical sequencing fix** — Phase 1 keeps hive tokens as aliases to prevent AG Grid/body breakage

### New Considerations Discovered
- Tailwind v4 uses `@theme` directive for custom colors (not `tailwind.config.js`)
- AG Grid v35 supports JS theme API (`themeQuartz.withParams()`) for programmatic dark/light mode switching
- shadcn/ui chart colors are defined as `--chart-1` through `--chart-5` CSS variables with oklch — use these instead of custom chart palette
- Border color in dark mode should use `oklch(1 0 0 / 10%)` (white at 10% opacity) for subtle separation — this is the shadcn/ui v4 convention
- **Most beehive CSS utility classes are dead code** — only `animate-breathe` (stats-bar.tsx) and `animate-heartbeat` (app-header.tsx) are actually referenced from TSX files
- **Triple color system conflict** — The `globals.css` has oklch tokens in `@theme`, HSL tokens in `:root`, and an `@theme inline` bridge that overrides the oklch sidebar values with HSL ones. The oklch sidebar values are dead code.
- **44 direct Tailwind amber references** exist across 14 TSX files — this is the real migration work, not the hive CSS variables
- **Three independent status-to-color maps** exist (StatusBadge, services/page.tsx, dashboard/page.tsx) — should be consolidated
- **Sparklines in stats cards are scope creep** — current `StatsBarProps` has no historical data, and adding it would require API changes (violating "no API changes" constraint)

### Review Agent Findings

**TypeScript Reviewer** flagged:
- Phase 1 grep must catch `hive-` and `terminal-` Tailwind class usage (not just CSS utility classes)
- `statusConfig` should use `satisfies` for type safety
- Stats bar `color?: string` prop should become constrained variant union
- Phase 4 should be split into sub-phases: (4a) Dashboard + list pages, (4b) detail pages, (4c) Chat + Usage

**Architecture Strategist** flagged:
- **Sequencing bug**: Phase 1 removes hive tokens that `ag-grid.css`, `body` styles, and scrollbar styles depend on → must keep aliases or update simultaneously
- Phase 1 should be split: 1a (add new tokens alongside old), 1b (migrate references, remove old)
- Phases 2 and 3 are independent — can run in parallel
- Phase 5 (animations) is small enough to fold into Phase 1

**Pattern Recognition** found:
- Most `.glow-*`, `.honeycomb-bg`, `.hex-border`, `.text-gradient-amber`, `.card-hover`, `.row-hover`, `.clip-hex` CSS classes are **never referenced in any TSX file** — they're dead CSS
- Only 3 TSX files reference hive/terminal tokens directly: `app-sidebar.tsx`, `app-header.tsx`, `ag-grid.css`
- The real migration effort is 44 hardcoded Tailwind `text-amber-*`/`bg-amber-*` references across page components
- `formatInterval` is duplicated between `schedules/page.tsx` and `schedules/[id]/page.tsx` (out of scope but worth noting)
- Chart colors in `usage/page.tsx` are hardcoded hex (`#f59e0b`) not tokens

---

## Overview

The `new-ui` dashboard was recently built (Phases 1-6, merged Feb 25) as a modern replacement for the old MUI Joy UI dashboard. While functionally complete, it's visually a 1:1 port of the old UI's "beehive" theme — same hex colors, same honeycomb SVG background, same hexagonal stats bar, same Graduate display font, same glow effects. The result feels like a cheap copy rather than a design evolution.

The goal is to transform the new-ui into a polished, distinctive dashboard that leverages shadcn/ui's strengths instead of fighting them. Think **Linear**, **Vercel Dashboard**, **Raycast** — clean, sharp, professional, with purposeful use of color and motion.

## Problem Statement

**Why it looks like a cheap copy:**

1. **Aesthetic mismatch** — shadcn/ui is minimal/clean by design. Ornate honeycomb patterns, hexagonal clip-paths, and amber glow effects bolted onto Radix primitives create visual dissonance.
2. **Identical palette** — Exact same hex values (`#f5a623`, `#ffb84d`, `#d4a574`, `#c67c00`) carried over from the MUI Joy version. No design evolution occurred.
3. **Graduate display font** — A novelty cursive font that feels unprofessional in a monitoring dashboard. Does not complement Space Grotesk.
4. **Gimmicky decorations** — Hexagonal clip-path stats, honeycomb SVG backgrounds, breathing/pulsing animations on idle elements, grain overlays. These were coherent in the MUI Joy version but feel like CSS tricks in the shadcn/ui context.
5. **Tiny border radii** (0.25–0.75rem) — Creates sharp corners that clash with the organic "hive" metaphor and don't match shadcn/ui's typical rounded aesthetic.
6. **Color overload** — Amber everywhere (borders, hovers, glows, text, badges, stats, icons) makes everything blend together. No visual hierarchy.

## Proposed Solution

**Design Direction: "Mission Control"** — Clean, information-dense, professional. Amber/gold becomes a strategic accent (not the dominant color). Dark mode as the hero experience with cool neutrals and warm highlights for key data.

### Design Principles

1. **Let shadcn/ui breathe** — Use the library's native patterns, don't override everything with custom CSS
2. **Color with purpose** — Amber for brand accent and active states only; semantic colors for status; neutral base
3. **Typography hierarchy** — Professional font stack, clear size/weight scale, no novelty fonts
4. **Purposeful motion** — Animations only where they communicate state changes, not decorative loops
5. **Information density** — Pack data efficiently without clutter; let spacing and typography create hierarchy

## Technical Approach

### Architecture

All changes are CSS/component-level within `new-ui/src/`. No API changes, no routing changes, no data model changes. The redesign touches:

- `src/styles/globals.css` — Color system, CSS variables, animations, utility classes
- `src/styles/ag-grid.css` — Grid theme overrides
- `src/components/layout/` — Sidebar, header
- `src/components/shared/` — Stats bar, status badges, data grid, empty states
- `src/pages/` — Page-specific layout and visual updates
- `src/components/ui/` — Minimal shadcn/ui customization tweaks

### Implementation Phases

---

#### Phase 1: Color System & Typography Foundation

**Goal:** Replace the beehive palette with a refined system. Establish typography scale.

**Color System Changes** (`globals.css`):

- **Base neutrals:** Replace warm brown-blacks (`#0d0906`, `#1a130e`, `#251c15`) with cool-neutral dark tones (Zinc family from shadcn/ui).
- **Brand accent:** Keep amber but constrain it to `--primary` only — interactive elements, active nav items, focused inputs. One accent, not five shades.
- **Semantic status colors:** Standardize on Tailwind defaults — emerald for success, red for destructive, amber for warning, blue for info. Remove custom `hive-rust`, `hive-blue` redundancies.
- **Text hierarchy:** Use shadcn/ui's native `--foreground` / `--muted-foreground` system. Drop the custom `hive-text-*` vars.
- **Surface elevation:** Use shadcn/ui's `--background` → `--card` → `--popover` hierarchy.

### Research Insights: Exact CSS Variable Values

**Use shadcn/ui Zinc theme as the base**, then override `--primary` with amber for brand accent. Here are the exact oklch values from shadcn/ui v4 docs:

```css
/* globals.css — NEW color system */
@import "tailwindcss";

@layer base {
  :root {
    --radius: 0.625rem;
    --background: oklch(1 0 0);
    --foreground: oklch(0.141 0.005 285.823);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.141 0.005 285.823);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.141 0.005 285.823);
    /* BRAND: amber-700 as primary for light mode */
    --primary: oklch(0.555 0.163 48.998);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.967 0.001 286.375);
    --secondary-foreground: oklch(0.21 0.006 285.885);
    --muted: oklch(0.967 0.001 286.375);
    --muted-foreground: oklch(0.552 0.016 285.938);
    --accent: oklch(0.967 0.001 286.375);
    --accent-foreground: oklch(0.21 0.006 285.885);
    --destructive: oklch(0.577 0.245 27.325);
    --destructive-foreground: oklch(0.985 0 0);
    --border: oklch(0.92 0.004 286.32);
    --input: oklch(0.92 0.004 286.32);
    --ring: oklch(0.555 0.163 48.998); /* match primary */
    /* Charts: shadcn/ui defaults — balanced palette */
    --chart-1: oklch(0.646 0.222 41.116);
    --chart-2: oklch(0.6 0.118 184.704);
    --chart-3: oklch(0.398 0.07 227.392);
    --chart-4: oklch(0.828 0.189 84.429);
    --chart-5: oklch(0.769 0.188 70.08);
    /* Sidebar: shadcn/ui native vars */
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.141 0.005 285.823);
    --sidebar-primary: oklch(0.555 0.163 48.998);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.967 0.001 286.375);
    --sidebar-accent-foreground: oklch(0.21 0.006 285.885);
    --sidebar-border: oklch(0.92 0.004 286.32);
    --sidebar-ring: oklch(0.555 0.163 48.998);
  }

  .dark {
    --background: oklch(0.141 0.005 285.823);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.21 0.006 285.885);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.21 0.006 285.885);
    --popover-foreground: oklch(0.985 0 0);
    /* BRAND: amber-500 as primary for dark mode (brighter) */
    --primary: oklch(0.769 0.188 70.08);
    --primary-foreground: oklch(0.21 0.006 285.885);
    --secondary: oklch(0.274 0.006 286.033);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.274 0.006 286.033);
    --muted-foreground: oklch(0.705 0.015 286.067);
    --accent: oklch(0.274 0.006 286.033);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --destructive-foreground: oklch(0.985 0 0);
    /* KEY: white at 10% for borders — shadcn/ui v4 dark convention */
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.769 0.188 70.08); /* match primary */
    /* Charts: dark mode balanced palette */
    --chart-1: oklch(0.488 0.243 264.376);
    --chart-2: oklch(0.696 0.17 162.48);
    --chart-3: oklch(0.769 0.188 70.08);
    --chart-4: oklch(0.627 0.265 303.9);
    --chart-5: oklch(0.645 0.246 16.439);
    /* Sidebar */
    --sidebar: oklch(0.21 0.006 285.885);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.769 0.188 70.08);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.274 0.006 286.033);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.769 0.188 70.08);
  }
}
```

**Key design decisions in this palette:**
- Light `--primary` = Tailwind `amber-700` (`oklch(0.555 0.163 48.998)`) — darker amber for light mode contrast
- Dark `--primary` = Tailwind `amber-500` (`oklch(0.769 0.188 70.08)`) — brighter for dark bg visibility
- All neutrals are Zinc family (hue ~286) — cool gray, not warm brown
- Borders in dark mode: `oklch(1 0 0 / 10%)` — the shadcn/ui v4 standard
- Chart colors are shadcn/ui defaults — blue, teal, slate, yellow, amber. Balanced, not amber-dominant

**Typography Changes:**

- **Remove Graduate** display font entirely. Use Space Grotesk bold/semibold for headings.
- **Keep Space Grotesk** — it's a solid geometric sans-serif. Don't add Geist/Inter unless Space Grotesk proves problematic. Fewer fonts = faster loads.
- **Establish scale:** Page titles `text-xl font-semibold`, section headers `text-base font-medium`, body `text-sm`, detail `text-xs`. Reduce overall font sizes — the current `text-2xl` titles are too large for a data dashboard.
- **Keep Space Mono** for monospace (data values, IDs, code blocks) — it works well.

**Border Radius:**

- Set to shadcn/ui default: `--radius: 0.625rem` (10px). This gives cards `rounded-xl` feel, buttons `rounded-lg`, badges `rounded-full`.

**Phase 1a: Add new tokens alongside old ones**

1. Replace the `@theme` oklch values with the new Zinc-based palette (see CSS above)
2. **Remove the `:root` and `.dark` HSL sidebar variable blocks** (the ones using `hsl()`) — they override the oklch sidebar values via `@theme inline` and create dead code
3. **Remove the `@theme inline` bridge block** that maps `--color-sidebar: var(--sidebar)` — no longer needed
4. **Keep `--color-hive-*` vars temporarily** but redefine them as aliases to the new semantic tokens:
   ```css
   /* TEMPORARY ALIASES — remove in Phase 3 after AG Grid + body migration */
   --color-hive-body: var(--color-background);
   --color-hive-surface: var(--color-card);
   --color-hive-earth: var(--color-muted);
   --color-hive-border: var(--color-border);
   --color-hive-text-primary: var(--color-foreground);
   --color-hive-text-secondary: var(--color-muted-foreground);
   --color-hive-text-tertiary: var(--color-muted-foreground);
   --color-hive-amber: var(--color-primary);
   --color-hive-honey: var(--color-primary);
   --color-hive-gold: var(--color-primary);
   --color-hive-deep: var(--color-primary);
   --color-hive-rust: var(--color-destructive);
   --color-hive-blue: var(--color-info, oklch(0.623 0.214 259.815));
   ```
   This prevents `ag-grid.css`, `body` styles, and scrollbar styles from breaking.
5. Update `body` rule to use `var(--color-background)` and `var(--color-foreground)`
6. Update scrollbar rules to use `var(--color-background)` and `var(--color-border)`

**Phase 1b: Remove dead CSS and animations**

All of these CSS classes are **dead code** (never referenced in any TSX file):
- `.honeycomb-bg`, `.grain-overlay`
- `.glow-amber`, `.glow-gold`, `.glow-rust`, `.glow-blue`, `.box-glow-amber`, `.box-glow-gold`
- `.text-gradient-amber`
- `.hex-border::before`, `.clip-hex`
- `.card-hover`, `.row-hover`, `.focus-amber`
- `animate-pulse-amber` keyframe

Only 2 animation references exist in TSX:
- `animate-breathe` → used in `stats-bar.tsx:34` (will be removed in Phase 3 rewrite)
- `animate-heartbeat` → used in `app-header.tsx:32` (replace with static dot)

Safe to remove now:
- All dead CSS utility classes listed above
- `animate-pulse-amber` and `animate-heartbeat` keyframes (fix `app-header.tsx` reference)
- Graduate font from `index.html` Google Fonts link (reconstruct URL to keep Space Grotesk + Space Mono)
- `--font-display` variable from `globals.css`
- All `--color-terminal-*` variables (replace the 2 TSX references: `bg-terminal-green` → `bg-emerald-500` and `bg-terminal-red` → `bg-red-500` in `app-header.tsx`)

**Files to modify:**
- `src/styles/globals.css` — Complete overhaul (new tokens, aliases, remove dead CSS)
- `src/components/layout/app-header.tsx` — Replace `animate-heartbeat` with static dot, replace `terminal-*` classes
- `index.html` — Reconstruct Google Fonts link without Graduate

**Verification:**
```bash
cd new-ui && pnpm build
# Verify no build errors
# Check all hive/terminal references are either aliased or fixed:
grep -rE "(hive-|terminal-|honeycomb|glow-amber|glow-gold|text-gradient|hex-border|grain-overlay|font-display|clip-hex|Graduate)" src/ --include="*.tsx" --include="*.ts" --include="*.css"
# Expected: only the temporary aliases in globals.css and animate-breathe in stats-bar.tsx
pnpm dev  # Verify UI renders correctly with new palette but same layout
```

---

#### Phase 2: Layout & Navigation

**Goal:** Polish sidebar and header to feel native to shadcn/ui.

**Sidebar** (`app-sidebar.tsx`):

- Remove amber text for title. Use `text-sidebar-foreground` with the brand accent only on the logo mark.
- Navigation items: Remove left-border active indicator. Use `bg-sidebar-accent text-sidebar-accent-foreground` for active state — this is shadcn/ui's native sidebar pattern. These map to the CSS variables defined in Phase 1.
- Hover: `hover:bg-sidebar-accent/50` subtle highlight, not amber text color change.
- Group navigation items semantically with `SidebarGroup` + `SidebarGroupLabel`:
  - **Core:** Dashboard, Agents, Tasks, Epics
  - **Communication:** Chat
  - **Operations:** Services, Schedules, Usage
  - **System:** Config, Repos
- Footer: Add version/connection status indicator (small, muted).

### Research Insights: shadcn/ui Sidebar Pattern

shadcn/ui Sidebar uses dedicated CSS variables (`--sidebar-*`) that are independent from the main theme. This is already wired up in the Phase 1 color system. The sidebar should use:
- `data-[active=true]` attribute for active nav items (not custom classes)
- `SidebarMenuButton` component's built-in `isActive` prop
- Tooltip on collapsed state (built into shadcn/ui Sidebar)

**Header** (`app-header.tsx`):

- Simplify: breadcrumbs + right-side actions (theme toggle, command menu trigger, health dot).
- Health indicator: Simple green/red 6px circle. No animation. Tooltip on hover for details.
- Remove excess spacing; header should feel tight and functional.

**Main content area:**

- Keep full-width for data-dense pages (agents, tasks grids need horizontal space).
- Page padding: `px-6 py-6` desktop, `px-4 py-4` mobile.
- Do NOT add `max-w-7xl` — data grids benefit from full width on wide monitors.

**Files to modify:**
- `src/components/layout/app-sidebar.tsx`
- `src/components/layout/app-header.tsx`
- `src/components/layout/root-layout.tsx`

**Verification:**
```bash
cd new-ui && pnpm build
pnpm dev  # Visual inspection of sidebar/header at multiple widths
# Check: sidebar active state uses bg-accent, not amber border
# Check: sidebar collapse shows icon-only with tooltips
# Check: header is clean, health dot is simple
```

---

#### Phase 3: Core Shared Components

**Goal:** Upgrade the visual quality of reusable components.

**Stats Display** (`stats-bar.tsx`) — **Complete rewrite:**

- **Remove hexagonal clip-paths entirely.** Replace with a clean card grid.
- Use a row of compact stat cards: `grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3`.
- Each stat card: small icon + large number + label. No colored borders — keep it clean.
- Numbers in `font-mono tabular-nums text-2xl font-bold`.
- Labels in `text-xs text-muted-foreground uppercase tracking-wider`.
- **Sparklines/trends: OUT OF SCOPE** — `StatsBarProps` has no historical data, adding it requires API changes.
- Remove breathing animation — stats are static numbers.

```tsx
// stats-bar.tsx — simplified stat card
function StatCard({ icon: Icon, label, value, trend }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs uppercase tracking-wider">{label}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono tabular-nums text-2xl font-bold">
            {value}
          </span>
          {trend && (
            <span className={cn(
              "text-xs font-medium",
              trend > 0 ? "text-emerald-500" : "text-red-500"
            )}>
              {trend > 0 ? "+" : ""}{trend}%
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
```

**Status Badges** (`status-badge.tsx`):

- Keep the color-coded system but refine:
  - Use shadcn/ui `Badge` with variant `outline` as base.
  - Active states (busy, in_progress): subtle `animate-pulse` on a small dot next to the text, not the whole badge.
  - Text: `text-[11px] font-medium` (not bold + uppercase + tracking-wide).
  - Small colored dot (6px `rounded-full`) before the text.

```tsx
// status-badge.tsx — refined
const statusConfig = {
  idle:        { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  busy:        { dot: "bg-amber-500 animate-pulse", text: "text-amber-600 dark:text-amber-400" },
  offline:     { dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
  pending:     { dot: "bg-yellow-500", text: "text-yellow-600 dark:text-yellow-400" },
  in_progress: { dot: "bg-amber-500 animate-pulse", text: "text-amber-600 dark:text-amber-400" },
  completed:   { dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  failed:      { dot: "bg-red-500", text: "text-red-600 dark:text-red-400" },
  cancelled:   { dot: "bg-zinc-400", text: "text-zinc-500 dark:text-zinc-400" },
} as const;

function StatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? statusConfig.offline;
  return (
    <Badge variant="outline" className="gap-1.5 font-medium text-[11px]">
      <span className={cn("h-1.5 w-1.5 rounded-full", config.dot)} />
      <span className={config.text}>{status.replace("_", " ")}</span>
    </Badge>
  );
}
```

**Data Grid** (`data-grid.tsx` + `ag-grid.css`):

### Research Insights: AG Grid v35 Theming

AG Grid v35 supports a JS theme API alongside CSS variables. Use CSS variables for the color overrides since they integrate with the shadcn/ui CSS variable system:

```css
/* ag-grid.css — neutral theme overrides */
.ag-theme-quartz,
.ag-theme-quartz-dark {
  /* Map to shadcn/ui CSS vars */
  --ag-background-color: var(--background);
  --ag-foreground-color: var(--foreground);
  --ag-header-background-color: var(--muted);
  --ag-header-foreground-color: var(--muted-foreground);
  --ag-odd-row-background-color: transparent;
  --ag-row-hover-color: var(--accent);
  --ag-selected-row-background-color: var(--accent);
  --ag-border-color: var(--border);
  --ag-secondary-border-color: var(--border);
  --ag-font-family: "Space Grotesk", system-ui, sans-serif;
  --ag-font-size: 13px;
  --ag-header-column-resize-handle-color: var(--border);
  --ag-range-selection-border-color: var(--primary);
}
```

This approach ties AG Grid's colors directly to the shadcn/ui theme vars, so dark/light mode switching works automatically.

**Empty States** (`empty-state.tsx`):

- Add illustration or icon + title + description + optional CTA button.
- Center vertically in the available space.
- Muted colors, clean design.

**Also in Phase 3: Remove hive token aliases from globals.css**

After AG Grid is rethemed to use standard semantic tokens, the temporary `--color-hive-*` aliases from Phase 1a are no longer needed. Remove them:
```bash
grep -n "TEMPORARY ALIASES" src/styles/globals.css
# Remove the entire alias block
```

**Type safety improvements (while touching these files):**
- `StatusBadge`: Use `satisfies Record<string, StatusConfig>` for the config map
- Stats bar: Replace `color?: string` prop with `variant?: "amber" | "emerald" | "blue" | "red" | "yellow" | "zinc"`
- Standardize on `cn()` for all conditional class merging

**Files to modify:**
- `src/components/shared/stats-bar.tsx` — Rewrite
- `src/components/shared/status-badge.tsx` — Refine
- `src/components/shared/data-grid.tsx` — Retheme
- `src/components/shared/empty-state.tsx` — Polish
- `src/styles/ag-grid.css` — Neutral palette (use semantic CSS vars)
- `src/styles/globals.css` — Remove hive aliases

**Verification:**
```bash
cd new-ui && pnpm build
pnpm dev  # Check dashboard stats, agent/task grids, empty states
# Verify: AG Grid colors match theme in both dark and light mode
# Verify: status badges use dot pattern, not full-bg color
# Verify: no more hive aliases in globals.css
grep -rE "color-hive-" src/ --include="*.css" --include="*.tsx"
# Should return 0 results
```

---

#### Phase 4: Page-by-Page Visual Polish

**Goal:** Update each page to use the new design system consistently.

### Research Insights: Systematic Approach

Instead of editing 13 files individually, use a systematic grep-and-replace strategy:

**Step 1: Global search-and-replace** for common patterns across all pages:
```bash
# Find all amber hardcoded references
grep -rn "amber-\|hive-\|text-amber\|bg-amber\|border-amber" src/pages/ --include="*.tsx"

# Find all font-display (Graduate) references
grep -rn "font-display" src/pages/ --include="*.tsx"

# Find all glow/animation references
grep -rn "glow\|breathe\|heartbeat\|pulse-amber" src/pages/ --include="*.tsx"
```

**Step 2: Replace patterns:**
- `text-amber-500` → `text-primary` (uses CSS var, adapts to theme)
- `bg-amber-500` → `bg-primary`
- `border-amber-500/30` → `border-border`
- `text-hive-amber` → `text-primary`
- `font-display` → `font-sans font-semibold` (or just remove, use default)
- `text-2xl` page titles → `text-xl`
- Any amber icon color (`text-amber-400/500`) → `text-muted-foreground` (for decorative icons) or `text-primary` (for interactive icons)

### Token Mapping Table (for systematic replacement)

| Old Pattern | New Pattern | Context |
|-------------|-------------|---------|
| `text-hive-amber` | `text-primary` | Brand accent text |
| `border-hive-amber` | `border-primary` | Brand accent border |
| `bg-amber-600 hover:bg-amber-700` | `bg-primary hover:bg-primary/90` | Primary action buttons |
| `text-amber-400` (icons) | `text-muted-foreground` | Decorative icons in cards |
| `text-amber-400` (links) | `text-primary` | Interactive links |
| `bg-amber-500/15 text-amber-400` | `bg-primary/15 text-primary` | Active channel highlight |
| `bg-amber-500/20 text-amber-400` | `bg-muted text-muted-foreground` | Chat avatar circles |
| `bg-amber-500` (progress) | `bg-primary` | Progress bars |
| `hover:border-amber-500/30` | `hover:border-primary/30` | Card hover effect |
| `font-display text-2xl font-bold` | `text-xl font-semibold` | Page titles (21 occurrences!) |
| `hover:text-hive-amber` | `hover:text-primary` | Sidebar hover |
| `#f59e0b` (chart) | `var(--chart-1)` via Recharts | Chart colors |
| `#18181b` (tooltip bg) | CSS var reference | Recharts tooltip |

**Step 3: Sub-phased page updates**

**Phase 4a: Dashboard + list pages** (agents, tasks, epics, services, schedules, repos)
- Apply token mapping table globally across these files
- These are mostly grids + filter toolbars — changes are mechanical

**Phase 4b: Detail pages** (agents/[id], tasks/[id], epics/[id], schedules/[id])
- Apply token mapping table
- Task detail: terminal-styled log block (dark bg with `bg-zinc-950` and neutral text)
- Metadata sections: clean key-value pairs

**Phase 4c: Chat + Usage + Config** (most complex pages)
- Chat: avatar circles, send button, active channel highlight, message styling
- Usage: hardcoded `CHART_COLORS` array → use `--chart-*` CSS vars. Replace `background: "#18181b"` tooltip styles with CSS var references.
- Config: connection status, form styling

**Phase 4d: Consolidate status color maps**
- Extract `services/page.tsx:statusColors` and `dashboard/page.tsx:eventColors` to use shared constants or route through StatusBadge

**Verification gates between sub-phases:**
```bash
# After each sub-phase:
cd new-ui && pnpm build
pnpm dev  # Visual check of affected pages
grep -rn "amber-[0-9]\|hive-\|#f5a623\|#ffb84d\|#d4a574\|#c67c00" src/pages/ --include="*.tsx"
```

**Files to modify:**
- All files in `src/pages/` (13 page components)
- Focus on: replacing amber hardcodes with CSS var references, consistent spacing

**Verification (final):**
```bash
cd new-ui && pnpm build
pnpm dev  # Navigate through all pages, check visual consistency
# Verify no remaining hardcoded amber:
grep -rn "amber-[0-9]\|hive-\|#f5a623\|#ffb84d\|#d4a574\|#c67c00\|font-display" src/pages/ --include="*.tsx"
# Should return 0 results
```

---

#### Phase 5: Animations & Micro-interactions

**Goal:** Replace decorative animations with purposeful transitions.

**Remove from `globals.css`:**
```css
/* DELETE these keyframes */
@keyframes breathe { ... }
@keyframes pulse-amber { ... }
@keyframes heartbeat { ... }
```

**Keep (already in Tailwind):**
- `animate-pulse` — Only on actively in-progress status badge dots
- `animate-spin` — For loading spinners

**Hover transitions** — add to `globals.css`:
```css
/* Minimal utility for interactive element transitions */
.transition-default {
  @apply transition-colors duration-150 ease-in-out;
}
```

Actually, don't add a custom class. Just use Tailwind's built-in `transition-colors duration-150` directly in components. Fewer abstractions.

**Skeleton loading:** shadcn/ui `Skeleton` component already has a shimmer animation. Use it for loading states in data grids and stat cards.

**Files to modify:**
- `src/styles/globals.css` — Remove animation keyframes
- `src/components/shared/status-badge.tsx` — Ensure pulse only on dot, not whole badge

**Verification:**
```bash
cd new-ui && pnpm build
pnpm dev  # Test interactions, hover states, loading states
# Verify no breathing/heartbeat animations remain:
grep -rn "breathe\|heartbeat\|pulse-amber" src/ --include="*.tsx" --include="*.ts" --include="*.css"
```

---

#### Phase 6: Dark/Light Mode Consistency & Responsive Polish

**Goal:** Ensure both themes look great and responsive works well.

**Dark mode** (primary experience):

- The Zinc theme values from Phase 1 handle dark mode automatically via the `.dark` class.
- Key contrast check: `--primary` (amber-500, oklch 0.769) on `--background` (oklch 0.141) = sufficient contrast.
- `--muted-foreground` (oklch 0.705) on `--background` (oklch 0.141) = contrast ratio ~5:1, passes WCAG AA.
- Borders at `oklch(1 0 0 / 10%)` provide subtle separation without harsh lines.

**Light mode:**

- `--primary` in light mode is amber-700 (oklch 0.555), darker for contrast on white.
- Verify card borders (`oklch(0.92 0.004 286.32)`) are visible but subtle.

**Responsive:**

- Test at 320px, 768px, 1024px, 1440px, 1920px.
- Sidebar: Fully collapsed/hidden on mobile, expandable via trigger (built into shadcn/ui Sidebar).
- Stats grid: 2 cols on mobile, 4-5 on desktop.
- AG Grid: Horizontal scroll on mobile, full view on desktop.
- Chat: Full-width on mobile, split view on desktop.

**Accessibility:**

- Focus rings: shadcn/ui default ring uses `--ring` CSS var (set to match `--primary` in our palette).
- Color contrast: The Zinc palette is designed for WCAG AA compliance.
- Touch targets: Minimum 44x44px on mobile for buttons and nav items (check sidebar items).

**Files to modify:**
- `src/styles/globals.css` — Final audit of dark/light variables
- Various components — Responsive class adjustments if needed

**Verification:**
```bash
cd new-ui && pnpm build
pnpm dev
# Test both themes (toggle via header button)
# Test at: 320px, 768px, 1024px, 1440px, 1920px viewport widths
# Run Lighthouse audit for accessibility score
```

---

## Acceptance Criteria

### Functional Requirements

- [ ] All existing pages render correctly with no visual regressions in functionality
- [ ] Dark mode and light mode both look polished and consistent
- [ ] AG Grid data grids are readable and well-styled in both themes
- [ ] Status badges clearly communicate state with semantic colors
- [ ] Navigation is intuitive with clear active state indication
- [ ] Charts/visualizations use shadcn/ui chart color tokens (`--chart-1` through `--chart-5`)
- [ ] Command palette (Cmd+K) works correctly with new styling

### Visual Quality

- [ ] No honeycomb SVG backgrounds anywhere
- [ ] No hexagonal clip-path shapes
- [ ] No Graduate display font
- [ ] No amber glow effects (text-shadow or box-shadow)
- [ ] No breathing/heartbeat animations on static elements
- [ ] No `--color-hive-*` or `--color-terminal-*` CSS variables
- [ ] Amber/gold used only via `--primary` CSS variable, not hardcoded hex
- [ ] Consistent spacing and typography scale across all pages
- [ ] Professional appearance suitable for a monitoring/ops dashboard

### Non-Functional Requirements

- [ ] Build succeeds with no TypeScript errors (`pnpm build`)
- [ ] No unused CSS classes or imports
- [ ] Performance: No visible jank from CSS changes
- [ ] Responsive: Works at 320px through 1920px widths
- [ ] Accessibility: WCAG AA contrast ratios on text
- [ ] Font loading: Only Space Grotesk + Space Mono (no Graduate)

## Success Metrics

- The dashboard looks like it could be a product page for a YC startup — clean, professional, distinctive
- A screenshot of any page could be shared publicly without embarrassment
- New users can immediately understand status at a glance through color and layout alone
- The design feels native to shadcn/ui, not like a ported theme

## Dependencies & Risks

**Dependencies:**
- No external dependencies added. All changes use existing packages.
- shadcn/ui components are already installed.

**Risks:**
- **Scope creep** — Phase 4 (page-by-page) is the largest. The systematic grep approach mitigates this — most changes are mechanical find-replace.
- **AG Grid theming** — Mapping AG Grid CSS vars to shadcn/ui CSS vars is the key insight. Test with real data to verify colors render correctly.
- **oklch browser support** — oklch is supported in all modern browsers (Chrome 111+, Firefox 113+, Safari 15.4+). Not a concern for a developer tool dashboard.
- **Color accessibility** — The Zinc palette from shadcn/ui is pre-tested for WCAG AA. Our amber accent choices (amber-500 dark, amber-700 light) also pass.

## Sources & References

### Internal References
- Old UI theme: `ui/src/lib/theme.ts`, `ui/src/index.css`
- New UI styles: `new-ui/src/styles/globals.css`, `new-ui/src/styles/ag-grid.css`
- Layout: `new-ui/src/components/layout/`
- Shared components: `new-ui/src/components/shared/`
- All pages: `new-ui/src/pages/`

### External References (from Context7 research)
- shadcn/ui v4 theming (Zinc theme): https://ui.shadcn.com/docs/theming
- shadcn/ui Sidebar CSS variables: https://ui.shadcn.com/docs/components/sidebar
- shadcn/ui Chart color tokens: https://ui.shadcn.com/docs/components/chart
- Tailwind CSS v4 colors (oklch): https://tailwindcss.com/docs/colors
- Tailwind CSS v4 `@theme` directive: https://tailwindcss.com/docs/theme
- AG Grid React theming: https://ag-grid.com/react-data-grid/theming-colors
- AG Grid CSS variable customization: https://ag-grid.com/react-data-grid/theming-v32-customisation

### Design Inspiration
- Linear (linear.app) — Clean sidebar, neutral palette, subtle animations
- Vercel Dashboard — Information density, dark mode as primary
- Raycast — Typography hierarchy, status indicators

## Manual E2E Verification

After all phases:

```bash
cd new-ui

# Build check
pnpm build

# Start dev server
pnpm dev

# Open in browser and verify each page:
# http://localhost:5274/              — Dashboard with stats, activity feed
# http://localhost:5274/agents        — Agent grid with filters
# http://localhost:5274/agents/<id>   — Agent detail with tabs
# http://localhost:5274/tasks         — Task grid with filters
# http://localhost:5274/tasks/<id>    — Task detail with logs
# http://localhost:5274/epics         — Epics grid
# http://localhost:5274/chat          — Chat with channels
# http://localhost:5274/services      — Services grid
# http://localhost:5274/schedules     — Schedules grid
# http://localhost:5274/usage         — Charts and analytics
# http://localhost:5274/config        — Config panel
# http://localhost:5274/repos         — Repos grid

# Test both themes (toggle via header button)
# Test sidebar collapse/expand
# Test Cmd+K command palette
# Test at mobile viewport (320px) and desktop (1920px)

# Verify no CSS remnants:
grep -r "honeycomb\|glow-amber\|glow-gold\|Graduate\|hex-border\|grain-overlay\|breathe\|heartbeat\|pulse-amber\|hive-\|terminal-\|font-display\|clip-hex" src/ --include="*.tsx" --include="*.ts" --include="*.css"
# Should return 0 results
```
