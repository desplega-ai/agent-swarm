/**
 * The org design system: one brand record per swarm deployment, stored in KV
 * (`design-system` / `org`). It restyles every designVersion 2 page that sets
 * no `theme` (see `resolvePageTheme`). `design-system-set` is the only writer;
 * the namespace is reserved, so a raw `kv-set` cannot skip these checks.
 *
 * Writes and reads run the same checks: tokens go through the theme importer,
 * URLs are https (fonts pinned to Google Fonts, which the page CSP allows),
 * and the base preset must exist. A stored record that fails them reads as
 * invalid and pages ignore it.
 */

import { type DesignSystem, type DesignSystemInput, DesignSystemSchema } from "../types";
import { importThemeTokens, ThemeImportError } from "./import";
import { DEFAULT_THEME_ID, isThemePresetId, THEME_PRESET_IDS } from "./presets";

export const DESIGN_SYSTEM_NAMESPACE = "design-system";
export const DESIGN_SYSTEM_KEY = "org";
/** The value `design-system-set` replaced, kept for a one-step undo. */
export const DESIGN_SYSTEM_PREVIOUS_KEY = "org.prev";
// shortcut: single undo step, upgrade to versions if a second rollback is needed.

export type DesignSystemActor = { userId: string | null; agentId?: string };

const FONTS_HOST = "fonts.googleapis.com";
/** Quotes and angle brackets would break out of the `href` attribute even after escaping mistakes. */
const UNSAFE_URL_CHARACTERS = /["'<>\s\\]/;

export class DesignSystemError extends Error {
  override name = "DesignSystemError";
}

function readHttpsUrl(value: string, label: string, host?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DesignSystemError(`${label} must be an absolute https URL`);
  }
  if (url.protocol !== "https:" || UNSAFE_URL_CHARACTERS.test(value)) {
    throw new DesignSystemError(`${label} must be an absolute https URL`);
  }
  if (host && url.hostname !== host) {
    throw new DesignSystemError(`${label} must be on https://${host}`);
  }
  return url.href;
}

function readColor(value: string, index: number): string {
  try {
    // The importer's value check is the token contract's check, so reuse it.
    const { tokens } = importThemeTokens({ light: { "--color-chart-1": value } });
    const color = tokens.light["--color-chart-1"];
    if (color === undefined) throw new ThemeImportError("not a color value");
    return color;
  } catch (err) {
    if (err instanceof ThemeImportError) {
      throw new DesignSystemError(`chartPalette[${index}]: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Checks and normalizes a design system write. Throws `DesignSystemError`
 * with a message that names the bad field. `ignored` lists the token names
 * the importer could not place.
 */
export function buildDesignSystem(
  input: DesignSystemInput,
  actor: DesignSystemActor,
  now: Date = new Date(),
): { record: DesignSystem; ignored: string[] } {
  const stamp = {
    source: input.source ?? { kind: "manual" as const },
    updatedBy: actor.userId,
    ...(actor.agentId ? { updatedByAgentId: actor.agentId } : {}),
    updatedAt: now.toISOString(),
  };
  if (input.status === "declined") {
    return {
      record: {
        v: 1,
        status: "declined",
        basePreset: DEFAULT_THEME_ID,
        tokens: { light: {}, dark: {} },
        mode: "viewer",
        ...stamp,
      },
      ignored: [],
    };
  }
  const basePreset = input.basePreset ?? DEFAULT_THEME_ID;
  if (!isThemePresetId(basePreset)) {
    throw new DesignSystemError(
      `Unknown basePreset "${basePreset}". Use one of: ${THEME_PRESET_IDS.join(", ")}`,
    );
  }
  let imported: ReturnType<typeof importThemeTokens> = {
    tokens: { light: {}, dark: {} },
    ignored: [],
  };
  if (input.themeTokens) {
    try {
      imported = importThemeTokens(input.themeTokens as Parameters<typeof importThemeTokens>[0]);
    } catch (err) {
      if (err instanceof ThemeImportError) {
        throw new DesignSystemError(`Invalid themeTokens: ${err.message}`);
      }
      throw err;
    }
  }
  const record: DesignSystem = {
    v: 1,
    status: "active",
    basePreset,
    tokens: imported.tokens,
    ...(input.fontsHref
      ? { fontsHref: readHttpsUrl(input.fontsHref, "fontsHref", FONTS_HOST) }
      : {}),
    ...(input.logo
      ? { logo: { url: readHttpsUrl(input.logo.url, "logo.url"), alt: input.logo.alt } }
      : {}),
    mode: input.mode ?? "viewer",
    ...(input.chartPalette ? { chartPalette: input.chartPalette.map(readColor) } : {}),
    ...stamp,
  };
  return { record, ignored: imported.ignored };
}

/**
 * Revalidates a stored value. Returns null for a missing value and
 * `{ invalid }` for one that no longer passes the write checks (a hand-edited
 * row, or a preset that was removed), so pages fall back instead of rendering
 * it.
 */
export function readDesignSystem(
  value: unknown,
): { record: DesignSystem } | { invalid: string } | null {
  if (value === undefined || value === null) return null;
  const result = DesignSystemSchema.safeParse(value);
  if (!result.success) return { invalid: "stored design system is not a valid v1 record" };
  const parsed = result.data;
  try {
    const { record } = buildDesignSystem(
      {
        status: parsed.status,
        basePreset: parsed.basePreset,
        themeTokens: parsed.tokens,
        fontsHref: parsed.fontsHref,
        logo: parsed.logo,
        mode: parsed.mode,
        chartPalette: parsed.chartPalette,
        source: parsed.source,
      },
      { userId: parsed.updatedBy, agentId: parsed.updatedByAgentId },
    );
    return { record: { ...record, updatedAt: parsed.updatedAt } };
  } catch (err) {
    if (err instanceof DesignSystemError) return { invalid: err.message };
    throw err;
  }
}
