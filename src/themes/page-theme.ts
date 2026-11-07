/**
 * Theme resolution and CSS for HTML pages (design version 2).
 *
 * Resolution picks one preset, then applies the page's own overrides:
 * - Preset: the page `theme` when it names a known preset, else the viewer
 *   theme (the dashboard's `__swarm-theme` param) when it names a known
 *   preset, else `hive`. Direct links pass no viewer theme, so they get Hive.
 * - Tokens: the Hive values, then the preset's contract keys, then the page
 *   `themeTokens` overrides. A shared token (font, radius) that the overrides
 *   set only in `light` applies to dark too.
 *
 * The CSS carries both modes. `.dark` on `<html>` picks dark, and print is
 * always light.
 */

import { DEFAULT_THEME_ID, getThemePreset } from "./presets";
import {
  HIVE_PAGE_TOKENS,
  PAGE_THEME_SHARED_TOKENS,
  PAGE_THEME_TOKENS,
  type PageThemeToken,
  type PageThemeTokens,
  type PageThemeTokenValues,
} from "./tokens";

export type ResolvedPageTheme = {
  presetId: string;
  light: Record<PageThemeToken, string>;
  dark: Record<PageThemeToken, string>;
};

/**
 * The design version 1 names, kept as aliases so page CSS written against
 * them follows the theme. They are `var()` references declared on `:root`
 * only, so they pick up the dark values when `.dark` is on `<html>`.
 */
const SWARM_ALIASES = [
  ["--swarm-bg", "--color-background"],
  ["--swarm-card", "--color-card"],
  ["--swarm-border", "--color-border"],
  ["--swarm-text", "--color-foreground"],
  ["--swarm-muted", "--color-muted-foreground"],
  ["--swarm-primary", "--color-primary"],
] as const;

/** The contract keys of a preset's vars or of a page override map. Other keys drop out. */
function contractValues(
  vars: Readonly<Record<string, string | undefined>> | undefined,
): PageThemeTokenValues {
  const values: PageThemeTokenValues = {};
  if (!vars) return values;
  for (const token of PAGE_THEME_TOKENS) {
    const value = vars[token];
    if (value !== undefined) values[token] = value;
  }
  return values;
}

export function resolvePageTheme({
  pageTheme,
  viewerTheme,
  overrides,
}: {
  pageTheme?: string | null;
  viewerTheme?: string | null;
  overrides?: PageThemeTokens | null;
}): ResolvedPageTheme {
  const preset =
    getThemePreset(pageTheme) ?? getThemePreset(viewerTheme) ?? getThemePreset(DEFAULT_THEME_ID);
  const lightOverrides = contractValues(overrides?.light);
  const darkOverrides = contractValues(overrides?.dark);
  const light = {
    ...HIVE_PAGE_TOKENS.light,
    ...contractValues(preset?.vars.light),
    ...lightOverrides,
  };
  const dark = { ...HIVE_PAGE_TOKENS.dark, ...contractValues(preset?.vars.dark), ...darkOverrides };
  for (const token of PAGE_THEME_SHARED_TOKENS) {
    const value = lightOverrides[token];
    if (value !== undefined && darkOverrides[token] === undefined) dark[token] = value;
  }
  return { presetId: preset?.id ?? DEFAULT_THEME_ID, light, dark };
}

function declarationLines(values: Record<PageThemeToken, string>, indent: string): string {
  return PAGE_THEME_TOKENS.map((token) => `${indent}${token}: ${values[token]};`).join("\n");
}

/**
 * Unlayered CSS for a resolved theme: light tokens and the `--swarm-*`
 * aliases on `:root`, dark tokens on `:root.dark`, and a print block that
 * puts the light tokens back. Unlayered rules beat Tailwind's layered theme
 * defaults, so utilities such as `bg-primary` read these values.
 */
export function renderPageThemeCss(theme: ResolvedPageTheme): string {
  const aliases = SWARM_ALIASES.map(([alias, token]) => `  ${alias}: var(${token});`).join("\n");
  return [
    `:root {\n  color-scheme: light;\n${declarationLines(theme.light, "  ")}\n${aliases}\n}`,
    `:root.dark {\n  color-scheme: dark;\n${declarationLines(theme.dark, "  ")}\n}`,
    `@media print {\n  :root.dark {\n    color-scheme: light;\n${declarationLines(theme.light, "    ")}\n  }\n}`,
  ].join("\n\n");
}
