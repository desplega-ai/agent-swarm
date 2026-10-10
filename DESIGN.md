---
version: alpha
name: Agent Swarm dashboard
description: Zinc and amber dashboard theme, sourced from apps/ui; Hive dark values are canonical.
colors:
  background: "oklch(0.141 0.005 285.823)"
  foreground: "oklch(0.985 0 0)"
  card: "oklch(0.21 0.006 285.885)"
  card-foreground: "oklch(0.985 0 0)"
  surface: "oklch(0.185 0.006 286)"
  popover: "oklch(0.21 0.006 285.885)"
  popover-foreground: "oklch(0.985 0 0)"
  primary: "oklch(0.769 0.188 70.08)"
  primary-foreground: "oklch(0.21 0.006 285.885)"
  secondary: "oklch(0.274 0.006 286.033)"
  secondary-foreground: "oklch(0.985 0 0)"
  muted: "oklch(0.274 0.006 286.033)"
  muted-foreground: "oklch(0.705 0.015 286.067)"
  accent: "oklch(0.274 0.006 286.033)"
  accent-foreground: "oklch(0.985 0 0)"
  destructive: "oklch(0.704 0.191 22.216)"
  destructive-foreground: "oklch(0.985 0 0)"
  border: "oklch(1 0 0 / 10%)"
  border-subtle: "oklch(1 0 0 / 8%)"
  input: "oklch(1 0 0 / 15%)"
  ring: "oklch(0.769 0.188 70.08)"
  sidebar: "oklch(0.21 0.006 285.885)"
  sidebar-foreground: "oklch(0.985 0 0)"
  sidebar-primary: "oklch(0.769 0.188 70.08)"
  sidebar-primary-foreground: "oklch(0.985 0 0)"
  sidebar-accent: "oklch(0.274 0.006 286.033)"
  sidebar-accent-foreground: "oklch(0.985 0 0)"
  sidebar-border: "oklch(1 0 0 / 8%)"
  sidebar-ring: "oklch(0.769 0.188 70.08)"
  status-success: "oklch(0.78 0.1 163)"
  status-success-strong: "oklch(0.78 0.1 163)"
  status-success-foreground: "oklch(0.21 0.006 285.885)"
  status-success-solid: "oklch(0.723 0.219 149.6)"
  status-active: "oklch(0.84 0.1 80)"
  status-active-strong: "oklch(0.84 0.1 80)"
  status-active-foreground: "oklch(0.21 0.006 285.885)"
  status-active-solid: "oklch(0.769 0.188 70.08)"
  status-error: "oklch(0.74 0.11 22)"
  status-error-strong: "oklch(0.74 0.11 22)"
  status-error-foreground: "oklch(0.21 0.006 285.885)"
  status-info: "oklch(0.78 0.09 235)"
  status-info-strong: "oklch(0.78 0.09 235)"
  status-info-foreground: "oklch(0.21 0.006 285.885)"
  status-pending: "oklch(0.86 0.09 95)"
  status-pending-strong: "oklch(0.86 0.09 95)"
  status-pending-foreground: "oklch(0.21 0.006 285.885)"
  status-warning: "oklch(0.79 0.1 55)"
  status-warning-strong: "oklch(0.79 0.1 55)"
  status-warning-foreground: "oklch(0.21 0.006 285.885)"
  status-paused: "oklch(0.74 0.09 260)"
  status-paused-strong: "oklch(0.74 0.09 260)"
  status-paused-foreground: "oklch(0.21 0.006 285.885)"
  status-neutral: "oklch(0.72 0.012 286)"
  status-neutral-strong: "oklch(0.72 0.012 286)"
  status-neutral-foreground: "oklch(0.21 0.006 285.885)"
typography:
  sans:
    fontFamily: '"Space Grotesk", sans-serif'
  mono:
    fontFamily: '"Space Mono", monospace'
rounded:
  sm: 0.375rem
  md: 0.5rem
  lg: 0.625rem
  xl: 0.625rem
spacing:
  base: 0.25rem
omitted:
  - section: components
    reason: Shared primitives are documented in prose; motion and shadow fields have no supported schema category.

---

## Overview

Agent Swarm's dashboard manages agents, tasks, sessions, and workflows. Its shared theme uses shadcn Zinc surfaces with an amber primary.

## Colors

Semantic colors, status tokens, and mode overrides are owned by `apps/ui/src/styles/globals.css`.

Use primary for actions and ring for focus. Use accent for interactive hover fills and muted for quiet resting surfaces. Use border for structural outlines and border-subtle for separators. Use surface for recessed session-log blocks.

Status fills take their foreground token; use status-strong tokens for emphasis on neutral surfaces. Workflow action colors remain a separate named palette in the governing stylesheet.

Task, run, step, and approval status is drawn by `TaskStatusIcon` (`apps/ui/src/components/shared/task-status-icon.tsx`): a thin-stroke ring family on one 16px grid, with a green disc for done and a dashed amber ring for in progress. Its status-success-solid and status-active-solid stops are saturated on purpose and apply only to those glyphs; never use them for text or fills. `ProgressRing` is the aggregate form.

## Themes

The token frontmatter records Hive dark, matching the initial mode in `apps/ui/src/hooks/use-theme.ts`. The installed DESIGN.md schema has no theme-mode fields; the table preserves exact Hive light alternatives from `apps/ui/src/styles/globals.css`.

| Token | Light value |
| --- | --- |
| background | `oklch(1 0 0)` |
| foreground | `oklch(0.141 0.005 285.823)` |
| card | `oklch(1 0 0)` |
| card-foreground | `oklch(0.141 0.005 285.823)` |
| surface | `oklch(0.985 0.0015 286)` |
| popover | `oklch(1 0 0)` |
| popover-foreground | `oklch(0.141 0.005 285.823)` |
| primary | `oklch(0.555 0.163 48.998)` |
| primary-foreground | `oklch(0.985 0 0)` |
| secondary | `oklch(0.967 0.001 286.375)` |
| secondary-foreground | `oklch(0.21 0.006 285.885)` |
| muted | `oklch(0.967 0.001 286.375)` |
| muted-foreground | `oklch(0.552 0.016 285.938)` |
| accent | `oklch(0.943 0.003 286.375)` |
| accent-foreground | `oklch(0.21 0.006 285.885)` |
| destructive | `oklch(0.577 0.245 27.325)` |
| destructive-foreground | `oklch(0.985 0 0)` |
| border | `oklch(0.92 0.004 286.32)` |
| border-subtle | `oklch(0.945 0.003 286)` |
| input | `oklch(0.92 0.004 286.32)` |
| ring | `oklch(0.555 0.163 48.998)` |
| sidebar | `oklch(0.985 0 0)` |
| sidebar-foreground | `oklch(0.141 0.005 285.823)` |
| sidebar-primary | `oklch(0.555 0.163 48.998)` |
| sidebar-primary-foreground | `oklch(0.985 0 0)` |
| sidebar-accent | `oklch(0.943 0.003 286.375)` |
| sidebar-accent-foreground | `oklch(0.21 0.006 285.885)` |
| sidebar-border | `oklch(0.945 0.003 286)` |
| sidebar-ring | `oklch(0.555 0.163 48.998)` |
| status-success | `oklch(0.74 0.1 163)` |
| status-success-strong | `oklch(0.5 0.09 163)` |
| status-success-foreground | `oklch(0.21 0.006 285.885)` |
| status-success-solid | `oklch(0.627 0.194 149.2)` |
| status-active | `oklch(0.81 0.11 75)` |
| status-active-strong | `oklch(0.55 0.1 68)` |
| status-active-foreground | `oklch(0.21 0.006 285.885)` |
| status-active-solid | `oklch(0.666 0.179 58.318)` |
| status-error | `oklch(0.72 0.12 25)` |
| status-error-strong | `oklch(0.51 0.14 25)` |
| status-error-foreground | `oklch(0.21 0.006 285.885)` |
| status-info | `oklch(0.74 0.09 235)` |
| status-info-strong | `oklch(0.5 0.09 240)` |
| status-info-foreground | `oklch(0.21 0.006 285.885)` |
| status-pending | `oklch(0.84 0.1 95)` |
| status-pending-strong | `oklch(0.55 0.09 90)` |
| status-pending-foreground | `oklch(0.21 0.006 285.885)` |
| status-warning | `oklch(0.76 0.11 55)` |
| status-warning-strong | `oklch(0.53 0.11 50)` |
| status-warning-foreground | `oklch(0.21 0.006 285.885)` |
| status-paused | `oklch(0.71 0.1 262)` |
| status-paused-strong | `oklch(0.5 0.1 262)` |
| status-paused-foreground | `oklch(0.21 0.006 285.885)` |
| status-neutral | `oklch(0.62 0.014 286)` |
| status-neutral-strong | `oklch(0.48 0.014 286)` |
| status-neutral-foreground | `oklch(0.21 0.006 285.885)` |

Keep dark overrides on `.dark`, so scoped app presets can inherit correctly. Preserve the dashboard's saved light, dark, or system mode. Presets and per-app overrides belong to `apps/ui/src/lib/themes.ts` and `apps/ui/src/lib/json-render/theme-scope.tsx`; Hive values are not universal across those presets.

## Typography

Use the shared sans family for dashboard text and the mono family for code. Balance headings and card titles; use pretty wrapping for shared descriptions. Fonts and wrapping rules come from `apps/ui/src/styles/globals.css`; `apps/ui/index.html` loads the font families.

## Layout

Use the inherited Tailwind spacing unit for utilities rather than introducing a dashboard-local scale. `apps/ui/src/styles/globals.css` imports Tailwind v4; its `tailwindcss/theme.css` supplies the spacing base.

## Elevation & Depth

The schema has no shadow category; preserve these inherited Tailwind values when reusing the shared primitives.

| Shadow | Value |
| --- | --- |
| xs | `0 1px 2px 0 rgb(0 0 0 / 0.05)` |
| sm | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` |
| lg | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` |

Use the shared Card's subtle shadow for card surfaces and the shared Dialog/Sheet's larger shadow for overlays. Outlined buttons use the smallest shadow. Owners: `apps/ui/src/components/ui/card.tsx`, `dialog.tsx`, `sheet.tsx`, and `button.tsx`; exact shadows are inherited from `tailwindcss/theme.css` through the global import.

## Shapes

Reuse the radius tokens from `apps/ui/src/styles/globals.css`. Card uses xl and Dialog uses lg; both follow the tightened shared surface radius.

## Components

Use the shared primitives in `apps/ui/src/components/ui/` to retain their semantic colors, focus states, and disabled behavior.

## Do's and Don'ts

Keep `.hover-linger` off transform transitions and keyboard-driven highlights, as required by `apps/ui/src/styles/globals.css`. Preserve the stylesheet's reduced-motion overrides for shimmer and live indicators.

## Motion

The schema has no motion category; use the source timings below without treating them as exportable tokens.

| Shared behavior | Value |
| --- | --- |
| swift | `cubic-bezier(0.32, 0.72, 0, 1)` |
| snappy | `cubic-bezier(0.2, 0, 0, 1)` |
| Hover entrance / exit / exit delay | `0s` / `200ms` / `50ms` |
| Button press / release | `100ms` / `200ms` |
| Dialog entrance / exit | `200ms` / `150ms` |
| Sheet entrance / exit | `400ms` / `250ms` |

Motion curves and hover/button timing come from `apps/ui/src/styles/globals.css`. Use swift for large sheets and snappy for small interactive surfaces. Keep button press transforms independent of the delayed color release. Dialog and Sheet timings belong to `apps/ui/src/components/ui/dialog.tsx` and `sheet.tsx`; preserve their separate entrance and exit timing.

## Known divergences

- `docs-site/app/globals.css` imports Fumadocs neutral/preset styles. Its light fd-accent remains `oklch(0.967 0.001 286.375)`, while the dashboard uses `oklch(0.943 0.003 286.375)`. Primary and ring match in both modes. `docs-site/app/layout.tsx` does not load the dashboard's Space font families.
- `apps/evals/ui/src/styles.css` uses its own CSS tokens and controls. Its dark border uses 12% white instead of the dashboard's 10%; its light background is `#fafafa` instead of white. Its saturated hex status colors differ from the dashboard's pale semantic status palette. It shares the Space families and amber primary but adds system font fallbacks, uses a compact body size, and owns separate control radii and overlay shadows.
