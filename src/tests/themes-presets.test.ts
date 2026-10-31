import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BASE_SCOPE_VARS,
  buildThemePresetCss,
  DEFAULT_THEME_ID,
  getThemePreset,
  isThemePresetId,
  resolveThemeId,
  THEME_PRESET_IDS,
  THEME_PRESETS,
} from "../themes/presets";
import {
  HIVE_PAGE_TOKENS,
  PAGE_THEME_COLOR_TOKENS,
  PAGE_THEME_SHARED_TOKENS,
  PAGE_THEME_TOKENS,
} from "../themes/tokens";

const GLOBALS_CSS = join(import.meta.dir, "../../apps/ui/src/styles/globals.css");

/** Custom properties of one top-level block of globals.css (the theme blocks hold no nested braces). */
function readCssBlock(css: string, opener: string): Record<string, string> {
  const start = css.indexOf(opener);
  if (start === -1) throw new Error(`globals.css has no ${opener} block`);
  const end = css.indexOf("\n}", start);
  const body = css.slice(start + opener.length, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const values: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    values[match[1] ?? ""] = (match[2] ?? "").trim();
  }
  return values;
}

async function readGlobals(): Promise<{
  light: Record<string, string>;
  dark: Record<string, string>;
}> {
  const css = await Bun.file(GLOBALS_CSS).text();
  return { light: readCssBlock(css, "\n@theme {"), dark: readCssBlock(css, "\n.dark {") };
}

describe("theme presets", () => {
  test("every preset keeps the light/dark INVARIANT: each light key is also set in dark", () => {
    for (const preset of THEME_PRESETS) {
      const dark = new Set(Object.keys(preset.vars.dark));
      const leaks = Object.keys(preset.vars.light).filter((key) => !dark.has(key));
      expect({ id: preset.id, leaks }).toEqual({ id: preset.id, leaks: [] });
    }
  });

  test("every preset value and swatch is an oklch() color", () => {
    for (const preset of THEME_PRESETS) {
      const values = [
        ...Object.values(preset.vars.light),
        ...Object.values(preset.vars.dark),
        preset.accent.light,
        preset.accent.dark,
        preset.field.light,
        preset.field.dark,
      ];
      const others = values.filter((value) => !/^oklch\([^()]+\)$/.test(value));
      expect({ id: preset.id, others }).toEqual({ id: preset.id, others: [] });
    }
  });

  test("paper sits after carbon and before the classics, full-field, without status tokens", () => {
    const ids = THEME_PRESETS.map((preset) => preset.id);
    expect(ids.indexOf("paper")).toBe(ids.indexOf("carbon") + 1);
    expect(ids[ids.indexOf("paper") + 1]).toBe("github");

    const paper = getThemePreset("paper");
    expect(paper?.name).toBe("Paper");
    const lightKeys = Object.keys(paper?.vars.light ?? {}).sort();
    expect(Object.keys(paper?.vars.dark ?? {}).sort()).toEqual(lightKeys);
    expect(lightKeys).toContain("--color-background");
    expect(lightKeys).toContain("--color-card");
    expect(lightKeys.filter((key) => key.startsWith("--color-status-"))).toEqual([]);
    expect(paper?.accent.light).toBe(paper?.vars.light["--color-primary"]);
    expect(paper?.accent.dark).toBe(paper?.vars.dark["--color-primary"]);
    expect(paper?.field.light).toBe(paper?.vars.light["--color-background"]);
    expect(paper?.field.dark).toBe(paper?.vars.dark["--color-background"]);
  });

  test("the id list and the id check match the catalog", () => {
    expect(THEME_PRESET_IDS).toEqual(THEME_PRESETS.map((preset) => preset.id));
    expect(new Set(THEME_PRESET_IDS).size).toBe(THEME_PRESET_IDS.length);
    expect(THEME_PRESET_IDS[0]).toBe(DEFAULT_THEME_ID);
    for (const id of THEME_PRESET_IDS) expect(isThemePresetId(id)).toBe(true);
    expect(isThemePresetId("not-a-preset")).toBe(false);
    expect(isThemePresetId("")).toBe(false);
  });

  test("lookups keep their dashboard behavior", () => {
    expect(getThemePreset("github")?.id).toBe("github");
    expect(getThemePreset("nope")).toBeNull();
    expect(getThemePreset(null)).toBeNull();
    expect(resolveThemeId("paper")).toBe("paper");
    expect(resolveThemeId(DEFAULT_THEME_ID)).toBeNull();
    expect(resolveThemeId("nope")).toBeNull();
    expect(resolveThemeId(undefined)).toBeNull();
  });

  test("buildThemePresetCss emits a self-contained light and dark block per preset", () => {
    const css = buildThemePresetCss();
    const baseNames = Object.keys(BASE_SCOPE_VARS.light);
    const blocks = css.split("\n\n");
    expect(blocks).toHaveLength(THEME_PRESETS.length * 2);
    for (const preset of THEME_PRESETS) {
      const light =
        blocks.find((block) => block.startsWith(`html[data-theme="${preset.id}"],`)) ?? "";
      const dark =
        blocks.find((block) => block.startsWith(`html.dark[data-theme="${preset.id}"],`)) ?? "";
      expect(light).toContain(`\n[data-theme="${preset.id}"] {`);
      expect(dark).toContain(`\n.dark [data-theme="${preset.id}"] {`);
      const missing = baseNames.filter(
        (name) => !light.includes(`  ${name}: `) || !dark.includes(`  ${name}: `),
      );
      expect({ id: preset.id, missing }).toEqual({ id: preset.id, missing: [] });
    }
    expect(css).toContain('html[data-theme="paper"]');
    expect(css).toContain("--color-background: oklch(0.973 0.004 91.446);");
  });
});

describe("token contract", () => {
  test("has 52 color tokens and 6 shared tokens, without duplicates or dashboard-only names", () => {
    expect(PAGE_THEME_COLOR_TOKENS).toHaveLength(52);
    expect(PAGE_THEME_SHARED_TOKENS).toHaveLength(6);
    expect(PAGE_THEME_TOKENS).toHaveLength(58);
    expect(new Set(PAGE_THEME_TOKENS).size).toBe(58);
    const dashboardOnly = PAGE_THEME_TOKENS.filter((token) =>
      /^--(color-(sidebar|action|peer)|text-|ease-)/.test(token),
    );
    expect(dashboardOnly).toEqual([]);
  });
});

describe("sync guard against apps/ui/src/styles/globals.css", () => {
  test("BASE_SCOPE_VARS equals the globals.css values", async () => {
    const globals = await readGlobals();
    expect(Object.keys(BASE_SCOPE_VARS.light).sort()).toEqual(
      Object.keys(BASE_SCOPE_VARS.dark).sort(),
    );
    for (const [name, value] of Object.entries(BASE_SCOPE_VARS.light)) {
      expect({ name, value }).toEqual({ name, value: globals.light[name] ?? "<missing>" });
    }
    for (const [name, value] of Object.entries(BASE_SCOPE_VARS.dark)) {
      expect({ name, value }).toEqual({ name, value: globals.dark[name] ?? "<missing>" });
    }
  });

  test("HIVE_PAGE_TOKENS equals the globals.css values, shared tokens from the light block", async () => {
    const globals = await readGlobals();
    for (const token of PAGE_THEME_TOKENS) {
      expect({ token, value: HIVE_PAGE_TOKENS.light[token] }).toEqual({
        token,
        value: globals.light[token] ?? "<missing>",
      });
    }
    for (const token of PAGE_THEME_COLOR_TOKENS) {
      expect({ token, value: HIVE_PAGE_TOKENS.dark[token] }).toEqual({
        token,
        value: globals.dark[token] ?? "<missing>",
      });
    }
    for (const token of PAGE_THEME_SHARED_TOKENS) {
      expect(globals.dark[token]).toBeUndefined();
      expect(HIVE_PAGE_TOKENS.dark[token]).toBe(globals.light[token] ?? "<missing>");
    }
  });
});
