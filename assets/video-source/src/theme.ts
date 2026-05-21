// Agent Swarm brand tokens — source: assets/video-source/BRAND.md (from agent-swarm-landing).
// Amber-700 primary · zinc neutral scale · Space Grotesk + Space Mono.
// Slash-prefixed eyebrows: Space Mono 11px tracking-[0.14em] uppercase amber-700.
export const theme = {
  // Hero background (zinc-950) — dark scene background matching landing hero
  bg: "#09090b",
  // Light card background — used for card interiors in light sections
  cardLight: "#ffffff",
  card: "rgba(255,255,255,0.08)",
  fg: "#ffffff",
  // Zinc neutral scale
  zinc50: "#fafafa",
  zinc100: "#f4f4f5",
  zinc200: "#e4e4e7",
  zinc400: "#a1a1aa",
  zinc500: "#71717a",
  zinc700: "#3f3f46",
  zinc800: "#27272a",
  zinc900: "#18181b",
  zinc950: "#09090b",
  muted: "rgba(255,255,255,0.65)",
  mutedDim: "rgba(255,255,255,0.30)",
  border: "#e4e4e7",            // zinc-200
  borderDark: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",

  // Brand accent — amber-700 (Tailwind #b45309)
  accent: "#b45309",            // amber-700
  accentMid: "#f59e0b",         // amber-500
  accentLight: "#fbbf24",       // amber-400
  accentFg: "#ffffff",
  accentDim: "rgba(180,83,9,0.12)",

  // Gradient-text — matches .gradient-text in globals.css
  gradientText: "linear-gradient(135deg, #b45309, #f59e0b, #b45309)",

  // Semantic
  success: "#4ade80",
  danger: "#f87171",

  // Typography — Space Grotesk (display) + Space Mono (eyebrows/code)
  sans: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  mono: "'Space Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};
