---
date: 2026-02-25T12:00:00Z
topic: "Modern Dashboard UI Design Best Practices (2025-2026)"
---

# Modern Dashboard UI Design Best Practices (2025-2026)

Research date: 2026-02-25
Context: Agent Swarm monitoring dashboard redesign, moving from MUI Joy + amber/beehive theme to a modern, polished design system.

---

## Table of Contents

1. [Color Palette Design for Dark-Mode-First Dashboards](#1-color-palette-design)
2. [Visual Hierarchy, Spacing, and Typography](#2-visual-hierarchy-spacing-typography)
3. [shadcn/ui + Tailwind CSS v4 Dashboard Patterns](#3-shadcn-tailwind-v4)
4. [AG Grid Theming Best Practices](#4-ag-grid-theming)
5. [Sidebar Navigation Design Patterns](#5-sidebar-navigation)
6. [Status Indicators and Badge Design](#6-status-indicators)
7. [Card vs Table Layouts for Monitoring](#7-card-vs-table-layouts)
8. [Micro-Animations and Transitions](#8-micro-animations)
9. [Reference Dashboards and Design Systems](#9-reference-dashboards)
10. [Concrete Recommendations for Agent Swarm](#10-agent-swarm-recommendations)

---

## 1. Color Palette Design

### Moving Beyond Amber/Gold

The current Agent Swarm UI uses a warm amber/honey/gold palette (#F5A623 primary, #D4A574 gold, #0d0906 body). While thematic ("beehive"), this approach has several issues:

- Amber/warm tones on dark backgrounds produce a "dated" or "retro terminal" aesthetic
- Limited semantic range: amber already means "warning" in most color systems, so using it as a primary creates confusion
- The warm brown surfaces (#1a130e, #251c15) reduce contrast compared to neutral darks

### Modern Dark Mode Color Theory

**Source: Material Design, Linear, Vercel Geist, shadcn/ui defaults**

The industry consensus in 2025-2026:

1. **Use near-black neutrals, not pure black or tinted blacks**
   - Pure #000000 is too harsh and eliminates elevation perception
   - Tinted blacks (like the current #0d0906 warm brown) bias the entire palette
   - Best practice: neutral grays with very slight cool or warm tint

2. **OKLCH color space** is the new standard for generating perceptually uniform palettes
   - Linear migrated to LCH for theme generation
   - shadcn/ui now uses OKLCH as default format
   - Key advantage: changing lightness doesn't cause hue/saturation drift

3. **Layered darkness for elevation** (Material Design principle)
   - Base: #09111A to #121212 range
   - Surface +1: 5% lighter (cards, panels)
   - Surface +2: 8-10% lighter (popovers, dropdowns)
   - Surface +3: 12-15% lighter (elevated modals)

### Recommended Dark Palette: Cool Neutral

A cool neutral palette that doesn't commit to a strong brand hue, keeping the focus on content:

```css
/* === BACKGROUNDS (layered darkness) === */
--background:        oklch(0.145 0 0);        /* ~#0a0a0a - page base */
--surface-1:         oklch(0.175 0.005 270);   /* ~#111318 - cards, panels */
--surface-2:         oklch(0.21 0.006 270);    /* ~#181b22 - elevated cards */
--surface-3:         oklch(0.25 0.007 270);    /* ~#1f2330 - popovers, modals */

/* === BORDERS === */
--border:            oklch(1 0 0 / 8%);        /* subtle white overlay */
--border-strong:     oklch(1 0 0 / 14%);       /* active/focused borders */

/* === TEXT === */
--text-primary:      oklch(0.985 0 0);         /* ~#fafafa - headings, primary */
--text-secondary:    oklch(0.71 0.01 270);     /* ~#a1a1aa - descriptions */
--text-tertiary:     oklch(0.55 0.01 270);     /* ~#71717a - timestamps, hints */
--text-muted:        oklch(0.45 0.01 270);     /* ~#52525b - disabled text */
```

### Accent Color: Moving to Blue-Indigo

Instead of amber as the primary accent, use a blue-indigo which:
- Is universally understood as "interactive/clickable"
- Provides clear contrast against warm semantic colors (success green, warning amber, error red)
- Works well for selection highlights, links, and focus rings

```css
/* === ACCENT (Blue-Indigo) === */
--accent:            oklch(0.62 0.19 264);     /* ~#6366f1 - indigo-500 */
--accent-hover:      oklch(0.56 0.21 264);     /* ~#4f46e5 - indigo-600 */
--accent-muted:      oklch(0.62 0.19 264 / 15%); /* selection backgrounds */
--accent-foreground: oklch(0.985 0 0);         /* white text on accent */

/* === SEMANTIC COLORS === */
/* Success - Emerald */
--success:           oklch(0.70 0.17 162);     /* ~#10b981 - emerald-500 */
--success-muted:     oklch(0.70 0.17 162 / 15%);

/* Warning - Amber (now properly semantic, not primary) */
--warning:           oklch(0.75 0.18 80);      /* ~#f59e0b - amber-500 */
--warning-muted:     oklch(0.75 0.18 80 / 15%);

/* Error/Destructive - Red */
--error:             oklch(0.63 0.21 25);      /* ~#ef4444 - red-500 */
--error-muted:       oklch(0.63 0.21 25 / 15%);

/* Info - Sky Blue */
--info:              oklch(0.68 0.14 230);     /* ~#38bdf8 - sky-400 */
--info-muted:        oklch(0.68 0.14 230 / 15%);
```

### Alternative Accent: Teal-Cyan

If indigo feels too "generic", teal-cyan is a distinctive alternative that's popular in monitoring/DevOps tools (Datadog, Grafana):

```css
--accent:            oklch(0.72 0.15 190);     /* ~#14b8a6 - teal-500 */
--accent-hover:      oklch(0.66 0.16 190);     /* ~#0d9488 - teal-600 */
```

### Chart Colors (5-color data visualization palette)

```css
--chart-1:           oklch(0.62 0.19 264);     /* indigo - primary series */
--chart-2:           oklch(0.70 0.17 162);     /* emerald - secondary */
--chart-3:           oklch(0.68 0.14 230);     /* sky blue */
--chart-4:           oklch(0.72 0.16 310);     /* purple/violet */
--chart-5:           oklch(0.75 0.18 80);      /* amber */
```

---

## 2. Visual Hierarchy, Spacing, and Typography

### Typography

**Source: Linear redesign, font pairing research, data-dense UI studies**

**Recommendation: Inter + JetBrains Mono (or Geist Sans + Geist Mono)**

| Use Case | Font | Weight | Size |
|---|---|---|---|
| Page titles | Inter Display (or Inter) | 600 | 20-24px |
| Section headings | Inter | 600 | 16-18px |
| Card titles | Inter | 500 | 14-15px |
| Body text | Inter | 400 | 13-14px |
| Table data | Inter (tabular nums) | 400 | 13px |
| Code/IDs/timestamps | JetBrains Mono | 400 | 12-13px |
| Badges/labels | Inter | 600 | 11-12px (UPPERCASE, 0.05em tracking) |

Key insight from research: **Use tabular numerals in proportional fonts for numeric data** rather than monospace. Monospace is overkill for numbers. Inter supports `font-variant-numeric: tabular-nums` which gives aligned columns with better readability.

Current UI uses Space Grotesk + Space Mono. These are fine fonts but:
- Space Grotesk has a more "playful" personality than a monitoring dashboard warrants
- Inter is the industry standard for data-dense UIs (Linear, Vercel, shadcn, Raycast all use it)

### Spacing Scale

Follow the Tailwind 4px grid (each unit = 0.25rem = 4px):

```
Micro:    4px  (gap between icon and label)
Small:    8px  (gap between related items, padding in small components)
Medium:   12px (card internal padding, gap between list items)
Regular:  16px (standard content padding)
Large:    24px (section gaps, card padding)
XLarge:   32px (page-level section spacing)
XXLarge:  48px (major layout divisions)
```

**Dashboard-specific spacing rules:**
- Card padding: 16px (p-4) for standard, 20px (p-5) for featured cards
- Gap between cards in a grid: 16px (gap-4)
- Sidebar width: 240px expanded, 48px collapsed (icon-only)
- Tab bar height: 40px
- Table row height: 40-44px for data density without feeling cramped
- Header height: 48-56px

### Visual Hierarchy Principles

1. **Size contrast for emphasis**: Titles 20-24px, body 13-14px (1.5-1.8x ratio)
2. **Color contrast for importance**: Primary text (#fafafa) vs secondary (#a1a1aa) - clear 2-level system
3. **Weight contrast for scanability**: 600 weight for headings/labels, 400 for body
4. **Spatial grouping**: Related content is 8-12px apart; unrelated content 24-32px apart
5. **Border-free elevation**: Use background color differences instead of visible borders where possible (Linear's approach)

---

## 3. shadcn/ui + Tailwind CSS v4 Dashboard Patterns

### Tailwind v4 Architecture

Tailwind v4 fundamentally changes how you configure themes:

```css
/* No more tailwind.config.js - everything in CSS */
@import "tailwindcss";

@theme {
  /* Design tokens become CSS variables that auto-generate utilities */
  --color-background: oklch(0.145 0 0);
  --color-surface: oklch(0.175 0.005 270);
  --color-accent: oklch(0.62 0.19 264);

  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  --spacing-md: 0.75rem;
  --spacing-lg: 1rem;

  --font-sans: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", monospace;

  --radius-sm: 0.375rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
}
```

### Three-Layer Token Hierarchy (Best Practice)

```css
/* Layer 1: Base (raw palette) */
--color-gray-50:  oklch(0.985 0 0);
--color-gray-100: oklch(0.95 0.003 270);
--color-gray-900: oklch(0.21 0.006 270);
--color-gray-950: oklch(0.145 0 0);

/* Layer 2: Semantic (maps to purpose) */
--color-background: var(--color-gray-950);
--color-foreground: var(--color-gray-50);
--color-muted: var(--color-gray-900);
--color-muted-foreground: var(--color-gray-400);

/* Layer 3: Component (variant-specific) */
--sidebar-background: var(--color-gray-900);
--sidebar-foreground: var(--color-gray-50);
--card-background: var(--color-surface);
```

Never skip the semantic layer -- it's what makes refactors safe.

### shadcn/ui Default Dark Theme (Reference)

As of 2025-2026, shadcn/ui uses OKLCH by default:

```css
.dark {
  --background:            oklch(0.145 0 0);
  --foreground:            oklch(0.985 0 0);
  --card:                  oklch(0.205 0 0);
  --card-foreground:       oklch(0.985 0 0);
  --popover:               oklch(0.205 0 0);
  --popover-foreground:    oklch(0.985 0 0);
  --primary:               oklch(0.92 0.004 286.32);
  --primary-foreground:    oklch(0.21 0.006 285.885);
  --secondary:             oklch(0.274 0.006 286.033);
  --secondary-foreground:  oklch(0.985 0 0);
  --muted:                 oklch(0.274 0.006 286.033);
  --muted-foreground:      oklch(0.705 0.015 286.067);
  --accent:                oklch(0.274 0.006 286.033);
  --accent-foreground:     oklch(0.985 0 0);
  --destructive:           oklch(0.704 0.191 22.216);
  --border:                oklch(1 0 0 / 10%);
  --input:                 oklch(1 0 0 / 15%);
  --ring:                  oklch(0.552 0.016 285.938);
  --sidebar:               oklch(0.21 0.006 285.885);
  --sidebar-foreground:    oklch(0.985 0 0);
  --sidebar-primary:       oklch(0.488 0.243 264.376);
  --sidebar-primary-foreground: oklch(0.985 0 0);
  --sidebar-accent:        oklch(0.274 0.006 286.033);
  --sidebar-accent-foreground:  oklch(0.985 0 0);
  --sidebar-border:        oklch(1 0 0 / 10%);
}
```

### Essential shadcn Components for Dashboards

- **Card** -- metric containers, KPI displays
- **DataTable** -- powered by TanStack Table, sorting/filtering/pagination built in
- **Sidebar** -- collapsible navigation with icon-only mode
- **Tabs** -- content section switching
- **Badge** -- status indicators
- **Sheet** -- mobile-responsive slide-in panels
- **Command** -- command palette (Cmd+K)
- **Chart** -- built on Recharts, inherits theme colors

---

## 4. AG Grid Theming Best Practices

### Modern AG Grid Theming API

AG Grid's Theming API (v31+) uses `themeQuartz` with `withParams`:

```typescript
import { themeQuartz, colorSchemeDark } from "ag-grid-community";

const customDarkTheme = themeQuartz
  .withPart(colorSchemeDark)
  .withParams({
    // Match your dashboard background
    backgroundColor: "#111318",

    // Match your text colors
    foregroundColor: "#fafafa",

    // Match your accent color
    accentColor: "#6366f1",

    // Borders -- subtle
    borderColor: "rgba(255, 255, 255, 0.08)",

    // Row alternation
    oddRowBackgroundColor: "rgba(255, 255, 255, 0.02)",

    // Header styling
    headerBackgroundColor: "#0f1116",
    headerTextColor: "#a1a1aa",
    headerFontWeight: 600,
    headerFontSize: 12,

    // Cell text
    cellTextColor: "#e4e4e7",
    fontSize: 13,

    // Selection
    selectedRowBackgroundColor: "rgba(99, 102, 241, 0.12)",
    rangeSelectionBorderColor: "#6366f1",

    // Chrome (panels, toolbars)
    chromeBackgroundColor: "#0f1116",

    // Spacing
    cellHorizontalPadding: 12,
    rowHeight: 40,
    headerHeight: 40,

    // Borders
    rowBorderColor: "rgba(255, 255, 255, 0.04)",
    columnBorderColor: "transparent",

    // Font
    fontFamily: "'Inter', system-ui, sans-serif",
  });
```

### Key AG Grid Dark Mode Principles

1. **Match the grid background to your card/surface color** -- the grid should feel embedded, not floating
2. **Reduce border prominence** -- use very subtle borders (4-8% white opacity) or eliminate column borders entirely
3. **Dim the header** -- header should be slightly darker than data rows, with muted text color
4. **Use subtle row alternation** -- 2-3% white overlay for odd rows, not a visible color difference
5. **Accent color for selection only** -- don't overuse the accent; let data be neutral
6. **Match font to your dashboard** -- set fontFamily to match your UI typography
7. **Consistent row height** -- 40px is the sweet spot for data density with touch-friendliness

### Custom CSS Overrides for Polish

```css
/* Remove the outer grid border for seamless card integration */
.ag-root-wrapper {
  border: none !important;
  border-radius: 0 !important;
}

/* Soften header separator */
.ag-header {
  border-bottom: 1px solid rgba(255, 255, 255, 0.06) !important;
}

/* Status cell with colored dot */
.ag-cell.status-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Smooth hover transition */
.ag-row:hover {
  transition: background-color 150ms ease;
}
```

---

## 5. Sidebar Navigation Design Patterns

### shadcn/ui Sidebar Architecture

The shadcn sidebar component provides a battle-tested pattern:

```
SidebarProvider (manages state)
  Sidebar (collapsible="icon" | "offcanvas" | "none")
    SidebarHeader
      Logo / App name (hidden when collapsed)
    SidebarContent
      SidebarGroup (label: "Navigation")
        SidebarMenu
          SidebarMenuItem -> SidebarMenuButton
      SidebarGroup (label: "Management")
        Collapsible
          SidebarGroupLabel -> CollapsibleTrigger
          CollapsibleContent
            SidebarMenu -> items
    SidebarFooter
      User avatar / settings
  SidebarRail (thin resize/toggle rail)
```

### Design Token Setup

```css
--sidebar-width: 16rem;           /* 256px expanded */
--sidebar-width-mobile: 18rem;    /* 288px on mobile sheet */
--sidebar-width-icon: 3rem;       /* 48px collapsed */
```

### Navigation Grouping for Agent Swarm

Recommended sidebar structure:

```
[Icon] Agent Swarm          <- Logo/app name

--- Core ---
  Agents          (Users icon)
  Tasks           (ListTodo icon)
  Epics           (Target icon)
  Chat            (MessageSquare icon)

--- System ---
  Services        (Server icon)
  Schedules       (Clock icon)
  Repos           (GitBranch icon)

--- Analytics ---
  Usage           (BarChart3 icon)

--- Bottom (footer) ---
  Config          (Settings icon)
  Theme toggle    (Sun/Moon icon)
```

### Collapse Behavior

1. **Desktop**: Default expanded, user can collapse to icon-only mode
2. **Collapsed mode**: Show only icons (24px), tooltip on hover for label
3. **Mobile**: Off-canvas sheet that slides in from left
4. **Active state**: Highlighted with accent-muted background + accent left border or indicator dot
5. **Persist state**: Store collapse preference in localStorage

### Active Item Styling

```css
/* Active nav item */
.nav-item-active {
  background: oklch(0.62 0.19 264 / 12%);  /* accent at 12% opacity */
  color: oklch(0.75 0.15 264);              /* lighter accent for text */
  border-left: 2px solid oklch(0.62 0.19 264);
  font-weight: 500;
}

/* Hover state */
.nav-item:hover {
  background: oklch(1 0 0 / 5%);
}
```

---

## 6. Status Indicators and Badge Design

### Semantic Status Colors

**Source: Carbon Design System, Material Design, AIA Qi Design System, industry consensus**

For a monitoring dashboard, define status by semantic meaning, not arbitrary colors:

| Status | Color | Hex (Dark Mode) | OKLCH | Use Case |
|---|---|---|---|---|
| Success/Online/Completed | Emerald | #10b981 | oklch(0.70 0.17 162) | Healthy, done, active |
| Warning/Busy/In Progress | Amber | #f59e0b | oklch(0.75 0.18 80) | Attention needed |
| Error/Failed | Red | #ef4444 | oklch(0.63 0.21 25) | Critical, broken |
| Info/Reviewing | Blue | #3b82f6 | oklch(0.62 0.16 255) | Informational |
| Neutral/Offline/Cancelled | Gray | #71717a | oklch(0.55 0.01 270) | Inactive, disabled |
| Special/Offered | Violet | #8b5cf6 | oklch(0.58 0.22 293) | Queued, pending action |

### Badge Design Pattern

```tsx
// Minimal badge - colored dot + uppercase label
<span className="inline-flex items-center gap-1.5 px-2 py-0.5
  rounded-full text-[11px] font-semibold tracking-wider uppercase
  bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
  <span className="size-1.5 rounded-full bg-emerald-500" />
  Online
</span>
```

### Design Rules for Status Badges

1. **Use a colored dot + text** -- never rely on color alone (accessibility)
2. **Background at 10-15% opacity** of the status color -- just enough to create a "pill"
3. **Border at 15-20% opacity** -- adds definition without heaviness
4. **Text in a lighter shade** of the status color (400 weight in Tailwind scale)
5. **Uppercase, small, tracked** -- 11-12px, font-weight 600, letter-spacing 0.05em
6. **Monospace or tabular font** not needed for badges -- use the UI font
7. **Animated pulse only for truly active states** -- "in_progress" and "busy" only, not everything

### Dot Indicator Patterns

For compact spaces (table cells, sidebar), use dot-only indicators:

```css
/* Pulsing dot for active */
.status-dot-active {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4);
  animation: pulse-ring 2s ease-out infinite;
}

@keyframes pulse-ring {
  0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
  70% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
  100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
}

/* Static dot for stable states */
.status-dot-static {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
```

---

## 7. Card vs Table Layouts for Monitoring

### When to Use Each

| Layout | Best For | Agent Swarm Context |
|---|---|---|
| **Card grid** | Aggregate stats, KPIs, individual entity detail | Stats bar (top), agent overview cards, epic cards |
| **Data table** | Large lists, sortable/filterable data, homogeneous items | Tasks list, agent list (when many), services registry |
| **Hybrid** | Master-detail patterns | Agent list (table) + detail panel (cards) |

### Card Layout Best Practices

- **Maximum 5-6 cards** in initial viewport -- don't overwhelm
- **Consistent card dimensions** within a row
- **KPI cards**: Large number (24-32px), label below (12-13px muted), optional sparkline
- **Entity cards**: Title, 2-3 key properties, status badge, timestamp
- **Card padding**: 16-20px, border-radius 8-12px
- **Card hover**: Subtle border glow or slight background lighten (not scale transform)

### KPI Card Example

```tsx
<div className="rounded-xl bg-surface-1 border border-white/[0.08] p-5">
  <div className="flex items-center justify-between mb-3">
    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      Active Agents
    </span>
    <Users className="size-4 text-muted-foreground" />
  </div>
  <div className="text-3xl font-semibold tabular-nums">12</div>
  <div className="mt-1 text-xs text-muted-foreground">
    <span className="text-emerald-400">+3</span> from last hour
  </div>
</div>
```

### Table Layout Best Practices

- **Row height**: 40-44px -- compact but not cramped
- **Horizontal padding**: 12-16px per cell
- **No visible column dividers** -- use spacing and alignment instead
- **Subtle row hover**: 3-5% white overlay on hover
- **Row alternation**: Optional, very subtle (2% white overlay)
- **Sticky header**: Always visible when scrolling
- **Truncation**: Ellipsis with tooltip for long text, never wrap table text

---

## 8. Micro-Animations and Transitions

### Timing Constants

```css
:root {
  --duration-fast: 100ms;      /* instant feedback (button press) */
  --duration-normal: 200ms;    /* standard transitions */
  --duration-slow: 300ms;      /* panel open/close */
  --duration-enter: 200ms;     /* elements appearing */
  --duration-exit: 150ms;      /* elements disappearing (faster = snappier) */

  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);     /* general purpose */
  --ease-in: cubic-bezier(0.4, 0, 1, 1);             /* accelerate */
  --ease-out: cubic-bezier(0, 0, 0.2, 1);            /* decelerate */
  --ease-spring: cubic-bezier(0.175, 0.885, 0.32, 1.275); /* bouncy */
}
```

### Where to Animate (and Where NOT to)

**Do animate:**
- Sidebar collapse/expand (width transition, 200ms)
- Panel slide-in (transform translateX, 200ms ease-out)
- Tab content switch (opacity fade, 150ms)
- Hover states (background-color, 150ms)
- Status dot pulse (only for active states, 2s infinite)
- Toast/notification entrance (slide up + fade, 200ms)
- Skeleton loading pulse (1.5s infinite)
- Row hover highlight (background-color, 100ms)

**Do NOT animate:**
- Table data updates (just swap, no fade)
- Badge color changes (instant)
- Large layout shifts
- Anything during initial page load (except skeleton)
- Multiple animations simultaneously
- Anything that fires more than once per second

### Key Animation Patterns

**Fade in on mount:**
```css
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
.animate-in {
  animation: fade-in 200ms ease-out;
}
```

**Skeleton loading:**
```css
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton {
  background: linear-gradient(90deg,
    oklch(0.21 0 0) 25%,
    oklch(0.26 0 0) 50%,
    oklch(0.21 0 0) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
  border-radius: 4px;
}
```

**Sidebar collapse:**
```css
.sidebar {
  width: var(--sidebar-width);
  transition: width var(--duration-slow) var(--ease-default);
  overflow: hidden;
}
.sidebar[data-collapsed="true"] {
  width: var(--sidebar-width-icon);
}
```

### Accessibility: Respect prefers-reduced-motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 9. Reference Dashboards and Design Systems

### Linear

- **Color approach**: Near-monochrome (neutral blacks/whites) with very few bold accent colors. Migrated to LCH color space. Significantly reduced color usage compared to earlier versions.
- **Typography**: Inter Display for headings, regular Inter for body.
- **Sidebar**: Inverted L-shape. Tight alignment of labels, icons, buttons. Density-focused with reduced visual noise.
- **Layout**: Structured layouts with headers for filters, side panels for meta properties, multiple display types (list, board, timeline, split, fullscreen).
- **Design philosophy**: "Neutral and timeless appearance." Make text and icons darker in light mode, lighter in dark mode for improved contrast.

### Vercel (Geist Design System)

- **Color system**: 10 color scales using OKLCH/P3 with numeric steps (100-1000). Two background colors (Background-1 for page, Background-2 for differentiation).
- **Component colors**: Color-1 (default), Color-2 (hover), Color-3 (active).
- **Typography**: Geist Sans + Geist Mono.
- **Key principle**: Minimal color, maximum clarity. Black/white are the primary colors, with accent used very sparingly.
- **URL**: https://vercel.com/geist

### Cal.com

- **Design tokens** in CSS variables:
  - Dark mode: `--cal-bg: #101010`, `--cal-bg-emphasis: #2b2b2b`, `--cal-bg-subtle: #1c1c1c`, `--cal-bg-muted: #141414`
  - Light mode: `--cal-bg: white`, `--cal-bg-emphasis: #e5e7eb`, `--cal-bg-subtle: #f3f4f6`, `--cal-bg-muted: #f9fafb`
- **Approach**: Clean, functional, minimal decoration

### Raycast

- **Known for**: Extreme polish, smooth animations, keyboard-first UX
- **Color**: Muted backgrounds, vibrant icons, high contrast text
- **Design system**: Connected to Supernova.io for token management

### PatternFly (Red Hat)

- **Dashboard patterns**: Comprehensive documentation on card-based dashboard layouts
- **Status indicators**: Well-documented severity levels and aggregate status patterns
- **Layout**: Dashboard with cards for KPIs, lists for detail, consistent spacing

---

## 10. Concrete Recommendations for Agent Swarm

### Migration Path

The current UI uses MUI Joy + custom amber CSS variables. A migration to shadcn/ui + Tailwind v4 would be a significant rewrite. Here is what I recommend for either approach:

### If Staying with MUI Joy (Evolution)

1. **Replace the amber palette** with the cool neutral + indigo/teal accent proposed above
2. **Drop the honeycomb background pattern** -- decorative patterns fight against data-dense UIs
3. **Drop the glow effects** -- they scream "template", not "production tool"
4. **Switch to Inter** from Space Grotesk
5. **Simplify the StatusBadge** -- remove the "pulse-amber" animation from non-active states
6. **Add a proper sidebar** instead of tab-based navigation

### If Migrating to shadcn/ui + Tailwind v4 (Recommended)

1. **Use shadcn/ui default dark theme as the base** with OKLCH colors (listed in section 3)
2. **Customize the accent** to indigo or teal
3. **Use the shadcn Sidebar component** for navigation
4. **Use shadcn DataTable** (TanStack Table) instead of AG Grid for most tables, or theme AG Grid to match (section 4)
5. **Adopt the three-layer token hierarchy** for maintainability
6. **Inter + JetBrains Mono** font pairing
7. **Follow the animation timing** in section 8
8. **Use shadcn Badge** for status indicators with the semantic colors in section 6

### Top Priority Visual Changes

Regardless of framework choice:

1. **Kill the amber/honey/gold theme** -- replace with neutral darks + semantic accents
2. **Remove honeycomb SVG background** -- clean, flat surfaces
3. **Remove glow effects** on text and boxes
4. **Move from horizontal tabs to sidebar navigation** -- tabs don't scale with 9+ sections
5. **Adopt Inter** -- the dashboard standard for a reason
6. **Standardize status colors** to emerald/amber/red/gray/violet (not all amber variations)
7. **Reduce border opacity** -- current #3a2d1f borders are too visible; use 6-10% white overlay instead

### CSS Variables Migration

From current:
```css
:root {
  --hive-amber: #f5a623;
  --hive-honey: #ffb84d;
  --hive-gold: #d4a574;
  --hive-body: #0d0906;
  --hive-surface: #1a130e;
  --hive-border: #3a2d1f;
}
```

To proposed:
```css
.dark {
  --background: oklch(0.13 0.005 270);
  --foreground: oklch(0.985 0 0);
  --surface: oklch(0.175 0.005 270);
  --surface-elevated: oklch(0.21 0.006 270);
  --border: oklch(1 0 0 / 8%);
  --accent: oklch(0.62 0.19 264);
  --accent-muted: oklch(0.62 0.19 264 / 15%);
  --muted-foreground: oklch(0.55 0.01 270);
}
```

---

## Sources

### Design Systems and Official Documentation
- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming) - OKLCH variables, dark theme defaults
- [shadcn/ui Sidebar](https://ui.shadcn.com/docs/components/radix/sidebar) - Sidebar component architecture
- [Vercel Geist Design System](https://vercel.com/geist) - Color system, typography
- [Vercel Geist Colors](https://vercel.com/geist/colors) - 10 color scales
- [AG Grid Theming Colors](https://www.ag-grid.com/javascript-data-grid/theming-colors/) - Dark mode theming API
- [AG Grid Built-in Themes](https://www.ag-grid.com/javascript-data-grid/themes/) - Theme builder
- [Material Design Dark Theme](https://m2.material.io/design/color/dark-theme.html) - Elevation overlay system
- [Material Design 3 Color Roles](https://m3.material.io/styles/color/roles) - Semantic color system
- [Carbon Design System Status Indicators](https://carbondesignsystem.com/patterns/status-indicator-pattern/) - Status patterns
- [Tailwind CSS Colors](https://tailwindcss.com/docs/colors) - Color palette reference
- [Tailwind CSS Dark Mode](https://tailwindcss.com/docs/dark-mode) - v4 dark mode approach
- [Cal.com Instance Theming](https://cal.com/docs/enterprise-features/instance-wide-theming) - CSS variable tokens

### Design Articles and Guides
- [Linear UI Redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) - LCH migration, design philosophy
- [Design Tokens That Scale with Tailwind v4](https://www.maviklabs.com/blog/design-tokens-tailwind-v4-2026) - Three-layer token hierarchy
- [Scalable Accessible Dark Mode](https://www.fourzerothree.in/p/scalable-accessible-dark-mode) - Dark theme implementation
- [Dark Mode Design Best Practices 2026](https://www.tech-rz.com/blog/dark-mode-design-best-practices-in-2026/) - Layered darkness
- [Dashboard Design Principles 2025](https://www.uxpin.com/studio/blog/dashboard-design-principles/) - UX patterns
- [CSS/JS Animation Trends 2026](https://webpeak.org/blog/css-js-animation-trends/) - Micro-interactions
- [Best Fonts for Dense Dashboards](https://fontalternatives.com/blog/best-fonts-dense-dashboards/) - Typography
- [Sidebar Navigation Examples 2025](https://www.navbar.gallery/blog/best-side-bar-navigation-menu-design-examples) - Sidebar patterns

### Tools
- [OKLCH Color Picker](https://oklch.fyi/) - OKLCH converter and generator
- [OKLCH Palette Generator](https://oklch-palette.vercel.app/) - Palette generation
- [Data Viz Color Picker](https://www.learnui.design/tools/data-color-picker.html) - Chart palette generator
