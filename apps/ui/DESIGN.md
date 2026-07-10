---
name: Agent Swarm Dashboard
description: Mission-control dashboard for steering a fleet of coding agents — calm, capable, transparent.
colors:
  hive-amber: "oklch(0.555 0.163 48.998)"
  hive-amber-dark: "oklch(0.769 0.188 70.08)"
  background: "oklch(1 0 0)"
  background-dark: "oklch(0.141 0.005 285.823)"
  foreground: "oklch(0.141 0.005 285.823)"
  card: "oklch(1 0 0)"
  card-dark: "oklch(0.21 0.006 285.885)"
  surface: "oklch(0.985 0.0015 286)"
  muted: "oklch(0.967 0.001 286.375)"
  muted-foreground: "oklch(0.552 0.016 285.938)"
  border: "oklch(0.92 0.004 286.32)"
  destructive: "oklch(0.577 0.245 27.325)"
  status-success: "oklch(0.696 0.17 162.48)"
  status-active: "oklch(0.769 0.188 70.08)"
  status-error: "oklch(0.637 0.237 25.331)"
  status-info: "oklch(0.685 0.169 237.323)"
  status-pending: "oklch(0.795 0.184 86.047)"
  status-warning: "oklch(0.705 0.213 47.604)"
  status-paused: "oklch(0.623 0.214 259.815)"
  status-neutral: "oklch(0.552 0.016 285.938)"
typography:
  headline:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
  body:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Space Grotesk, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.025em"
  mono:
    fontFamily: "Space Mono, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.75rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "1rem"
  lg: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.hive-amber}"
    textColor: "oklch(0.985 0 0)"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  button-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  button-destructive-outline:
    backgroundColor: "{colors.background}"
    textColor: "{colors.status-error}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  badge-tag:
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.sm}"
    height: "1.25rem"
    padding: "0 0.375rem"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "1.5rem 0"
---

# Design System: Agent Swarm Dashboard

## 1. Overview

**Creative North Star: "Mission Control"**

This is the console an operator trusts while a fleet of autonomous coding agents does real work. The system is flight-deck steady: a quiet zinc neutral field in light and dark, dense-but-ordered readouts, and one voice of color — Hive Amber — reserved for what is interactive or alive right now. Status is a language here, not decoration: eight semantic status tones and eleven workflow action tones carry all meaning-bearing color, so a screen full of running agents reads as an ordered fleet, not an alarm board.

The system explicitly rejects PRODUCT.md's anti-references: no enterprise admin sprawl and no AI-startup gradient slop. Nothing shimmers unless something is genuinely running (the shimmer is a literal liveness indicator, the one theatrical move the system allows itself, and it means "work in progress"). Composure comes from borders and tonal layering rather than shadow drama; utility comes from crisp, small-radius controls that recede until needed.

**Key Characteristics:**
- One accent (Hive Amber) for interaction and liveness; everything else is zinc neutral or a named status tone.
- Flat, border-defined depth; shadows are whispers (`shadow-xs`/`shadow-sm`), never structure.
- Utilitarian and crisp controls: 36px-tall inputs/buttons, 6–8px radii, exact state vocabulary.
- Single-family typography (Space Grotesk) with Space Mono for IDs, logs, and machine output.
- Dual-theme by design: every token has a light and dark value; nothing is hardcoded to either.

## 2. Colors

A zinc-neutral field with one amber voice and a strictly named status vocabulary — restrained, semantic, theme-paired.

### Primary
- **Hive Amber** (oklch(0.555 0.163 48.998) light / oklch(0.769 0.188 70.08) dark): the brand and the pulse. Primary buttons, focus rings, selection, active/busy status, the live dot. It marks what you can act on and what is working right now — never used as decoration or large-area fill.

### Neutral
- **Background** (oklch(1 0 0) light / oklch(0.141 0.005 285.823) dark): the page field.
- **Card** (oklch(1 0 0) light / oklch(0.21 0.006 285.885) dark): bordered section containers; in dark mode one tonal step above background.
- **Surface** (oklch(0.985 0.0015 286) light / oklch(0.185 0.006 286) dark): the recessed step between background and card — nested blocks (e.g. tool-call rows in the session-log viewer) read as layered, not flat.
- **Muted / Accent** (oklch(0.967 0.001 286.375) light / oklch(0.274 0.006 286.033) dark): hover fills, secondary buttons, quiet panels.
- **Muted Foreground** (oklch(0.552 0.016 285.938) light / oklch(0.705 0.015 286.067) dark): secondary text, labels, descriptions.
- **Border** (oklch(0.92 0.004 286.32) light / oklch(1 0 0 / 10%) dark): the structural line that does the work shadows would do elsewhere. Dark-mode borders are white-alpha, so they layer on any surface.

### Status vocabulary (semantic, tokenized)
Eight canonical tones, each with a `-strong` text-emphasis variant and a `-foreground` for text on the fill. Light mode uses the 500 stop for fills and 600 for emphasis text; dark mode collapses both to the 400 stop.

- **Success** (emerald, oklch(0.696 0.17 162.48)): idle, completed, healthy, approved.
- **Active** (amber, oklch(0.769 0.188 70.08)): busy, running, in progress — the working hive.
- **Error** (red, oklch(0.637 0.237 25.331)): failed, unhealthy, rejected.
- **Info** (sky, oklch(0.685 0.169 237.323)): informational chips.
- **Pending** (yellow, oklch(0.795 0.184 86.047)): pending, waiting, starting.
- **Warning** (orange, oklch(0.705 0.213 47.604)): timeouts, threshold warnings.
- **Paused** (blue, oklch(0.623 0.214 259.815)): paused, reviewing.
- **Neutral** (zinc, oklch(0.552 0.016 285.938)): offline, backlog, cancelled, skipped.

Eleven `action-*` tokens (violet, cyan, teal, orange, indigo, pink, purple, blue, amber, yellow, sky) color workflow node types the same way: colored border/text with a `/10` translucent fill. All defined in `src/styles/globals.css`.

### Named Rules
**The Token-Only Rule.** Raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, `bg-[#0d1117]`) are forbidden in app code — the `check:tokens` lint gate fails the build on them. New colors enter the system only as named tokens in `globals.css`.

**The One Voice Rule.** Hive Amber speaks for interaction and liveness only. If amber appears on something that is neither actionable nor currently active, it is wrong.

## 3. Typography

**Body/UI Font:** Space Grotesk (with sans-serif fallback)
**Mono Font:** Space Mono (with monospace fallback)

**Character:** One family carries the whole interface — Space Grotesk's slightly technical geometry gives the console its voice without a display font shouting over the data. Space Mono marks machine territory: session IDs, log output, code, version strings.

### Hierarchy
- **Headline** (600, 1.25rem / `text-xl`): route-page titles via `PageHeader`. Fixed rem scale — nothing fluid, nothing clamped.
- **Title** (600, 1rem, leading-none): card and section titles (`CardTitle`).
- **Body** (400, 0.875rem / `text-sm`, 1.5): the default reading size for descriptions, form text, table cells. Prose runs at 65–75ch max.
- **Label** (500, 0.75rem / `text-xs`, uppercase + tracking-wide): `InfoRow` definition labels and quiet metadata.
- **Tag** (500, 9px, uppercase): the `Badge size="tag"` chip — the smallest voice in the system, reserved for status/kind chips.
- **Mono** (400, ~0.8125rem): IDs, logs, costs, tokens — anything the machine produced.

### Named Rules
**The Machine-Voice Rule.** If a human wrote it, it's Space Grotesk; if the system produced it (IDs, logs, code, raw payloads), it's Space Mono. Never mix within one value.

## 4. Elevation

Flat and border-defined. Depth is conveyed by tonal layering — background → surface (recessed) → card — and by the border token, which does the structural work. Shadows exist only as whispers: `shadow-xs` on buttons and inputs, `shadow-sm` on cards. They suggest physicality; they never establish hierarchy. Dark mode drops even that pretense and relies entirely on tonal steps plus white-alpha borders.

### Shadow Vocabulary
- **Whisper** (`shadow-xs`): buttons, inputs — barely-there lift on interactive controls.
- **Resting card** (`shadow-sm`): `Card` containers at rest.

### Named Rules
**The Border-First Rule.** If a container needs definition, reach for `border-border` or a tonal step (surface/card), never a bigger shadow. A shadow that reads as "elevation strategy" is a bug.

## 5. Components

Utilitarian and crisp: small radii (6–10px), 36px control heights, restrained fills, and a complete state vocabulary (default, hover, focus-visible ring, disabled at 50% opacity, aria-invalid) on every interactive element.

### Buttons
- **Shape:** gently rounded (`rounded-md`, 0.5rem); heights 24/32/36/40px (`xs`/`sm`/`default`/`lg`), square icon variants.
- **Primary:** Hive Amber fill, near-white text, `hover:bg-primary/90`.
- **Outline:** background fill + border, `shadow-xs`, hovers to the muted accent; dark mode uses translucent input fills (`dark:bg-input/30`).
- **Destructive-outline:** the canonical red-outlined action — `border-status-error/30 text-status-error hover:bg-status-error/10` — always paired with an `AlertDialog` confirmation.
- **Focus:** 3px `ring-ring/50` ring with `border-ring` — amber, consistent everywhere.
- **Ghost / Secondary / Link:** muted-fill hover, secondary-fill, and amber underline text respectively.

### Chips (Badge)
- **Style:** `size="tag"` is the system chip — 9px uppercase, 20px tall, 6px horizontal padding.
- **State:** semantic tone via status tokens (`border-status-info/30 text-status-info-strong`), never raw palette classes. `StatusBadge` maps all 18 entity statuses to the right tone.

### Cards / Containers
- **Corner Style:** `rounded-xl` (0.75rem).
- **Background:** `card` token; nested/recessed blocks step down to `surface`.
- **Shadow Strategy:** `shadow-sm` at rest (see Elevation); border does the definition.
- **Border:** always (`border-border`).
- **Internal Padding:** 24px vertical rhythm (`py-6`, `gap-6`, `px-6` on sections).

### Inputs / Fields
- **Style:** transparent background (translucent `input/30` in dark), `border-input`, `rounded-md`, 36px tall, `shadow-xs`.
- **Focus:** same 3px amber ring as buttons — one focus language across the app.
- **Error / Disabled:** `aria-invalid` ring + destructive border; disabled at 50% opacity, cursor blocked.

### Navigation
- **Style:** shadcn `Sidebar` shell (`app-sidebar.tsx`) on the sidebar token layer — one tonal step off the content field, amber for the active item; top-level `PageHeader` per route; global ⌘K `CommandMenu` for keyboard-first navigation.

### Signature Components
- **DataGrid** (AG Grid wrapper): the mandatory surface for every data list — themed via `ag-grid.css` to the token system, fills remaining page height, row-click drill-down with `stopPropagation` on inline actions.
- **Detail-page rail:** `DetailPageBody` (1fr main + fixed 280px rail) with `QuickStats` → `Relationships` → `DangerZone` in order — the canonical anatomy of every entity detail page.
- **Shimmer liveness:** `.shimmer-text` / `.shimmer-bar` — a sliding gradient that means, literally, "an agent is working right now." The system's one animated flourish, and it's semantic.

## 6. Do's and Don'ts

### Do:
- **Do** use named tokens for every color: `bg-status-success`, `text-status-error-strong`, `bg-action-script/10`. The lint gate enforces it.
- **Do** compose from the primitives catalog (`Button`, `Badge size="tag"`, `StatusBadge`, `DataGrid`, `DetailPageBody`, `SettingsRow`, `EmptyState`) before writing a raw `<div>` layout.
- **Do** keep one focus language: 3px `ring-ring/50` amber ring on every focusable control.
- **Do** use skeletons (`Skeleton`, `PageSkeleton`) for loading and `EmptyState` (icon + title + description + action) for empty lists — empty states teach the interface.
- **Do** hold WCAG 2.1 AA in both themes: ≥4.5:1 body contrast, keyboard access, `prefers-reduced-motion` alternatives (the shimmer must degrade to a static indicator).

### Don't:
- **Don't** hardcode theme colors — no `bg-zinc-950`, no `dark:` palette variants, no hex literals. Both themes are first-class.
- **Don't** drift toward "AI-startup gradient slop" (PRODUCT.md's words): no purple gradients, no glassmorphism, no sparkle theater around agent work.
- **Don't** rebuild "enterprise admin sprawl": no nested config mazes; primary actions live in the `PageHeader`, destructive ones confirm via `AlertDialog`, not click-again.
- **Don't** use HTML `<Table>` for data lists — `DataGrid` is a hard rule.
- **Don't** spend Hive Amber on decoration or inactive states; if it's not actionable or alive, it isn't amber.
- **Don't** animate anything that isn't conveying state. No orchestrated page loads, no decorative motion — the operator is in a task.
