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
  border-subtle: "oklch(0.945 0.003 286)"
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
- **Muted** (oklch(0.967 0.001 286.375) light / oklch(0.274 0.006 286.033) dark): secondary buttons, quiet resting panels.
- **Accent** (oklch(0.943 0.003 286.375) light / oklch(0.274 0.006 286.033) dark): the interactive hover/highlight fill (button hovers, menu highlights, grid row hover). One step darker than muted in light mode — at zinc-100 on a white field a hover is a 3% lightness step and effectively invisible. Presets that override accent keep the same one-step-below-muted relationship.
- **Muted Foreground** (oklch(0.552 0.016 285.938) light / oklch(0.705 0.015 286.067) dark): secondary text, labels, descriptions.
- **Border** (oklch(0.92 0.004 286.32) light / oklch(1 0 0 / 10%) dark): the structural line that does the work shadows would do elsewhere. Dark-mode borders are white-alpha, so they layer on any surface.
- **Border Subtle** (oklch(0.945 0.003 286) light / oklch(1 0 0 / 8%) dark): the quiet tier of the two-tier line system. Separators, row rules (`divide-y divide-border-subtle`), and data-grid row lines sit here so content reads in planes, not boxes. Card outlines and inputs stay on full `border` — the stronger stop is the affordance.

### Status vocabulary (semantic, tokenized)
Eight canonical tones, each with a `-strong` text-emphasis variant and a `-foreground` for text on the fill. The palette is the **pale set** (2026-08-06): the original Tailwind hues at ~40% less chroma with lifted lightness, so status reads as a quiet annotation on the zinc field rather than a saturated shout. Fills are pale enough that `-foreground` is dark text in BOTH modes; `-strong` stays a darker contrast-safe stop in light and collapses to the canonical value in dark. Exact values live in `globals.css` (the single source of truth).

- **Success** (green, oklch(0.74 0.1 163) light): idle, completed, healthy, approved.
- **Active** (amber, oklch(0.81 0.11 75) light): busy, running, in progress — the working hive.
- **Error** (red, oklch(0.72 0.12 25) light): failed, unhealthy, rejected.
- **Info** (blue, oklch(0.74 0.09 235) light): informational chips.
- **Pending** (yellow, oklch(0.84 0.1 95) light): pending, waiting, starting.
- **Warning** (orange, oklch(0.76 0.11 55) light): timeouts, threshold warnings.
- **Paused** (violet-blue, oklch(0.71 0.1 262) light): paused, reviewing.
- **Neutral** (zinc, oklch(0.62 0.014 286) light): offline, backlog, cancelled, skipped.

Classic-theme presets (`src/lib/theme-classics.ts` — github, vscode, material, solarized, tokyo, monokai, gruvbox) are the ONLY presets allowed to override status tokens: their identity includes a status palette. Hue semantics never change.

Eleven `action-*` tokens (violet, cyan, teal, orange, indigo, pink, purple, blue, amber, yellow, sky) color workflow node types the same way: colored border/text with a `/10` translucent fill. All defined in `src/styles/globals.css`.

### Named Rules
**The Token-Only Rule.** Raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, `bg-[#0d1117]`) are forbidden in app code — the `check:tokens` lint gate fails the build on them. New colors enter the system only as named tokens in `globals.css`.

**The One Voice Rule.** Hive Amber speaks for interaction and liveness only. If amber appears on something that is neither actionable nor currently active, it is wrong.

## 3. Typography

**Body/UI Font:** Space Grotesk (with sans-serif fallback)
**Mono Font:** Space Mono (with monospace fallback)

**Character:** One family carries the whole interface — Space Grotesk's slightly technical geometry gives the console its voice without a display font shouting over the data. Space Mono marks machine territory: session IDs, log output, code, version strings.

### Hierarchy
- **Headline** (600, 1.25rem / `text-xl`): in-content heroes only (e.g. the sessions "What would you like the swarm to do?"). Route pages have NO in-page h1 — the top-bar breadcrumb names the page. Fixed rem scale — nothing fluid, nothing clamped.
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
- **Focus:** 2px `ring-ring/60` ring with `border-ring` — amber, consistent everywhere.
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
- **Focus:** same 2px amber ring as buttons — one focus language across the app.
- **Error / Disabled:** `aria-invalid` ring + destructive border; disabled at 50% opacity, cursor blocked.

### Navigation
- **Style:** shadcn `Sidebar` shell (`app-sidebar.tsx`) on the sidebar token layer — one tonal step off the content field, amber for the active item; the borderless top bar's breadcrumb names the page (auto-humanized segments, entity names resolved; the home route shows the greeting there) while `PageHeader` carries only description/actions; global ⌘K `CommandMenu` for keyboard-first navigation.

### Signature Components
- **DataGrid** (AG Grid wrapper): the mandatory surface for every data list — themed via `ag-grid.css` to the token system, fills remaining page height, row-click drill-down with `stopPropagation` on inline actions.
- **Detail-page rail:** `DetailPageBody` (1fr main + fixed 280px rail) with `QuickStats` → `Relationships` → `DangerZone` in order — the canonical anatomy of every entity detail page.
- **Shimmer liveness:** `.shimmer-text` / `.shimmer-bar` — a sliding gradient that means, literally, "an agent is working right now." The system's one animated flourish, and it's semantic.

## 6. Do's and Don'ts

### Do:
- **Do** use named tokens for every color: `bg-status-success`, `text-status-error-strong`, `bg-action-script/10`. The lint gate enforces it.
- **Do** compose from the primitives catalog (`Button`, `Badge size="tag"`, `StatusBadge`, `DataGrid`, `DetailPageBody`, `SettingsRow`, `EmptyState`) before writing a raw `<div>` layout.
- **Do** keep one focus language: 2px `ring-ring/60` amber ring on every focusable control.
- **Do** use skeletons (`Skeleton`, `PageSkeleton`) for loading and `EmptyState` for empty lists — empty states teach the interface. First-run page empties get `fullPage` (vertically centered in the content area) and `entity="<noun>"`, which renders the "Ask the swarm" CTA seeding a new session with "Hey, help me set up my first <noun>".
- **Do** hold WCAG 2.1 AA in both themes: ≥4.5:1 body contrast, keyboard access, `prefers-reduced-motion` alternatives (the shimmer must degrade to a static indicator).

### Don't:
- **Don't** hardcode theme colors — no `bg-zinc-950`, no `dark:` palette variants, no hex literals. Both themes are first-class.
- **Don't** drift toward "AI-startup gradient slop" (PRODUCT.md's words): no purple gradients, no glassmorphism, no sparkle theater around agent work.
- **Don't** rebuild "enterprise admin sprawl": no nested config mazes; primary actions live in the `PageHeader`, destructive ones confirm via `AlertDialog`, not click-again.
- **Don't** use HTML `<Table>` for data lists — `DataGrid` is a hard rule.
- **Don't** spend Hive Amber on decoration or inactive states; if it's not actionable or alive, it isn't amber.
- **Don't** animate anything that isn't conveying state. No orchestrated page loads, no decorative motion — the operator is in a task.

## 7. Motion

**Doctrine: speed beats delight.** The operator is in a task; motion exists to carry state, feedback, and continuity — never to perform. (Derived from animations.dev / Emil Kowalski's published rules, filtered through Mission Control restraint.)

### Rules
- **Budget:** every UI animation under 300ms. Enters ease-out at 150-250ms; exits FASTER than enters (the user is already moving on). Large gesture surfaces (sheets, drawers) are the one exception: 400ms open / 250ms close on the swift curve.
- **Two named curves** (tokens in `globals.css`, utilities `ease-swift` / `ease-snappy`):
  - `--ease-swift: cubic-bezier(0.32, 0.72, 0, 1)` — sheets, drawers, large surfaces.
  - `--ease-snappy: cubic-bezier(0.2, 0, 0, 1)` — menus, popovers, small user-initiated reveals.
  - Never `ease-in` on UI. Never linear except shimmer-class liveness loops.
- **Animate `transform` and `opacity` only.** No layout properties, no box-shadow tweens. Popovers and menus scale from their trigger via `origin-(--radix-*-transform-origin)` (already wired in the primitives).
- **Frequency rule:** the more often an interaction happens, the less motion it gets. Keyboard-initiated actions, table polls, list updates, and route changes get NO animation.
- **Motivated or absent:** every animation names its job — state ("shimmer = an agent is working"), feedback (`active:scale-[0.98]` on buttons), hierarchy, or spatial continuity. "It looks cool" fails review.
- **Interruptible:** rapidly-triggered motion must retarget from its current state (CSS transitions, springs) — never restarting keyframes on hot paths.
- **Reduced motion is gentler, not zero:** `MotionConfig reducedMotion="user"` wraps the app (drops movement, keeps fades); handwritten CSS animations gate via `prefers-reduced-motion` blocks like the shimmer does.
- **The linger rule (hover timing is asymmetric):** hover states ENTER instantly and RELEASE softly — a ~50ms delay, then a ~200ms snappy fade (the Linear hover). Implemented as the `.hover-linger` utility in `globals.css`: a pure timing modifier that composes with the element's existing `transition-property`. Applies to pointer-hover surfaces (sidebar items, nav rows, flyout entries). Never on keyboard-driven highlights (menus, command palette), never on anything transitioning `transform`, and never on anything transitioning layout properties (width/height/padding) — the linger's rest delay makes contents trail their animating container (this was the sidebar collapse lag). Controls that need both get a per-property split: see `[data-slot="button"]` and `[data-sidebar="menu-button"]` in `globals.css`.
- **Press feedback (buttons):** `active:scale-[0.98]` — 0.97 on sm/icon sizes, where 2% of a 24–36px control is sub-pixel — with a per-property transition split: transform presses FAST (100ms) and eases back slightly slower (200ms) on release, while the button's colors ride the linger timing (instant in, 50ms + 200ms out). Implemented as the un-layered `[data-slot="button"]` block in `globals.css` — this split is what makes linger safe on a control that also transitions `transform`. `motion-reduce` pins the scale to 1. Sidebar nav rows deliberately do NOT press-scale: they navigate on click, and a full-width row wobbling on a high-frequency surface fails the frequency rule.
- **Overlay timing:** overlays keep the shadcn CSS `animate-in/out` mechanism (no motion-library rebase), retimed onto `ease-snappy` — Dialog / AlertDialog 200ms in, 150ms out; Popover / DropdownMenu / Select / Tooltip 150ms in, 100ms out. Sheets and drawers stay on the swift 400/250 large-surface exception.
- **Collapse pattern:** user-initiated toggles animate height/width + fade via the shared `AnimatedReveal` (`components/shared/animated-reveal.tsx`, also used by `CollapsibleSection` and the settings rail) — 200ms open, 150ms close, snappy; under reduced motion the movement drops and only the fade remains. Frequently-toggled surfaces (session-log expanders: tool cards, step groups, thinking rows, raw JSON) use the `fast` tier (150/120) — the frequency rule shaves the budget, it doesn't zero it, because these are CLICK-driven. Data CHANGES (polls, rows streaming in, list refreshes) still get no animation. The header chevron rotates (150ms) instead of swapping glyphs. The global sidebar rail (shadcn `sidebar.tsx`) runs its width/left transitions at 200ms on `ease-swift` — the stock `ease-linear` is banned, like all linear easing outside shimmer liveness loops.

### Animated icons
Vendored per-icon into `src/components/icons/` — we own the files; they run on `motion/react` and expose a `startAnimation`/`stopAnimation` imperative handle. Sources, in preference order: **lucide-animated** (`pqoqubbw/icons`, MIT — `bunx shadcn@latest add "https://lucide-animated.com/r/<icon>.json"`), **animateicons** (`Avijit07x/animateicons`, MIT — `https://animateicons.in/r/lu-<icon>.json`) for icons the first lacks, and hand-written files on the same pattern (exact lucide path data + a subtle variant animation) when neither ships one — see `list-todo.tsx` / `cable.tsx`.
- **Variants are transform-based — the glyph never blanks.** Never animate `pathLength`/`opacity` from 0, and never hold an accent invisible at rest: a draw-in blanks the glyph for ~150ms on a quick pass-over, and an interrupted hover strands it half-drawn. Retune registry draw-ins on vendoring: the gesture is a scale / rotate / translate accent on a fully-drawn glyph. SVG sub-elements pin their origin with `style={{ transformBox: "view-box", originX: "<x>px", originY: "<y>px" }}` (see `file-clock.tsx`); whole-svg transforms need nothing. Pulses that start and end at a fully-drawn stroke (`brain.tsx`) are fine — as ONE-SHOT gestures inside the same <300ms budget; a hover affordance never runs an unbounded loop. The registry files ship long, sometimes infinite timings — retime on vendoring, like the draw-ins.
- Use on interactive controls as hover/state affordance: theme toggle, refresh, the app-settings gear, and **navigation rows** (the whole sidebar set). When the icon sits in a larger click target, the CONTAINER drives it — attach the handle ref and call `startAnimation`/`stopAnimation` from the row's mouse enter/leave (see `NavIconLink` in `app-sidebar.tsx`) so the affordance matches the real hover zone.
- Never decorative loops, never in DATA surfaces (table rows, log lines, list items that render per-record), never on high-frequency updates.
- Inside `Button`, pass `size={16}`/`size={14}`; the button's svg sizing rules keep them aligned with static lucide icons.
