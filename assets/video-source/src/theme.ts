// Mirrors the new-ui + landing tokens: shadcn Zinc (dark) + amber primary.
// Colors converted from oklch() at render time via CSS-compatible hex/rgba.
// Source of truth: new-ui/src/styles/globals.css, landing/src/app/globals.css
export const theme = {
  // Background / foreground
  bg: "#09090b",              // oklch(0.141 0.005 285.823)
  card: "#18181b",            // oklch(0.21 0.006 285.885) — card/muted
  fg: "#fafafa",              // oklch(0.985 0 0)
  muted: "#a1a1aa",           // oklch(0.705 0.015 286.067) — zinc-400
  mutedDim: "#52525b",        // zinc-600
  border: "rgba(255,255,255,0.10)",
  borderStrong: "rgba(255,255,255,0.18)",

  // Brand accent — amber (matches landing/new-ui primary in dark mode)
  accent: "#f2a93b",          // oklch(0.769 0.188 70.08)
  accentDim: "#7a4d12",
  accentFg: "#1a1409",        // oklch(0.205 0.022 47.604)

  // Semantic
  success: "#4ade80",
  danger: "#f87171",

  // Typography (loaded via @remotion/google-fonts)
  sans: "'Space Grotesk', system-ui, -apple-system, sans-serif",
  mono: "'Space Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};
