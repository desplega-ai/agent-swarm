/**
 * Dashboard side of the theme presets.
 *
 * The preset catalog and the CSS builder are pure and shared with the API
 * server (HTML pages use the same presets), so they live in
 * `src/themes/presets.ts` at the repo root. Read that file for the preset
 * rules and the selector shape. This module re-exports them, so dashboard
 * code keeps importing from `@/lib/themes`, and it adds the one DOM step:
 * the `<head>` injection.
 */

import { buildThemePresetCss } from "../../../../src/themes/presets";

export type { ThemePreset } from "../../../../src/themes/presets";
export {
  BASE_SCOPE_VARS,
  buildThemePresetCss,
  DEFAULT_THEME_ID,
  getThemePreset,
  isThemePresetId,
  resolveThemeId,
  THEME_PRESET_IDS,
  THEME_PRESETS,
} from "../../../../src/themes/presets";

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
