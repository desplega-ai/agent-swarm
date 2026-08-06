/**
 * Theme presets — the parametric layer on top of the token system.
 *
 * Every color in the dashboard resolves through the CSS custom properties
 * declared in `styles/globals.css` (`--color-primary`, `--color-background`,
 * ...). A preset is nothing but a curated bundle of overrides for a SUBSET of
 * those properties, emitted as `[data-theme="<id>"]` rules — so a theme can be
 * applied at ANY scope: on `<html>` (the whole dashboard, via the Appearance
 * settings) or on a wrapper element (one swarm-app's canvas, via
 * `definition.theme` / the viewer's `$theme` override).
 *
 * Deliberate constraints:
 * - `hive` (the Mission Control identity from DESIGN.md) is the base: its
 *   values ARE the globals.css defaults. An app inherits the dashboard theme
 *   by carrying NO `data-theme` attribute; `data-theme="hive"` is an explicit
 *   reset back to the stock look (meaningful inside a themed dashboard).
 * - Every emitted preset block is SELF-CONTAINED: the builder spreads the
 *   stock base values (`BASE_SCOPE_VARS`) under each preset's own overrides,
 *   so a scoped preset fully resets the canvas instead of blending with
 *   whatever full-field preset the surrounding dashboard runs (an accent
 *   preset under an Ember dashboard must deliver its promised zinc field,
 *   and a classic dashboard's status palette must not leak into an app).
 * - Action (`--color-action-*`) and destructive tokens are NEVER themed.
 *   Status (`--color-status-*`) is themed ONLY by the classic-theme presets
 *   (theme-classics.ts) whose identity includes a status palette; hue
 *   SEMANTICS stay fixed everywhere (success=green, error=red, …) so a failed
 *   task chip reads as "failed" under every preset.
 * - Light and dark values are both declared per preset; the global `.dark`
 *   class keeps choosing the mode, so scoped themes follow the mode switch
 *   for free.
 *
 * Selector shape (specificity matters):
 * - light: `html[data-theme="x"], [data-theme="x"]` — the `html`-qualified
 *   form (0,1,1) outranks the base `.dark` block (0,1,0) by column, so rule
 *   order against the compiled stylesheet is irrelevant; the bare attribute
 *   form covers scoped wrappers.
 * - dark: `html.dark[data-theme="x"], .dark [data-theme="x"]` — (0,2,1)/(0,2,0)
 *   outranks every light form above.
 * This only works because `globals.css` scopes dark overrides to `.dark`
 * itself (inheritance), NOT `.dark *` (per-element stamping) — do not
 * reintroduce the descendant form there.
 */

import { CLASSIC_THEME_PRESETS } from "./theme-classics";

/**
 * Stock (Hive) values for every custom property that ANY preset overrides —
 * copied from the `@theme` / `.dark` blocks in `styles/globals.css` (keep in
 * sync when a base token there changes). Spread under each preset's own
 * overrides at emit time so every `[data-theme]` block is self-contained:
 * tokens a preset doesn't override reset to stock instead of inheriting the
 * surrounding dashboard preset. Tokens NO preset touches (destructive,
 * action-*, chart-2…5) are deliberately absent — inheriting those is always
 * inheriting the base.
 */
const BASE_SCOPE_VARS: { light: Record<string, string>; dark: Record<string, string> } = {
  light: {
    "--color-background": "oklch(1 0 0)",
    "--color-foreground": "oklch(0.141 0.005 285.823)",
    "--color-card": "oklch(1 0 0)",
    "--color-card-foreground": "oklch(0.141 0.005 285.823)",
    "--color-surface": "oklch(0.985 0.0015 286)",
    "--color-popover": "oklch(1 0 0)",
    "--color-popover-foreground": "oklch(0.141 0.005 285.823)",
    "--color-primary": "oklch(0.555 0.163 48.998)",
    "--color-primary-foreground": "oklch(0.985 0 0)",
    "--color-secondary": "oklch(0.967 0.001 286.375)",
    "--color-secondary-foreground": "oklch(0.21 0.006 285.885)",
    "--color-muted": "oklch(0.967 0.001 286.375)",
    "--color-muted-foreground": "oklch(0.552 0.016 285.938)",
    "--color-accent": "oklch(0.943 0.003 286.375)",
    "--color-accent-foreground": "oklch(0.21 0.006 285.885)",
    "--color-border": "oklch(0.92 0.004 286.32)",
    "--color-border-subtle": "oklch(0.945 0.003 286)",
    "--color-input": "oklch(0.92 0.004 286.32)",
    "--color-ring": "oklch(0.555 0.163 48.998)",
    "--color-chart-1": "oklch(0.646 0.222 41.116)",
    "--color-sidebar": "oklch(0.985 0 0)",
    "--color-sidebar-foreground": "oklch(0.141 0.005 285.823)",
    "--color-sidebar-primary": "oklch(0.555 0.163 48.998)",
    "--color-sidebar-primary-foreground": "oklch(0.985 0 0)",
    "--color-sidebar-accent": "oklch(0.943 0.003 286.375)",
    "--color-sidebar-accent-foreground": "oklch(0.21 0.006 285.885)",
    "--color-sidebar-border": "oklch(0.945 0.003 286)",
    "--color-sidebar-ring": "oklch(0.555 0.163 48.998)",
    "--color-status-success": "oklch(0.74 0.1 163)",
    "--color-status-success-strong": "oklch(0.5 0.09 163)",
    "--color-status-success-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-active": "oklch(0.81 0.11 75)",
    "--color-status-active-strong": "oklch(0.55 0.1 68)",
    "--color-status-active-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-error": "oklch(0.72 0.12 25)",
    "--color-status-error-strong": "oklch(0.51 0.14 25)",
    "--color-status-error-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-info": "oklch(0.74 0.09 235)",
    "--color-status-info-strong": "oklch(0.5 0.09 240)",
    "--color-status-info-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-pending": "oklch(0.84 0.1 95)",
    "--color-status-pending-strong": "oklch(0.55 0.09 90)",
    "--color-status-pending-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-warning": "oklch(0.76 0.11 55)",
    "--color-status-warning-strong": "oklch(0.53 0.11 50)",
    "--color-status-warning-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-paused": "oklch(0.71 0.1 262)",
    "--color-status-paused-strong": "oklch(0.5 0.1 262)",
    "--color-status-paused-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-neutral": "oklch(0.62 0.014 286)",
    "--color-status-neutral-strong": "oklch(0.48 0.014 286)",
    "--color-status-neutral-foreground": "oklch(0.21 0.006 285.885)",
  },
  dark: {
    "--color-background": "oklch(0.141 0.005 285.823)",
    "--color-foreground": "oklch(0.985 0 0)",
    "--color-card": "oklch(0.21 0.006 285.885)",
    "--color-card-foreground": "oklch(0.985 0 0)",
    "--color-surface": "oklch(0.185 0.006 286)",
    "--color-popover": "oklch(0.21 0.006 285.885)",
    "--color-popover-foreground": "oklch(0.985 0 0)",
    "--color-primary": "oklch(0.769 0.188 70.08)",
    "--color-primary-foreground": "oklch(0.21 0.006 285.885)",
    "--color-secondary": "oklch(0.274 0.006 286.033)",
    "--color-secondary-foreground": "oklch(0.985 0 0)",
    "--color-muted": "oklch(0.274 0.006 286.033)",
    "--color-muted-foreground": "oklch(0.705 0.015 286.067)",
    "--color-accent": "oklch(0.274 0.006 286.033)",
    "--color-accent-foreground": "oklch(0.985 0 0)",
    "--color-border": "oklch(1 0 0 / 10%)",
    "--color-border-subtle": "oklch(1 0 0 / 8%)",
    "--color-input": "oklch(1 0 0 / 15%)",
    "--color-ring": "oklch(0.769 0.188 70.08)",
    "--color-chart-1": "oklch(0.488 0.243 264.376)",
    "--color-sidebar": "oklch(0.21 0.006 285.885)",
    "--color-sidebar-foreground": "oklch(0.985 0 0)",
    "--color-sidebar-primary": "oklch(0.769 0.188 70.08)",
    "--color-sidebar-primary-foreground": "oklch(0.985 0 0)",
    "--color-sidebar-accent": "oklch(0.274 0.006 286.033)",
    "--color-sidebar-accent-foreground": "oklch(0.985 0 0)",
    "--color-sidebar-border": "oklch(1 0 0 / 8%)",
    "--color-sidebar-ring": "oklch(0.769 0.188 70.08)",
    "--color-status-success": "oklch(0.78 0.1 163)",
    "--color-status-success-strong": "oklch(0.78 0.1 163)",
    "--color-status-success-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-active": "oklch(0.84 0.1 80)",
    "--color-status-active-strong": "oklch(0.84 0.1 80)",
    "--color-status-active-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-error": "oklch(0.74 0.11 22)",
    "--color-status-error-strong": "oklch(0.74 0.11 22)",
    "--color-status-error-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-info": "oklch(0.78 0.09 235)",
    "--color-status-info-strong": "oklch(0.78 0.09 235)",
    "--color-status-info-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-pending": "oklch(0.86 0.09 95)",
    "--color-status-pending-strong": "oklch(0.86 0.09 95)",
    "--color-status-pending-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-warning": "oklch(0.79 0.1 55)",
    "--color-status-warning-strong": "oklch(0.79 0.1 55)",
    "--color-status-warning-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-paused": "oklch(0.74 0.09 260)",
    "--color-status-paused-strong": "oklch(0.74 0.09 260)",
    "--color-status-paused-foreground": "oklch(0.21 0.006 285.885)",
    "--color-status-neutral": "oklch(0.72 0.012 286)",
    "--color-status-neutral-strong": "oklch(0.72 0.012 286)",
    "--color-status-neutral-foreground": "oklch(0.21 0.006 285.885)",
  },
};

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  /** Representative accent per mode — picker swatches only, never rendering. */
  accent: { light: string; dark: string };
  /** Representative field (background) per mode — picker swatches only. */
  field: { light: string; dark: string };
  /**
   * CSS custom-property overrides, keyed by full var name.
   *
   * INVARIANT: every key set in `light` must also be set in `dark`. The light
   * rule is not mode-guarded — it matches in dark mode too and only loses to
   * the higher-specificity dark rule — so a key missing from `dark` leaks its
   * LIGHT value into dark mode. (Dark-only keys are fine: in light mode the
   * base token simply applies.)
   */
  vars: { light: Record<string, string>; dark: Record<string, string> };
}

export const DEFAULT_THEME_ID = "hive";

/**
 * Accent-swap preset: keeps the zinc field and replaces the one voice of
 * color (primary / ring / sidebar accent / lead chart series).
 */
function accentPreset(
  id: string,
  name: string,
  description: string,
  light: { primary: string; primaryForeground: string },
  dark: { primary: string; primaryForeground: string },
): ThemePreset {
  return {
    id,
    name,
    description,
    accent: { light: light.primary, dark: dark.primary },
    field: { light: "oklch(1 0 0)", dark: "oklch(0.141 0.005 285.823)" },
    vars: {
      light: {
        "--color-primary": light.primary,
        "--color-primary-foreground": light.primaryForeground,
        "--color-ring": light.primary,
        "--color-sidebar-primary": light.primary,
        "--color-sidebar-primary-foreground": light.primaryForeground,
        "--color-sidebar-ring": light.primary,
        "--color-chart-1": light.primary,
      },
      dark: {
        "--color-primary": dark.primary,
        "--color-primary-foreground": dark.primaryForeground,
        "--color-ring": dark.primary,
        "--color-sidebar-primary": dark.primary,
        "--color-sidebar-primary-foreground": dark.primaryForeground,
        "--color-sidebar-ring": dark.primary,
        "--color-chart-1": dark.primary,
      },
    },
  };
}

const NEAR_WHITE = "oklch(0.985 0 0)";
const ZINC_900 = "oklch(0.21 0.006 285.885)";

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: DEFAULT_THEME_ID,
    name: "Hive",
    description: "The stock Mission Control look: zinc field, one amber voice.",
    accent: { light: "oklch(0.555 0.163 48.998)", dark: "oklch(0.769 0.188 70.08)" },
    field: { light: "oklch(1 0 0)", dark: "oklch(0.141 0.005 285.823)" },
    // The base theme IS globals.css — no overrides of its own. The builder
    // still emits a `[data-theme="hive"]` block (the BASE_SCOPE_VARS spread)
    // so an explicit Hive selection resets a canvas inside a themed
    // dashboard; "inherit the surrounding theme" is the ABSENCE of the
    // attribute, not this preset.
    vars: { light: {}, dark: {} },
  },
  accentPreset(
    "meadow",
    "Meadow",
    "Zinc field with an emerald voice.",
    { primary: "oklch(0.596 0.145 163.225)", primaryForeground: NEAR_WHITE },
    { primary: "oklch(0.765 0.177 163.223)", primaryForeground: ZINC_900 },
  ),
  accentPreset(
    "iris",
    "Iris",
    "Zinc field with a violet voice.",
    { primary: "oklch(0.541 0.281 293.009)", primaryForeground: NEAR_WHITE },
    { primary: "oklch(0.702 0.183 293.541)", primaryForeground: ZINC_900 },
  ),
  accentPreset(
    "rose",
    "Rose",
    "Zinc field with a deep rose voice.",
    { primary: "oklch(0.586 0.253 17.585)", primaryForeground: NEAR_WHITE },
    { primary: "oklch(0.712 0.194 13.428)", primaryForeground: ZINC_900 },
  ),
  {
    id: "cobalt",
    name: "Cobalt",
    description: "Cool slate field with a saturated blue voice.",
    accent: { light: "oklch(0.546 0.245 262.881)", dark: "oklch(0.707 0.165 254.624)" },
    field: { light: "oklch(1 0 0)", dark: "oklch(0.129 0.042 264.695)" },
    vars: {
      light: {
        "--color-foreground": "oklch(0.129 0.042 264.695)",
        "--color-card-foreground": "oklch(0.129 0.042 264.695)",
        "--color-popover-foreground": "oklch(0.129 0.042 264.695)",
        "--color-surface": "oklch(0.984 0.003 247.858)",
        "--color-primary": "oklch(0.546 0.245 262.881)",
        "--color-primary-foreground": NEAR_WHITE,
        "--color-secondary": "oklch(0.968 0.007 247.896)",
        "--color-secondary-foreground": "oklch(0.208 0.042 265.755)",
        "--color-muted": "oklch(0.968 0.007 247.896)",
        "--color-muted-foreground": "oklch(0.554 0.046 257.417)",
        // Hover/highlight fill one step below muted (slate-100 → ~slate-150)
        // so light-mode hovers read — same rationale as the base accent.
        "--color-accent": "oklch(0.945 0.01 251.7)",
        "--color-accent-foreground": "oklch(0.208 0.042 265.755)",
        "--color-border": "oklch(0.929 0.013 255.508)",
        "--color-border-subtle": "oklch(0.948 0.01 252)",
        "--color-input": "oklch(0.929 0.013 255.508)",
        "--color-ring": "oklch(0.546 0.245 262.881)",
        "--color-chart-1": "oklch(0.546 0.245 262.881)",
        "--color-sidebar": "oklch(0.984 0.003 247.858)",
        "--color-sidebar-foreground": "oklch(0.129 0.042 264.695)",
        "--color-sidebar-primary": "oklch(0.546 0.245 262.881)",
        "--color-sidebar-primary-foreground": NEAR_WHITE,
        "--color-sidebar-accent": "oklch(0.945 0.01 251.7)",
        "--color-sidebar-accent-foreground": "oklch(0.208 0.042 265.755)",
        "--color-sidebar-border": "oklch(0.948 0.01 252)",
        "--color-sidebar-ring": "oklch(0.546 0.245 262.881)",
      },
      dark: {
        "--color-background": "oklch(0.129 0.042 264.695)",
        "--color-foreground": NEAR_WHITE,
        "--color-card": "oklch(0.208 0.042 265.755)",
        "--color-card-foreground": NEAR_WHITE,
        "--color-surface": "oklch(0.17 0.042 265)",
        "--color-popover": "oklch(0.208 0.042 265.755)",
        "--color-popover-foreground": NEAR_WHITE,
        "--color-primary": "oklch(0.707 0.165 254.624)",
        "--color-primary-foreground": "oklch(0.129 0.042 264.695)",
        "--color-secondary": "oklch(0.279 0.041 260.031)",
        "--color-secondary-foreground": NEAR_WHITE,
        "--color-muted": "oklch(0.279 0.041 260.031)",
        "--color-muted-foreground": "oklch(0.704 0.04 256.788)",
        "--color-accent": "oklch(0.279 0.041 260.031)",
        "--color-accent-foreground": NEAR_WHITE,
        "--color-border": "oklch(1 0 0 / 10%)",
        "--color-border-subtle": "oklch(1 0 0 / 8%)",
        "--color-input": "oklch(1 0 0 / 15%)",
        "--color-ring": "oklch(0.707 0.165 254.624)",
        "--color-chart-1": "oklch(0.707 0.165 254.624)",
        "--color-sidebar": "oklch(0.208 0.042 265.755)",
        "--color-sidebar-foreground": NEAR_WHITE,
        "--color-sidebar-primary": "oklch(0.707 0.165 254.624)",
        "--color-sidebar-primary-foreground": NEAR_WHITE,
        "--color-sidebar-accent": "oklch(0.279 0.041 260.031)",
        "--color-sidebar-accent-foreground": NEAR_WHITE,
        "--color-sidebar-border": "oklch(1 0 0 / 8%)",
        "--color-sidebar-ring": "oklch(0.707 0.165 254.624)",
      },
    },
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm stone field with a burnt orange voice.",
    accent: { light: "oklch(0.646 0.222 41.116)", dark: "oklch(0.75 0.183 55.934)" },
    field: { light: "oklch(0.985 0.001 106.423)", dark: "oklch(0.147 0.004 49.25)" },
    vars: {
      light: {
        "--color-background": "oklch(0.985 0.001 106.423)",
        "--color-foreground": "oklch(0.147 0.004 49.25)",
        "--color-card": "oklch(1 0 0)",
        "--color-card-foreground": "oklch(0.147 0.004 49.25)",
        "--color-surface": "oklch(0.97 0.001 106.424)",
        "--color-popover": "oklch(1 0 0)",
        "--color-popover-foreground": "oklch(0.147 0.004 49.25)",
        "--color-primary": "oklch(0.646 0.222 41.116)",
        "--color-primary-foreground": NEAR_WHITE,
        "--color-secondary": "oklch(0.97 0.001 106.424)",
        "--color-secondary-foreground": "oklch(0.216 0.006 56.043)",
        "--color-muted": "oklch(0.97 0.001 106.424)",
        "--color-muted-foreground": "oklch(0.553 0.013 58.071)",
        // Hover/highlight fill one step below muted (stone-100 → ~stone-150);
        // the sidebar-accent below was already at stone-200 and stays.
        "--color-accent": "oklch(0.946 0.002 48.7)",
        "--color-accent-foreground": "oklch(0.216 0.006 56.043)",
        "--color-border": "oklch(0.923 0.003 48.717)",
        "--color-border-subtle": "oklch(0.947 0.002 48.717)",
        "--color-input": "oklch(0.923 0.003 48.717)",
        "--color-ring": "oklch(0.646 0.222 41.116)",
        "--color-chart-1": "oklch(0.646 0.222 41.116)",
        "--color-sidebar": "oklch(0.97 0.001 106.424)",
        "--color-sidebar-foreground": "oklch(0.147 0.004 49.25)",
        "--color-sidebar-primary": "oklch(0.646 0.222 41.116)",
        "--color-sidebar-primary-foreground": NEAR_WHITE,
        "--color-sidebar-accent": "oklch(0.923 0.003 48.717)",
        "--color-sidebar-accent-foreground": "oklch(0.216 0.006 56.043)",
        "--color-sidebar-border": "oklch(0.947 0.002 48.717)",
        "--color-sidebar-ring": "oklch(0.646 0.222 41.116)",
      },
      dark: {
        "--color-background": "oklch(0.147 0.004 49.25)",
        "--color-foreground": NEAR_WHITE,
        "--color-card": "oklch(0.216 0.006 56.043)",
        "--color-card-foreground": NEAR_WHITE,
        "--color-surface": "oklch(0.185 0.005 49)",
        "--color-popover": "oklch(0.216 0.006 56.043)",
        "--color-popover-foreground": NEAR_WHITE,
        "--color-primary": "oklch(0.75 0.183 55.934)",
        "--color-primary-foreground": "oklch(0.147 0.004 49.25)",
        "--color-secondary": "oklch(0.268 0.007 34.298)",
        "--color-secondary-foreground": NEAR_WHITE,
        "--color-muted": "oklch(0.268 0.007 34.298)",
        "--color-muted-foreground": "oklch(0.709 0.01 56.259)",
        "--color-accent": "oklch(0.268 0.007 34.298)",
        "--color-accent-foreground": NEAR_WHITE,
        "--color-border": "oklch(1 0 0 / 10%)",
        "--color-border-subtle": "oklch(1 0 0 / 8%)",
        "--color-input": "oklch(1 0 0 / 15%)",
        "--color-ring": "oklch(0.75 0.183 55.934)",
        "--color-chart-1": "oklch(0.75 0.183 55.934)",
        "--color-sidebar": "oklch(0.216 0.006 56.043)",
        "--color-sidebar-foreground": NEAR_WHITE,
        "--color-sidebar-primary": "oklch(0.75 0.183 55.934)",
        "--color-sidebar-primary-foreground": NEAR_WHITE,
        "--color-sidebar-accent": "oklch(0.268 0.007 34.298)",
        "--color-sidebar-accent-foreground": NEAR_WHITE,
        "--color-sidebar-border": "oklch(1 0 0 / 8%)",
        "--color-sidebar-ring": "oklch(0.75 0.183 55.934)",
      },
    },
  },
  {
    id: "carbon",
    name: "Carbon",
    description: "Pure monochrome. The interface recedes, the data speaks.",
    accent: { light: ZINC_900, dark: NEAR_WHITE },
    field: { light: "oklch(1 0 0)", dark: "oklch(0.141 0.005 285.823)" },
    vars: {
      light: {
        "--color-primary": ZINC_900,
        "--color-primary-foreground": NEAR_WHITE,
        "--color-ring": "oklch(0.552 0.016 285.938)",
        "--color-sidebar-primary": ZINC_900,
        "--color-sidebar-primary-foreground": NEAR_WHITE,
        "--color-sidebar-ring": "oklch(0.552 0.016 285.938)",
      },
      dark: {
        "--color-primary": NEAR_WHITE,
        "--color-primary-foreground": ZINC_900,
        "--color-ring": "oklch(0.705 0.015 286.067)",
        "--color-sidebar-primary": NEAR_WHITE,
        "--color-sidebar-primary-foreground": ZINC_900,
        "--color-sidebar-ring": "oklch(0.705 0.015 286.067)",
      },
    },
  },
  // Classic editor/platform themes — the only presets that override
  // `--color-status-*` (their identity includes a status palette; hue
  // semantics stay fixed). See theme-classics.ts.
  ...CLASSIC_THEME_PRESETS,
];

const PRESETS_BY_ID = new Map(THEME_PRESETS.map((preset) => [preset.id, preset]));

export function getThemePreset(id: string | null | undefined): ThemePreset | null {
  if (!id) return null;
  return PRESETS_BY_ID.get(id) ?? null;
}

/**
 * DASHBOARD-ROOT normalization of an untrusted stored id: a known preset id,
 * or null for unknown ids AND for `hive` (at the `<html>` level the base
 * needs no attribute — there is nothing outer to reset from). Scoped app
 * canvases must NOT use this: there `hive` is a meaningful explicit reset —
 * see the resolution in `app-surface.tsx`.
 */
export function resolveThemeId(id: string | null | undefined): string | null {
  const preset = getThemePreset(id);
  return preset && preset.id !== DEFAULT_THEME_ID ? preset.id : null;
}

function declarations(vars: Record<string, string>, indent: string): string {
  return Object.entries(vars)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join("\n");
}

export function buildThemePresetCss(): string {
  const blocks: string[] = [];
  for (const preset of THEME_PRESETS) {
    // Self-contained blocks: base values under the preset's own overrides,
    // so a scoped canvas resets fully instead of blending with the outer
    // dashboard preset. `hive` emits the bare base — the explicit reset.
    const light = { ...BASE_SCOPE_VARS.light, ...preset.vars.light };
    const dark = { ...BASE_SCOPE_VARS.dark, ...preset.vars.dark };
    blocks.push(
      `html[data-theme="${preset.id}"],\n[data-theme="${preset.id}"] {\n${declarations(light, "  ")}\n}`,
      `html.dark[data-theme="${preset.id}"],\n.dark [data-theme="${preset.id}"] {\n${declarations(dark, "  ")}\n}`,
    );
  }
  return blocks.join("\n\n");
}

const STYLE_ELEMENT_ID = "swarm-theme-presets";

/** Idempotently appends the preset rules to `<head>` (refreshed on HMR). */
export function injectThemePresetStyles(): void {
  if (typeof document === "undefined") return;
  const css = buildThemePresetCss();
  const existing = document.getElementById(STYLE_ELEMENT_ID);
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
