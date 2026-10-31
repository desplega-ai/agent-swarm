import { type Page, PageThemeTokensSchema } from "../../types";

/** Stored `theme_tokens` JSON, or null when the column is empty, is not JSON, or has the wrong shape. */
export function parsePageThemeTokens(raw: string | null): Page["themeTokens"] {
  if (!raw) return null;
  try {
    const parsed = PageThemeTokensSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
