# Agent-Swarm Brand — Video Source Reference

> Source of truth: `desplega-ai/agent-swarm-landing` (agent-swarm.dev)
> Inventoried: 2026-05-21 by Jackknife

---

## Logo & Mark

### Primary Logo
- **File**: `public/brand/logo.png`
- **Usage**: `<Img src={staticFile("brand/logo.png")} />`  — 28×28px in navbar; scale up for cards
- **Treatment**: Rounded-md corners, amber glow shadow (`0 4px 14px -2px oklch(0.769 0.188 70.08 / 0.35)`)
- **No SVG version exists** — PNG only from the landing repo

### Desplega Isotipo
- **File**: `public/brand/desplega-iso.svg`
- **Color**: `#1600ea` electric blue (fill)
- **Usage**: Watermark / co-brand corner mark only — NOT the primary agent-swarm logo

### Wordmark
- `<span>Agent Swarm</span>` in Space Grotesk Semibold (600), tracking -0.04em (hero headlines), -0.03em (section h2)
- White on dark backgrounds; zinc-950 on light backgrounds

---

## Color Tokens

Extracted from `src/app/globals.css` `@theme` block and verified against `tailwind.config.ts`:

| Token | CSS var | Tailwind class | Hex | Notes |
|-------|---------|----------------|-----|-------|
| Background (light) | `--color-background` | `bg-background` | `#ffffff` | Page default |
| Foreground | `--color-foreground` | `text-foreground` | `#09090b` | zinc-950 |
| Primary (amber) | `--color-primary` | `text-primary` | `#b45309` | amber-700 |
| Border | `--color-border` | `border-border` | `#e4e4e7` | zinc-200 |
| Hero bg | — | `bg-zinc-950` | `#09090b` | Hero section |

### Amber Scale (brand primary)
| Shade | Hex |
|-------|-----|
| amber-400 | `#fbbf24` |
| amber-500 | `#f59e0b` |
| amber-700 | `#b45309` ← **brand primary** |

### Zinc Neutral Scale
| Shade | Hex |
|-------|-----|
| zinc-50  | `#fafafa` |
| zinc-100 | `#f4f4f5` |
| zinc-200 | `#e4e4e7` |
| zinc-400 | `#a1a1aa` |
| zinc-500 | `#71717a` |
| zinc-700 | `#3f3f46` |
| zinc-800 | `#27272a` |
| zinc-900 | `#18181b` |
| zinc-950 | `#09090b` |

---

## Typography

Source: `src/app/layout.tsx` Google Fonts link + `globals.css`

| Role | Family | Weights | CSS var |
|------|--------|---------|---------|
| Display / body | **Space Grotesk** | 300, 400, 500, 600, 700 | `--font-sans` |
| Mono / eyebrows | **Space Mono** | 400, 700, italic | `--font-mono` |

### Remotion loading
```ts
import { loadFont as loadSpaceGrotesk } from "@remotion/google-fonts/SpaceGrotesk";
import { loadFont as loadSpaceMono } from "@remotion/google-fonts/SpaceMono";
```

### Heading sizes (from components)
- Hero h1: `clamp(48px, 7vw, 104px)`, font-semibold, tracking -0.04em, leading-[0.96]
- Section h2 (Pillars): 40-56px, font-semibold, tracking -0.03em, leading-[1.0]
- Card h3 (Pricing): 22px, font-semibold, tracking -0.015em, leading-[1.15]
- Price number: 44px, font-bold, tracking -0.03em
- Video intro wordmark: 64px — Video outro wordmark: 76px

---

## Visual Language

### Slash-prefixed Eyebrow
The most distinctive pattern. Every section heading is preceded by a slash label:
```
/ why agent swarm
```
- Font: Space Mono (`font-mono`)
- Size: 11px (`text-[11px]`)
- Tracking: `tracking-[0.14em]`
- Transform: `uppercase`
- Color: `text-amber-700` (`#b45309`)
- Margin below: `mb-4`

### Gradient Text
Used for italic hero accent phrases (`*tailored for AI*`):
```css
background: linear-gradient(135deg, oklch(0.555 0.163 48.998), oklch(0.769 0.188 70.08), oklch(0.555 0.163 48.998));
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
```
Hex equivalent: `linear-gradient(135deg, #b45309, #f59e0b, #b45309)`

### Cards (Pillars section)
- `bg-white p-7 rounded-xl border border-zinc-100`
- Hover: `hover:bg-amber-50/40` (subtle amber tint)
- No drop shadow by default

### CTA Button (primary)
- `bg-amber-500 hover:bg-amber-400 text-zinc-950 font-semibold rounded-xl h-11`
- Box shadow: `0 14px 40px -8px oklch(0.769 0.188 70.08 / 0.55)` (amber glow)

### CTA Button (secondary / ghost)
- `bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.12] text-white font-semibold rounded-xl h-11`

### Hero Section Structure
```
bg-zinc-950 text-white                       ← dark wrapper
  / eyebrow label                            ← amber-700 mono slash prefix
  H1: Space Grotesk 600, large, white        ← main heading
    with italic gradient-text span           ← amber gradient accent
  Subtext: zinc-400, smaller                 ← supporting copy
  CTA row: amber-500 button + outline button
```

---

## Remotion `theme.ts` Summary

```ts
{
  bg: "#09090b",            // zinc-950 — hero/dark section bg
  accent: "#b45309",        // amber-700 — primary brand color
  accentMid: "#f59e0b",     // amber-500
  accentLight: "#fbbf24",   // amber-400
  gradientText: "linear-gradient(135deg, #b45309, #f59e0b, #b45309)",
  sans: "'Space Grotesk', ...",
  mono: "'Space Mono', ...",
}
```

---

## Dos and Don'ts

| ✅ Do | ❌ Don't |
|-------|---------|
| Use amber-700 (`#b45309`) as accent | Use lime-green (`#EBFF94`) — that's the Desplega.ai marketing brand |
| Space Grotesk for display/body | Geist or Inter for display |
| Space Mono for slash eyebrows | Geist Mono for eyebrows |
| `/ label` eyebrow in amber-700 | Plain text section labels |
| Gradient-text for italic hero phrase | Solid amber for italic accents |
| logo.png (the orange "AS" square icon) | logo-iso.svg (that was from the wrong landing repo) |
