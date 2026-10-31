/**
 * Design version 2 head (`src/pages/page-head.ts`) and its serving through
 * `/p/:id`:
 *   - `buildPageHeadV2` emits its parts in the required order: the layer
 *     statement is the first style, the Tailwind source comes before the
 *     pinned script, and the dark class script only in dark mode
 *   - the theme CSS carries every contract token, the aliases and print
 *   - the design CSS has every primitive and no color literal
 *   - serving resolves the theme: page `theme`, else `__swarm-theme`, else
 *     Hive, plus `themeTokens`; `__swarm-mode=dark` and print stay light
 *   - serving keeps a v2 page in standards mode: a doctype first, then the
 *     head after `<head>`, `<html>` or the doctype
 *   - a page with `COLOR_LITERAL_THRESHOLD` or more hardcoded colors stays
 *     light in dark mode
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, initDb } from "../be/db";
import { handlePages } from "../http/pages";
import { handlePagesPublic } from "../http/pages-public";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { COLOR_LITERAL_THRESHOLD } from "../pages/color-literals";
import {
  buildPageHeadV2,
  PAGE_HEAD_V1,
  PAGE_MODE_PARAM,
  PAGE_THEME_PARAM,
} from "../pages/page-head";
import { resolvePageTheme } from "../themes/page-theme";
import { getThemePreset } from "../themes/presets";
import { HIVE_PAGE_TOKENS, PAGE_THEME_TOKENS } from "../themes/tokens";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-pages-head-v2.sqlite";

const TAILWIND_SCRIPT =
  '<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js" integrity="sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB" crossorigin="anonymous"></script>';
const DARK_SCRIPT = '<script>document.documentElement.classList.add("dark")</script>';
const LAYER_STATEMENT = "<style>@layer properties, theme, base, components, utilities;</style>";

const PRIMITIVES = [
  ".swarm-page",
  ".swarm-eyebrow",
  ".swarm-lede",
  ".swarm-section",
  ".swarm-metrics",
  ".swarm-metric",
  ".swarm-metric-value",
  ".swarm-metric-label",
  ".swarm-panel",
  ".swarm-card",
  ".swarm-badge",
  ".swarm-badge[data-dot]",
  ".swarm-table-wrap",
  ".swarm-table",
  ".num",
  ".nowrap",
  ".swarm-button",
  '[data-variant="primary"]',
  '[data-variant="ghost"]',
  ".swarm-input",
  ".swarm-toolbar",
  ".swarm-segmented",
  '[aria-pressed="true"]',
  "[data-active]",
  ".swarm-callout",
  ".swarm-kv",
];

const BADGE_TONES = [
  "neutral",
  "primary",
  "success",
  "warning",
  "error",
  "info",
  "pending",
  "paused",
  "active",
];

/** The text of a `<style id="...">` element. */
function styleText(html: string, id: string): string {
  const match = new RegExp(`<style id="${id}">\\n([\\s\\S]*?)\\n</style>`).exec(html);
  if (!match) throw new Error(`no <style id="${id}">`);
  return match[1]!;
}

/** The body of the first rule whose text is `<selector> {`, up to its closing brace. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} rule`);
  const open = start + selector.length + 2;
  return css.slice(open, css.indexOf("}", open));
}

/** Declarations of the top-level rule whose line is exactly `<selector> {`. */
function declarations(css: string, selector: string): Record<string, string> {
  const lines = css.split("\n");
  const start = lines.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} rule`);
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line === "}") break;
    const match = /^\s*([\w-]+):\s*(.+);$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

const hiveHead = buildPageHeadV2({ theme: resolvePageTheme({}), mode: "light" });
const designCss = styleText(hiveHead, "swarm-design");
const baseLayer = designCss.slice(0, designCss.indexOf("\n@layer components {"));
const componentsLayer = designCss.slice(
  designCss.indexOf("\n@layer components {"),
  designCss.indexOf("\n@media print {"),
);

describe("buildPageHeadV2", () => {
  test("emits the parts in order, with the layer statement as the first style", () => {
    expect(hiveHead.startsWith('<base target="_blank">\n')).toBe(true);
    const firstStyle = hiveHead.indexOf("<style");
    expect(hiveHead.slice(firstStyle).startsWith(LAYER_STATEMENT)).toBe(true);
    const order = [
      '<base target="_blank">',
      LAYER_STATEMENT,
      "https://fonts.googleapis.com/css2?family=Space+Grotesk",
      '<style id="swarm-theme">',
      '<style id="swarm-design">',
      'style.type = "text/tailwindcss";',
      TAILWIND_SCRIPT,
    ].map((part) => hiveHead.indexOf(part));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(hiveHead).not.toContain("cdn.tailwindcss.com");
    expect(hiveHead).not.toContain(DARK_SCRIPT);
  });

  test("no @import sits in the markup, where the preload scanner would fetch it", () => {
    // The scanner reads `@import` in every `<style>`, whatever its type, and
    // requested /p/tailwindcss/theme and /p/tailwindcss/utilities (401).
    const styles = [...hiveHead.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    expect(styles.length).toBeGreaterThan(0);
    for (const css of styles) expect(css).not.toContain("@import");
  });

  test("adds the dark class script only in dark mode, after the Tailwind script", () => {
    const dark = buildPageHeadV2({ theme: resolvePageTheme({}), mode: "dark" });
    expect(dark.endsWith(`${TAILWIND_SCRIPT}\n${DARK_SCRIPT}`)).toBe(true);
  });

  test("the Tailwind source imports theme and utilities only and maps every token", () => {
    const json = /style\.textContent = (".*");\n/.exec(hiveHead)?.[1];
    expect(json).toBeDefined();
    // `<` is escaped, so the source cannot close its script.
    expect(json).not.toContain("<");
    const source = JSON.parse(json!) as string;
    const lines = source.split("\n");
    expect(lines.slice(0, 4)).toEqual([
      '@import "tailwindcss/theme" layer(theme);',
      '@import "tailwindcss/utilities" layer(utilities);',
      "@custom-variant dark (&:where(.dark, .dark *));",
      "@theme inline reference {",
    ]);
    for (const token of PAGE_THEME_TOKENS) {
      expect(lines).toContain(`  ${token}: var(${token});`);
    }
    // A bare `@import "tailwindcss"` would bring Preflight back.
    expect(source).not.toContain('@import "tailwindcss";');
  });

  test("the theme CSS has every contract token in both modes, the aliases and print", () => {
    const css = styleText(hiveHead, "swarm-theme");
    const light = declarations(css, ":root");
    const dark = declarations(css, ":root.dark");
    expect(light["color-scheme"]).toBe("light");
    expect(dark["color-scheme"]).toBe("dark");
    for (const token of PAGE_THEME_TOKENS) {
      expect(light[token]).toBe(HIVE_PAGE_TOKENS.light[token]);
      expect(dark[token]).toBe(HIVE_PAGE_TOKENS.dark[token]);
    }
    expect(light["--swarm-bg"]).toBe("var(--color-background)");
    expect(light["--swarm-primary"]).toBe("var(--color-primary)");
    expect(css).toContain("@media print {\n  :root.dark {\n    color-scheme: light;");
  });

  test("the design CSS layers every primitive and holds no color literal", () => {
    const css = styleText(hiveHead, "swarm-design");
    expect(css.startsWith("@layer base {")).toBe(true);
    expect(css).toContain("\n@layer components {");
    for (const primitive of PRIMITIVES) expect(css).toContain(primitive);
    for (const tone of BADGE_TONES) expect(css).toContain(`[data-tone="${tone}"]`);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
    const print = css.slice(css.indexOf("@media print {"));
    expect(print).toContain(".no-print { display: none !important; }");
    expect(print).toContain(
      ".swarm-panel, .swarm-card, swarm-diff, .swarm-metric { break-inside: avoid; }",
    );
    expect(print).toContain(
      "html, body { background: white !important; color: black !important; }",
    );
  });

  test("the control font reset has zero specificity and comes before the control looks", () => {
    // A plain `button` selector (0,0,1) would beat the later `:where()` looks.
    const reset = baseLayer.indexOf(
      ":where(button, input, optgroup, select, textarea), ::file-selector-button {",
    );
    expect(reset).toBeGreaterThan(-1);
    expect(baseLayer).not.toContain("  button, input, optgroup");
    expect(reset).toBeLessThan(baseLayer.indexOf(":where(input:not("));
    expect(reset).toBeLessThan(baseLayer.indexOf(':where(button, input[type="button"]'));
  });

  test("the base layer pads the body 16px at 640px and below", () => {
    expect(baseLayer).toContain("@media (max-width: 640px) {\n    body { padding: 16px; }\n  }");
  });

  test("the components layer resets diff tables, colors badge dots and grows toolbar inputs", () => {
    expect(componentsLayer).toContain(
      ".swarm-diff-root :is(table, th, td) { margin: 0; border: 0; }",
    );
    expect(componentsLayer).toMatch(
      /\.swarm-badge\[data-dot\]::before \{[^}]*background: var\(--swarm-dot, currentColor\);/,
    );
    expect(componentsLayer).toMatch(/\.swarm-badge \{[^}]*gap: 6px;/);
    expect(componentsLayer).toContain("input:not([type])) { flex: 1 1 260px; }");
  });

  test("the in-page link script follows <base> and keeps # links in the page", () => {
    const script = /^<base target="_blank">\n<script>([\s\S]*?)<\/script>\n<style>/.exec(
      hiveHead,
    )?.[1];
    expect(script).toBeDefined();
    let listener: ((event: { target: unknown }) => void) | undefined;
    let capture: unknown;
    const document = {
      addEventListener(type: string, handler: typeof listener, useCapture: unknown) {
        if (type === "click") [listener, capture] = [handler, useCapture];
      },
    };
    new Function("document", script!)(document);
    expect(capture).toBe(true);
    const attrs: Record<string, string> = {};
    const link = { setAttribute: (name: string, value: string) => (attrs[name] = value) };
    let selector = "";
    listener!({
      target: {
        closest: (query: string) => {
          selector = query;
          return link;
        },
      },
    });
    expect(selector).toBe('a[href^="#"]:not([target])');
    expect(attrs).toEqual({ target: "_self" });
    // A click outside such a link, or with no element target, changes nothing.
    listener!({ target: { closest: () => null } });
    listener!({ target: null });
    expect(PAGE_HEAD_V1).not.toContain('addEventListener("click"');
  });

  test("the html element paints no background, so a body background reaches the canvas", () => {
    expect(ruleBody(baseLayer, "  html")).not.toContain("background");
    expect(ruleBody(baseLayer, "  body")).toContain("background-color: var(--color-background);");
  });

  test("inline code clones its padding and radius onto each line of a wrapped chip", () => {
    const code = ruleBody(baseLayer, "  code");
    expect(code).toContain("-webkit-box-decoration-break: clone;");
    expect(code).toContain("box-decoration-break: clone;");
  });

  test("the table wrap shows token edge shadows where columns are hidden", () => {
    const wrap = ruleBody(componentsLayer, "  .swarm-table-wrap");
    const shadow = "color-mix(in oklab, var(--color-foreground) 14%, transparent)";
    expect(wrap).toContain(
      "linear-gradient(to right, var(--color-card) 30%, transparent) left / 40px 100% no-repeat local,",
    );
    expect(wrap).toContain(
      "linear-gradient(to left, var(--color-card) 30%, transparent) right / 40px 100% no-repeat local,",
    );
    expect(wrap).toContain(
      `linear-gradient(to right, ${shadow}, transparent) left / 14px 100% no-repeat scroll,`,
    );
    expect(wrap).toContain(
      `linear-gradient(to left, ${shadow}, transparent) right / 14px 100% no-repeat scroll,`,
    );
    expect(wrap).toMatch(/var\(--color-card\);\n\s+border: 1px solid var\(--color-border\);/);
  });

  test("a table footer gets a strong rule and weight 600, and the last body row keeps its rule", () => {
    const footer = ruleBody(baseLayer, "  tfoot :is(td, th)");
    expect(footer).toContain("font-weight: 600;");
    expect(footer).toContain("border-top: 1px solid var(--color-border);");
    // Collapsed borders: the upper cell wins a same-width conflict, so the
    // shared line takes the strong color from the body side too.
    expect(baseLayer).toContain(
      "tbody:has(+ tfoot) > tr:last-child > :is(td, th) { border-bottom-color: var(--color-border); }",
    );
    // Inside a wrap, only the table's last row drops its rule (the wrap border
    // is the edge), not the last body row before a footer.
    expect(componentsLayer).toContain(
      ".swarm-table-wrap > .swarm-table > :last-child > tr:last-child > :is(td, th) { border-bottom: 0; }",
    );
    expect(componentsLayer).not.toContain(".swarm-table tbody tr:last-child");
  });

  test("print shows a footer once and lets wide swarm tables wrap at 12px", () => {
    const print = designCss.slice(designCss.indexOf("\n@media print {"));
    expect(print).toContain("tfoot { display: table-row-group; }");
    expect(print).toContain(".swarm-table { font-size: 12px; }");
    expect(print).toContain(".swarm-table :is(th, td):not(.num) { white-space: normal; }");
  });

  test("the version 1 head stays the original Tailwind v3 head", () => {
    expect(PAGE_HEAD_V1).toContain('<script src="https://cdn.tailwindcss.com"></script>');
    expect(PAGE_HEAD_V1).toContain("--swarm-bg: #fbfbfa;");
    expect(PAGE_HEAD_V1).not.toContain("@tailwindcss/browser");
    expect(PAGE_THEME_PARAM).toBe("__swarm-theme");
    expect(PAGE_MODE_PARAM).toBe("__swarm-mode");
  });
});

describe("GET /p/:id serves the head of the page's design version", () => {
  let server: Server;
  let base = "";
  const headers = { "Content-Type": "application/json", "X-Agent-ID": crypto.randomUUID() };
  const html =
    '<!doctype html><html><head><title>T</title></head><body><main class="swarm-page"><h1>Hi</h1></main></body></html>';

  async function createPage(slug: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await fetch(`${base}/api/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug,
        title: slug,
        contentType: "text/html",
        authMode: "public",
        body: html,
        ...extra,
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function serve(id: string, query = ""): Promise<string> {
    const res = await fetch(`${base}/p/${id}${query}`);
    expect(res.status).toBe(200);
    return res.text();
  }

  function lightTokens(page: string): Record<string, string> {
    return declarations(styleText(page, "swarm-theme"), ":root");
  }

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      const pathSegments = getPathSegments(req.url || "");
      const queryParams = parseQueryParams(req.url || "");
      const myAgentId = req.headers["x-agent-id"] as string | undefined;
      if (await handlePagesPublic(req, res, pathSegments, queryParams)) return;
      if (await handlePages(req, res, pathSegments, queryParams, myAgentId)) return;
      res.writeHead(404);
      res.end("not found");
    });
    base = `http://localhost:${await listenOnFreePort(server)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("a new page gets the v2 head: layer statement first, pinned v4, tokens, primitives", async () => {
    const page = await serve(await createPage("v2-default"));
    const head = page.slice(page.indexOf("<head>"), page.indexOf("</head>"));
    expect(head.indexOf("<style")).toBe(head.indexOf(LAYER_STATEMENT));
    expect(head).toContain(TAILWIND_SCRIPT);
    expect(head).not.toContain("cdn.tailwindcss.com");
    expect(head).not.toContain(DARK_SCRIPT);
    expect(head).toContain("--swarm-text: var(--color-foreground);");
    expect(head).toContain(".swarm-metric-value");
    expect(lightTokens(page)["--color-primary"]).toBe(HIVE_PAGE_TOKENS.light["--color-primary"]);
    // The SDK and the built-in elements still follow the head.
    expect(page.indexOf("class SwarmSDK")).toBeGreaterThan(page.indexOf(TAILWIND_SCRIPT));
    expect(page).toContain("customElements.define('swarm-diff'");
  });

  test("a v2 body without a doctype or a <head> is served in standards mode", async () => {
    const cases: [body: string, start: string, end: string][] = [
      // A fragment: the doctype is prepended and the head follows it.
      ["<h1>Hi</h1>", '<!doctype html><base target="_blank">', "</script><h1>Hi</h1>"],
      // A doctype and no <html>: the head follows the doctype, not doubled.
      [
        "\n<!DOCTYPE html>\n<p>x</p>",
        '\n<!DOCTYPE html><base target="_blank">',
        "</script>\n<p>x</p>",
      ],
      // An <html> tag and no <head>: the head follows <html ...>.
      [
        '<!doctype html>\n<html lang="en"><body>x</body></html>',
        '<!doctype html>\n<html lang="en"><base target="_blank">',
        "</script><body>x</body></html>",
      ],
      // A <head> and no doctype: the doctype is prepended, the head stays put.
      [
        "<html><head><title>T</title></head><body>x</body></html>",
        '<!doctype html><html><head><base target="_blank">',
        "</script><title>T</title></head><body>x</body></html>",
      ],
    ];
    for (const [index, [body, start, end]] of cases.entries()) {
      const page = await serve(await createPage(`standards-${index}`, { body }));
      expect(page.startsWith(start)).toBe(true);
      expect(page.endsWith(end)).toBe(true);
    }
  });

  test("a body full of unclosed <head tokens is served in linear time", async () => {
    // `/<head\b[^>]*>/i` rescanned the rest of the body for each token: 240k
    // chars took 1.6 s and a 5 MB body would block the API for minutes.
    const body = "<head ".repeat(100_000);
    for (const designVersion of [1, 2]) {
      const id = await createPage(`head-tokens-v${designVersion}`, { body, designVersion });
      const started = performance.now();
      const page = await serve(id);
      expect(performance.now() - started).toBeLessThan(500);
      expect(page.length).toBeGreaterThan(body.length);
    }
  });

  test("a version 1 page keeps the exact old head and ignores the params", async () => {
    // Frozen from src/http/pages-public.ts at main commit 3d6d8a750.
    const baseline = await Bun.file(
      new URL("./fixtures/pages/head-v1.html", import.meta.url),
    ).text();
    const id = await createPage("v1-page", { designVersion: 1 });
    const page = await serve(id, `?${PAGE_THEME_PARAM}=github&${PAGE_MODE_PARAM}=dark`);
    expect(page).toContain(`<head>${baseline}<script>`);
    expect(page).toContain("--swarm-bg: #fbfbfa");
    expect(page).not.toContain("@tailwindcss/browser");
    expect(page).not.toContain(DARK_SCRIPT);
  });

  test("__swarm-theme picks the preset when the page has no theme; unknown ids fall back", async () => {
    const id = await createPage("viewer-theme");
    const github = getThemePreset("github")!;
    expect(lightTokens(await serve(id, `?${PAGE_THEME_PARAM}=github`))["--color-primary"]).toBe(
      github.vars.light["--color-primary"],
    );
    expect(github.vars.light["--color-primary"]).not.toBe(
      HIVE_PAGE_TOKENS.light["--color-primary"],
    );
    expect(lightTokens(await serve(id, `?${PAGE_THEME_PARAM}=nope`))).toEqual(
      lightTokens(await serve(id)),
    );
  });

  test("the page theme wins over __swarm-theme", async () => {
    const id = await createPage("page-theme", { theme: "paper" });
    const tokens = lightTokens(await serve(id, `?${PAGE_THEME_PARAM}=github`));
    const paper = getThemePreset("paper")!;
    expect(tokens["--color-primary"]).toBe(paper.vars.light["--color-primary"]);
    expect(tokens["--color-background"]).toBe(paper.vars.light["--color-background"]);
  });

  test("themeTokens override the preset", async () => {
    const id = await createPage("theme-tokens", {
      themeTokens: {
        light: { "--color-primary": "oklch(0.5 0.2 150)" },
        dark: { "--color-primary": "oklch(0.7 0.15 150)" },
      },
    });
    const css = styleText(await serve(id, `?${PAGE_THEME_PARAM}=github`), "swarm-theme");
    expect(declarations(css, ":root")["--color-primary"]).toBe("oklch(0.5 0.2 150)");
    expect(declarations(css, ":root.dark")["--color-primary"]).toBe("oklch(0.7 0.15 150)");
  });

  test("__swarm-mode=dark adds the dark class script; other values stay light", async () => {
    const id = await createPage("dark-mode");
    expect(await serve(id, `?${PAGE_MODE_PARAM}=dark`)).toContain(DARK_SCRIPT);
    expect(await serve(id, `?${PAGE_MODE_PARAM}=light`)).not.toContain(DARK_SCRIPT);
    expect(await serve(id, `?${PAGE_MODE_PARAM}=DARK`)).not.toContain(DARK_SCRIPT);
  });

  test("a page with 8 or more hardcoded colors stays light in dark mode; 7 still go dark", async () => {
    expect(COLOR_LITERAL_THRESHOLD).toBe(8);
    const body = (count: number) =>
      `<!doctype html><html><head><style>${Array.from(
        { length: count },
        (_, i) => `.c${i}{color:rgb(${i} 0 0)}`,
      ).join("")}</style></head><body><h1>Hi</h1></body></html>`;
    const hardcoded = await createPage("hardcoded-8", { body: body(8) });
    const page = await serve(hardcoded, `?${PAGE_MODE_PARAM}=dark&${PAGE_THEME_PARAM}=github`);
    expect(page).not.toContain(DARK_SCRIPT);
    // The viewer's preset still applies, in light mode.
    expect(lightTokens(page)["--color-primary"]).toBe(
      getThemePreset("github")!.vars.light["--color-primary"],
    );
    const tokens = await createPage("hardcoded-7", { body: body(7) });
    expect(await serve(tokens, `?${PAGE_MODE_PARAM}=dark`)).toContain(DARK_SCRIPT);
  });

  test("print still works for both versions, and a v2 print is light", async () => {
    const v2 = await serve(await createPage("print-v2"), `?print=1&${PAGE_MODE_PARAM}=dark`);
    expect(v2).toContain("window.print()");
    expect(v2).toContain('<style id="swarm-theme">');
    expect(v2).not.toContain(DARK_SCRIPT);
    const v1 = await serve(await createPage("print-v1", { designVersion: 1 }), "?print=1");
    expect(v1).toContain("window.print()");
    expect(v1).toContain(PAGE_HEAD_V1);
  });
});
