/**
 * The theme fields of a page write, checked the same way for the HTTP create
 * and update routes (src/http/pages.ts) and the `create_page` tool.
 *
 * This module imports only `src/themes/*` and types, and it registers no
 * OpenAPI component, so its place in the module load order cannot reorder the
 * generated openapi.json.
 */

import type { Page, PageThemeTokensInput } from "../types";
import { importThemeTokens, ThemeImportError, type ThemeImportInput } from "./import";
import { isThemePresetId, THEME_PRESET_IDS } from "./presets";

/**
 * Checks the theme fields. `theme` must name a preset. `themeTokens` goes
 * through the importer, so what gets stored is the normalized token form,
 * whatever format the caller sent. For both fields, undefined keeps the stored
 * value and null clears it.
 */
export function readThemeFields(input: {
  theme?: string | null;
  themeTokens?: PageThemeTokensInput | null;
}):
  | { error: string }
  | { theme?: string | null; themeTokens?: Page["themeTokens"]; ignored: string[] } {
  if (typeof input.theme === "string" && !isThemePresetId(input.theme)) {
    return { error: `Unknown theme "${input.theme}". Use one of: ${THEME_PRESET_IDS.join(", ")}` };
  }
  if (!input.themeTokens) {
    return { theme: input.theme, themeTokens: input.themeTokens, ignored: [] };
  }
  try {
    // The importer checks which fields go with the chosen format.
    const { tokens, ignored } = importThemeTokens(input.themeTokens as ThemeImportInput);
    return { theme: input.theme, themeTokens: tokens, ignored };
  } catch (err) {
    if (err instanceof ThemeImportError) return { error: `Invalid themeTokens: ${err.message}` };
    throw err;
  }
}
