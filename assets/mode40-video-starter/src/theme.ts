// mode40 brand tokens for Remotion video.
//
// Source of truth: the mode40 Canon brand skills (canon-brand-color,
// canon-typography-rules). Values are copied verbatim from Canon — do NOT
// substitute, approximate, or invent new hues. If you need a shade that is not
// here, tint navy or cyan toward white using the ramp below.
//
// Cyan is a SIGNAL, not a surface: marks, eyebrows, numbers, links, single
// rules. Navy is the ONLY approved dark background (never pure black). Text on
// navy is always white, with cyan reserved for the eyebrow/label line.

export const color = {
  // Core
  cyan: "#00D4DE", // primary accent / signal — eyebrows, marks, links, numbers
  navy: "#001D25", // the only dark surface
  ink: "#1A1A1A", // headings / strong text on light
  body: "#262626", // default body text on light
  grey: "#8A8A8A", // captions, metadata, secondary text
  white: "#FFFFFF", // page background; text on navy

  // Surface fills (the only approved light fills)
  zebra: "#F0F0F0",
  scopeBox: "#E6F8FB", // pale-cyan info box
  hairline: "#E2E2E2", // light dividers on white

  // Semantic aliases
  accent: "#00D4DE",
  heading: "#1A1A1A",
  muted: "#8A8A8A",
  divider: "#E2E2E2",
  onDark: "#FFFFFF",
} as const;

// Approved tints — navy/cyan toward white. Never invent new hues.
export const tint = {
  navy80: "#33484F",
  navy60: "#667579",
  navy40: "#99A4A7",
  navy20: "#CCD2D3",
  cyan60: "#66E5EB",
  cyan30: "#B3F2F5",
} as const;

// Typography — IBM Plex Sans (titles + body), IBM Plex Mono (eyebrows only).
// Loaded at module level in src/fonts.ts via @remotion/google-fonts.
//   Title   : IBM Plex Sans, Light (300), slightly tighter kerning.
//   Body    : IBM Plex Sans, Regular (400), default tracking.
//   Eyebrow : IBM Plex Mono, SemiBold (600), ALL CAPS, looser kerning, cyan.
export const font = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  weight: { light: 300, regular: 400, medium: 500, semibold: 600 },
  // Kerning as a fraction of font size (multiply by fontSize at the call site).
  tracking: { title: -0.015, body: 0, eyebrow: 0.08 },
} as const;

// Motion tokens — keep entrances calm and consistent across compositions.
export const motion = {
  // Canonical entrance ease (easeOutExpo-like). Feed to Remotion's
  // Easing.bezier(...easing) or a CSS cubic-bezier().
  easing: [0.16, 1, 0.3, 1] as const,
  // Per-element delay for staggered entrances, in frames (~130ms @ 30fps).
  stagger: 4,
  // Standard entrance travel distance in px (slide-up).
  rise: 24,
  // Soft navy elevation shadow for cards/callouts on light or dark.
  shadow: "0 24px 60px rgba(0, 29, 37, 0.28)",
  shadowSoft: "0 8px 24px rgba(0, 29, 37, 0.18)",
} as const;

export const theme = { color, tint, font, motion } as const;
