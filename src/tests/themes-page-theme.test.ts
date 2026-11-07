import { describe, expect, test } from "bun:test";
import { renderPageThemeCss, resolvePageTheme } from "../themes/page-theme";
import { getThemePreset } from "../themes/presets";
import { HIVE_PAGE_TOKENS, PAGE_THEME_TOKENS } from "../themes/tokens";

const github = getThemePreset("github");
const paper = getThemePreset("paper");

/** The body of the first block that starts with `selector {`. */
function blockBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {\n`);
  if (start === -1) return "";
  return css.slice(start, css.indexOf("\n}", start));
}

describe("resolvePageTheme", () => {
  test("with no page theme and no viewer theme it is Hive", () => {
    const theme = resolvePageTheme({});
    expect(theme.presetId).toBe("hive");
    expect(theme.light).toEqual(HIVE_PAGE_TOKENS.light);
    expect(theme.dark).toEqual(HIVE_PAGE_TOKENS.dark);
    expect(resolvePageTheme({ pageTheme: null, viewerTheme: null, overrides: null })).toEqual(
      theme,
    );
  });

  test("a known viewer theme applies when the page has no theme", () => {
    const theme = resolvePageTheme({ pageTheme: null, viewerTheme: "github" });
    expect(theme.presetId).toBe("github");
    expect(theme.light["--color-primary"]).toBe(github?.vars.light["--color-primary"] ?? "");
    expect(theme.dark["--color-background"]).toBe(github?.vars.dark["--color-background"] ?? "");
    expect(theme.light["--color-status-error"]).toBe(
      github?.vars.light["--color-status-error"] ?? "",
    );
    // Tokens the preset leaves alone keep the Hive value.
    expect(theme.light["--color-destructive"]).toBe(HIVE_PAGE_TOKENS.light["--color-destructive"]);
    expect(theme.light["--font-sans"]).toBe(HIVE_PAGE_TOKENS.light["--font-sans"]);
  });

  test("only contract keys come from the preset", () => {
    const theme = resolvePageTheme({ viewerTheme: "github" });
    expect(Object.keys(theme.light).sort()).toEqual([...PAGE_THEME_TOKENS].sort());
    expect(Object.keys(theme.dark).sort()).toEqual([...PAGE_THEME_TOKENS].sort());
    expect(Object.keys(theme.light)).not.toContain("--color-sidebar");
  });

  test("the page theme wins over the viewer theme", () => {
    const theme = resolvePageTheme({ pageTheme: "paper", viewerTheme: "github" });
    expect(theme.presetId).toBe("paper");
    expect(theme.light["--color-background"]).toBe(paper?.vars.light["--color-background"] ?? "");
    expect(theme.dark["--color-primary"]).toBe(paper?.vars.dark["--color-primary"] ?? "");
  });

  test("an explicit hive page theme ignores the viewer theme", () => {
    const theme = resolvePageTheme({ pageTheme: "hive", viewerTheme: "github" });
    expect(theme.presetId).toBe("hive");
    expect(theme.light).toEqual(HIVE_PAGE_TOKENS.light);
  });

  test("an unknown viewer theme falls back to Hive", () => {
    const theme = resolvePageTheme({ viewerTheme: "not-a-preset" });
    expect(theme.presetId).toBe("hive");
    expect(theme.light).toEqual(HIVE_PAGE_TOKENS.light);
  });

  test("an unknown page theme is treated as no page theme", () => {
    expect(resolvePageTheme({ pageTheme: "gone", viewerTheme: "github" }).presetId).toBe("github");
    expect(resolvePageTheme({ pageTheme: "gone" }).presetId).toBe("hive");
  });

  test("overrides apply on top of the preset, per mode", () => {
    const theme = resolvePageTheme({
      pageTheme: "paper",
      overrides: {
        light: { "--color-primary": "oklch(0.5 0.2 30)" },
        dark: { "--color-primary": "oklch(0.7 0.15 30)" },
      },
    });
    expect(theme.light["--color-primary"]).toBe("oklch(0.5 0.2 30)");
    expect(theme.dark["--color-primary"]).toBe("oklch(0.7 0.15 30)");
    expect(theme.light["--color-background"]).toBe(paper?.vars.light["--color-background"] ?? "");
  });

  test("a color override set only in light does not reach dark", () => {
    const theme = resolvePageTheme({
      overrides: { light: { "--color-primary": "oklch(0.5 0.2 30)" }, dark: {} },
    });
    expect(theme.light["--color-primary"]).toBe("oklch(0.5 0.2 30)");
    expect(theme.dark["--color-primary"]).toBe(HIVE_PAGE_TOKENS.dark["--color-primary"]);
  });

  test("a shared override set only in light reaches dark, and a dark one wins in dark", () => {
    const theme = resolvePageTheme({
      overrides: {
        light: { "--font-sans": "Inter, sans-serif", "--radius-lg": "1rem" },
        dark: { "--radius-lg": "0.25rem" },
      },
    });
    expect(theme.light["--font-sans"]).toBe("Inter, sans-serif");
    expect(theme.dark["--font-sans"]).toBe("Inter, sans-serif");
    expect(theme.light["--radius-lg"]).toBe("1rem");
    expect(theme.dark["--radius-lg"]).toBe("0.25rem");
  });

  test("override keys outside the contract drop out", () => {
    const theme = resolvePageTheme({
      overrides: { light: { "--color-sidebar": "red", "--color-card": "white" }, dark: {} },
    });
    expect(Object.keys(theme.light)).not.toContain("--color-sidebar");
    expect(theme.light["--color-card"]).toBe("white");
  });
});

describe("renderPageThemeCss", () => {
  const theme = resolvePageTheme({
    pageTheme: "paper",
    overrides: { light: { "--color-primary": "oklch(0.5 0.2 30)" }, dark: {} },
  });
  const css = renderPageThemeCss(theme);

  test("has the light root, the dark root and the print block, unlayered", () => {
    expect(css).toContain(":root {\n  color-scheme: light;");
    expect(css).toContain(":root.dark {\n  color-scheme: dark;");
    expect(css).toContain("@media print {\n  :root.dark {\n    color-scheme: light;");
    expect(css).not.toContain("@layer");
    expect(css.indexOf(":root {")).toBeLessThan(css.indexOf(":root.dark {"));
    expect(css.indexOf(":root.dark {")).toBeLessThan(css.indexOf("@media print"));
  });

  test("declares every contract token in each block", () => {
    const light = blockBody(css, ":root");
    const dark = blockBody(css, ":root.dark");
    const print = css.slice(css.indexOf("@media print"));
    for (const token of PAGE_THEME_TOKENS) {
      expect(light).toContain(`  ${token}: ${theme.light[token]};`);
      expect(dark).toContain(`  ${token}: ${theme.dark[token]};`);
      expect(print).toContain(`    ${token}: ${theme.light[token]};`);
    }
    expect(light).toContain("--color-primary: oklch(0.5 0.2 30);");
  });

  test("puts the --swarm-* aliases in :root only", () => {
    const aliases = [
      "--swarm-bg: var(--color-background);",
      "--swarm-card: var(--color-card);",
      "--swarm-border: var(--color-border);",
      "--swarm-text: var(--color-foreground);",
      "--swarm-muted: var(--color-muted-foreground);",
      "--swarm-primary: var(--color-primary);",
    ];
    const light = blockBody(css, ":root");
    for (const alias of aliases) expect(light).toContain(alias);
    expect(css.slice(css.indexOf(":root.dark {"))).not.toContain("--swarm-");
  });
});
