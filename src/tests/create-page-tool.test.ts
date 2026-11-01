/**
 * `create_page` MCP tool — unit-level coverage. Registers the tool against
 * a fresh `McpServer`, pulls the handler out of the SDK's registry, and
 * invokes it directly with a stubbed agent-id `requestInfo`.
 *
 * Verifies:
 *   - first-call path: creates a row in `pages`, returns `{id, version=1, app_url, api_url}`
 *   - upsert path: second call with the same slug bumps the edit-counter
 *     and writes a version row
 *   - capability gate: tool is registered when `CAPABILITIES` contains
 *     `pages`, NOT registered when missing (verified via `createServer`)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, getPageBySlug, getPageVersions, initDb } from "../be/db";
import { COLOR_LITERAL_THRESHOLD, countColorLiterals } from "../pages/color-literals";
import { registerCreatePageTool } from "../tools/create-page";

const TEST_DB_PATH = "./test-create-page-tool.sqlite";
const originalPublicMcpBaseUrl = process.env.PUBLIC_MCP_BASE_URL;

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function buildServer() {
  const server = new McpServer({ name: "create-page-test", version: "1.0.0" });
  registerCreatePageTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered.create_page;
  if (!tool) throw new Error("create_page tool not registered");
  return tool;
}

describe("create_page MCP tool", () => {
  const agentId = crypto.randomUUID();
  const fakeMeta = {
    sessionId: "session-1",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    // The tool reads MCP_BASE_URL / APP_URL when building share URLs.
    delete process.env.PUBLIC_MCP_BASE_URL;
    process.env.MCP_BASE_URL = "http://test-api:9999";
    process.env.APP_URL = "http://test-app:5274";
  });

  afterAll(async () => {
    closeDb();
    if (originalPublicMcpBaseUrl === undefined) {
      delete process.env.PUBLIC_MCP_BASE_URL;
    } else {
      process.env.PUBLIC_MCP_BASE_URL = originalPublicMcpBaseUrl;
    }
    delete process.env.MCP_BASE_URL;
    delete process.env.APP_URL;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("first call creates an authed row by default + returns shareable URLs", async () => {
    const tool = buildServer();
    const result = (await tool.handler(
      {
        title: "Hello Page",
        body: "<h1>hello</h1>",
        contentType: "text/html",
      },
      fakeMeta,
    )) as {
      structuredContent: {
        id: string;
        version: number;
        app_url: string;
        api_url: string;
        yourAgentId: string;
      };
    };

    expect(result.structuredContent.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.structuredContent.version).toBe(1);
    expect(result.structuredContent.api_url).toBe(
      `http://test-api:9999/p/${result.structuredContent.id}`,
    );
    expect(result.structuredContent.app_url).toBe(
      `http://test-app:5274/pages/${result.structuredContent.id}`,
    );
    expect(result.structuredContent.yourAgentId).toBe(agentId);

    // DB row exists with the auto-slug from the title.
    const row = await getPageBySlug(agentId, "hello-page");
    expect(row).not.toBeNull();
    expect(row!.body).toBe("<h1>hello</h1>");
    expect(row!.authMode).toBe("authed");
  });

  test("explicit public auth mode is preserved", async () => {
    const tool = buildServer();
    await tool.handler(
      {
        title: "Public Page",
        body: "<h1>public</h1>",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    );

    const row = await getPageBySlug(agentId, "public-page");
    expect(row).not.toBeNull();
    expect(row!.authMode).toBe("public");
  });

  test("re-running with the same slug upserts + bumps edit-counter", async () => {
    const tool = buildServer();

    const first = (await tool.handler(
      {
        title: "Upsert Page",
        slug: "upsert",
        body: "v0",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    )) as { structuredContent: { id: string; version: number } };
    expect(first.structuredContent.version).toBe(1);

    const second = (await tool.handler(
      {
        title: "Upsert Page",
        slug: "upsert",
        body: "v1",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    )) as { structuredContent: { id: string; version: number } };
    expect(second.structuredContent.id).toBe(first.structuredContent.id);
    expect(second.structuredContent.version).toBe(2);

    // Version row holds the PRE-update body.
    const versions = await getPageVersions(first.structuredContent.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.snapshot.body).toBe("v0");

    // Parent now holds the new body.
    const row = await getPageBySlug(agentId, "upsert");
    expect(row?.body).toBe("v1");

    // The counter and the next snapshot number keep climbing from MAX(version).
    const third = (await tool.handler(
      {
        title: "Upsert Page",
        slug: "upsert",
        body: "v2",
        contentType: "text/html",
        authMode: "public",
      },
      fakeMeta,
    )) as { structuredContent: { version: number } };
    expect(third.structuredContent.version).toBe(3);
    const after = await getPageVersions(first.structuredContent.id);
    expect(after.map((v) => [v.version, v.snapshot.body])).toEqual([
      [2, "v1"],
      [1, "v0"],
    ]);
  });

  test("missing X-Agent-ID returns an error result", async () => {
    const tool = buildServer();
    const result = (await tool.handler(
      {
        title: "Anon",
        body: "x",
        contentType: "text/html",
        authMode: "public",
      },
      { sessionId: "s", requestInfo: { headers: {} } },
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("password is hashed (not stored verbatim)", async () => {
    const tool = buildServer();
    await tool.handler(
      {
        title: "Pw",
        slug: "pw-tool",
        body: "secret",
        contentType: "text/html",
        authMode: "password",
        password: "example-open-sesame",
      },
      fakeMeta,
    );
    const row = await getPageBySlug(agentId, "pw-tool");
    expect(row?.passwordHash).toBeDefined();
    expect(row?.passwordHash).not.toBe("example-open-sesame");
    expect(await Bun.password.verify("example-open-sesame", row!.passwordHash!)).toBe(true);
  });

  describe("design fields", () => {
    type ToolResult = {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent: {
        id?: string;
        message: string;
        details?: string;
        nudge?: string;
        designVersion?: number;
        ignoredTokens?: string[];
        colorLiteralCount?: number;
        usesDesignSystem?: boolean;
        lightOnlyColors?: boolean;
      };
    };

    const NUDGE_TEXT = (count: number) =>
      `This page hardcodes ${count} color values. Use theme tokens (var(--color-primary), bg-primary, text-muted-foreground) so theme and dark-mode switches restyle it. Until then the page stays light in a dark dashboard.`;
    const V1_NUDGE =
      "This page is on designVersion 1 (the original look), so design system classes, tokens and themes have no effect. Pass designVersion: 2.";
    const LIGHT_ONLY_NUDGE =
      "Your themeTokens set colors for light mode only. Dark mode keeps the preset's dark colors; add a dark map (or a .dark block) to restyle it too.";
    const IGNORED_MESSAGE =
      "Some theme tokens were ignored (outside the page token contract or referencing a variable outside it).";

    const uniqueSlug = () => `design-${crypto.randomUUID().slice(0, 8)}`;

    /** An HTML page whose <style> block holds exactly `count` color literals. */
    const styledPage = (count: number) =>
      `<h1>Report</h1><style>${Array.from(
        { length: count },
        (_, i) => `.c${i}{color:rgb(${i} 0 0)}`,
      ).join("")}</style>`;

    async function call(args: Record<string, unknown>): Promise<ToolResult> {
      const tool = buildServer();
      return (await tool.handler(
        {
          title: "Design Page",
          slug: uniqueSlug(),
          body: "<h1>hi</h1>",
          contentType: "text/html",
          authMode: "public",
          ...args,
        },
        fakeMeta,
      )) as ToolResult;
    }

    test("a new page gets design version 2 with no theme and no tokens", async () => {
      const slug = uniqueSlug();
      const result = await call({ slug });
      expect(result.isError).toBe(false);
      const row = await getPageBySlug(agentId, slug);
      expect(row?.designVersion).toBe(2);
      expect(row?.theme).toBeNull();
      expect(row?.themeTokens).toBeNull();
      expect(result.structuredContent.ignoredTokens).toBeUndefined();
    });

    test("an explicit design version and a preset theme are stored on create", async () => {
      const slug = uniqueSlug();
      await call({ slug, theme: "paper", designVersion: 1 });
      const row = await getPageBySlug(agentId, slug);
      expect(row?.theme).toBe("paper");
      expect(row?.designVersion).toBe(1);
    });

    test("an unknown theme returns an error that lists the presets and saves nothing", async () => {
      const slug = uniqueSlug();
      const result = await call({ slug, theme: "neon" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.message).toContain('Unknown theme "neon"');
      for (const id of ["hive", "paper", "github"]) {
        expect(result.structuredContent.message).toContain(id);
      }
      expect(await getPageBySlug(agentId, slug)).toBeNull();
    });

    test("shadcn-style tokens are stored normalized and the ignored names are reported", async () => {
      const slug = uniqueSlug();
      const result = await call({
        slug,
        themeTokens: {
          light: {
            "--primary": "oklch(0.55 0.2 260)",
            background: "oklch(1 0 0)",
            radius: "0.5rem",
            "--sidebar": "oklch(0.9 0 0)",
            "--shadow-2xs": "0 1px 2px #0000",
          },
          dark: { "--primary": "oklch(0.7 0.15 260)" },
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.ignoredTokens).toEqual(["--sidebar", "--shadow-2xs"]);
      expect(result.structuredContent.message).toContain(IGNORED_MESSAGE);
      expect(result.structuredContent.details).toContain(
        "Ignored theme tokens: --sidebar, --shadow-2xs",
      );
      expect(result.content[0]!.text).toContain("--shadow-2xs");

      const row = await getPageBySlug(agentId, slug);
      expect(row?.themeTokens).toEqual({
        light: {
          "--color-primary": "oklch(0.55 0.2 260)",
          "--color-background": "oklch(1 0 0)",
          "--radius-sm": "calc(0.5rem - 4px)",
          "--radius-md": "calc(0.5rem - 2px)",
          "--radius-lg": "0.5rem",
          "--radius-xl": "calc(0.5rem + 4px)",
        },
        dark: { "--color-primary": "oklch(0.7 0.15 260)" },
      });
    });

    test("tokens with nothing to ignore report nothing", async () => {
      const result = await call({
        themeTokens: { light: { "--color-primary": "oklch(0.55 0.2 260)" } },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.ignoredTokens).toBeUndefined();
      expect(result.structuredContent.message).not.toContain("ignored");
      expect(result.structuredContent.details).not.toContain("Ignored");
    });

    test("the css format works", async () => {
      const slug = uniqueSlug();
      const result = await call({
        slug,
        themeTokens: {
          format: "css",
          css: ":root { --primary: 222.2 47.4% 11.2%; --tracking-normal: 0em; } .dark { --primary: 210 40% 98%; }",
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.ignoredTokens).toEqual(["--tracking-normal"]);
      const row = await getPageBySlug(agentId, slug);
      expect(row?.themeTokens).toEqual({
        light: { "--color-primary": "hsl(222.2 47.4% 11.2%)" },
        dark: { "--color-primary": "hsl(210 40% 98%)" },
      });
    });

    test("bad themeTokens return an error that names the problem and save nothing", async () => {
      const slug = uniqueSlug();
      const unsafe = await call({
        slug,
        themeTokens: { light: { "--color-primary": "red; } body { display: none" } },
      });
      expect(unsafe.isError).toBe(true);
      expect(unsafe.structuredContent.message).toContain("Invalid themeTokens");
      expect(unsafe.structuredContent.message).toContain("--color-primary");

      const missingCss = await call({ slug, themeTokens: { format: "css" } });
      expect(missingCss.isError).toBe(true);
      expect(missingCss.structuredContent.message).toContain("Invalid themeTokens");

      expect(await getPageBySlug(agentId, slug)).toBeNull();
    });

    test("an upsert keeps the design fields it omits and clears them with null", async () => {
      const slug = uniqueSlug();
      const tokens = { light: { "--color-ring": "oklch(0.6 0.2 30)" } };
      await call({ slug, theme: "paper", themeTokens: tokens, designVersion: 1 });
      const stored = {
        theme: "paper",
        themeTokens: { light: { "--color-ring": "oklch(0.6 0.2 30)" }, dark: {} },
      };

      // Omitted fields keep the stored values, including an older design version.
      await call({ slug, body: "<h1>v2</h1>" });
      let row = await getPageBySlug(agentId, slug);
      expect(row?.body).toBe("<h1>v2</h1>");
      expect(row).toMatchObject({ ...stored, designVersion: 1 });

      // A given version moves the page. The theme and the tokens stay.
      await call({ slug, body: "<h1>v3</h1>", designVersion: 2 });
      row = await getPageBySlug(agentId, slug);
      expect(row).toMatchObject({ ...stored, designVersion: 2 });

      // A new theme replaces the old one. The tokens stay.
      await call({ slug, body: "<h1>v4</h1>", theme: "github" });
      row = await getPageBySlug(agentId, slug);
      expect(row).toMatchObject({ theme: "github", themeTokens: stored.themeTokens });

      // null clears one field at a time.
      await call({ slug, body: "<h1>v5</h1>", theme: null });
      row = await getPageBySlug(agentId, slug);
      expect(row?.theme).toBeNull();
      expect(row?.themeTokens).toEqual(stored.themeTokens);
      await call({ slug, body: "<h1>v6</h1>", themeTokens: null });
      row = await getPageBySlug(agentId, slug);
      expect(row?.themeTokens).toBeNull();
      expect(row?.designVersion).toBe(2);
    });

    test("a rejected upsert leaves the page and its history alone", async () => {
      const slug = uniqueSlug();
      const first = await call({ slug, body: "<h1>kept</h1>", theme: "paper" });
      const result = await call({ slug, body: "<h1>lost</h1>", theme: "neon" });
      expect(result.isError).toBe(true);

      const row = await getPageBySlug(agentId, slug);
      expect(row?.body).toBe("<h1>kept</h1>");
      expect(row?.theme).toBe("paper");
      expect(await getPageVersions(first.structuredContent.id!)).toHaveLength(0);
    });

    test("a reference outside the contract is reported with the reference", async () => {
      const result = await call({
        themeTokens: {
          format: "css",
          css: ":root { --primary: oklch(0.55 0.2 260); --font-sans: var(--font-geist-sans); } .dark { --primary: oklch(0.7 0.15 260); }",
        },
      });
      expect(result.isError).toBe(false);
      expect(result.structuredContent.ignoredTokens).toEqual([
        "--font-sans (references --font-geist-sans)",
      ]);
      expect(result.structuredContent.message).toContain(IGNORED_MESSAGE);
      expect(result.structuredContent.details).toContain(
        "Ignored theme tokens: --font-sans (references --font-geist-sans)",
      );
    });

    test("the result reports the saved design version in data and in the message", async () => {
      const slug = uniqueSlug();
      const created = await call({ slug });
      expect(created.structuredContent.designVersion).toBe(2);
      expect(created.structuredContent.message).toContain("designVersion=2)");

      const legacy = await call({ designVersion: 1 });
      expect(legacy.structuredContent.designVersion).toBe(1);
      expect(legacy.structuredContent.message).toContain("designVersion=1)");

      const json = await call({ body: '{"type":"text"}', contentType: "application/json" });
      expect(json.structuredContent.designVersion).toBe(2);
      expect(json.structuredContent.usesDesignSystem).toBeUndefined();
      expect(json.structuredContent.lightOnlyColors).toBeUndefined();
    });

    test("a design version 1 HTML page that uses the design system gets the version nudge", async () => {
      const designSystemCalls: Array<Record<string, unknown>> = [
        { body: '<main class="swarm-page"><h1>Report</h1></main>' },
        { body: "<p class='lead swarm-lede'>x</p>" },
        { body: "<style>.a{color:var(--color-primary)}</style>" },
        { theme: "paper" },
        { themeTokens: { light: { "--radius-lg": "8px" } } },
      ];
      for (const extra of designSystemCalls) {
        const result = await call({ designVersion: 1, ...extra });
        expect(result.isError).toBe(false);
        expect(result.structuredContent.usesDesignSystem).toBe(true);
        expect(result.structuredContent.nudge).toBe(V1_NUDGE);
      }
    });

    test("the version nudge stays quiet on plain v1 pages, on v2 pages and on other content types", async () => {
      const plain = await call({
        designVersion: 1,
        // <swarm-diff> works on both design versions, and a cleared theme is not a theme.
        body: '<h1>PR</h1><swarm-diff>{"files":[]}</swarm-diff><p class="not-swarm-x">x</p>',
        theme: null,
        themeTokens: null,
      });
      expect(plain.structuredContent.usesDesignSystem).toBe(false);
      expect(plain.structuredContent.nudge).toBeUndefined();

      const v2 = await call({ body: '<main class="swarm-page">x</main>', theme: "paper" });
      expect(v2.structuredContent.usesDesignSystem).toBe(true);
      expect(v2.structuredContent.nudge).toBeUndefined();

      const svg = await call({
        designVersion: 1,
        body: '<svg xmlns="http://www.w3.org/2000/svg" class="swarm-page"/>',
        contentType: "image/svg+xml",
        theme: "paper",
      });
      expect(svg.structuredContent.usesDesignSystem).toBeUndefined();
      expect(svg.structuredContent.nudge).toBeUndefined();
    });

    test("an upsert that keeps a design version 1 page gets the version nudge", async () => {
      const slug = uniqueSlug();
      await call({ slug, body: "<h1>old</h1>", designVersion: 1 });
      const rewritten = await call({ slug, body: '<main class="swarm-page">new</main>' });
      expect(rewritten.structuredContent.designVersion).toBe(1);
      expect(rewritten.structuredContent.nudge).toBe(V1_NUDGE);

      const moved = await call({
        slug,
        body: '<main class="swarm-page">new</main>',
        designVersion: 2,
      });
      expect(moved.structuredContent.designVersion).toBe(2);
      expect(moved.structuredContent.nudge).toBeUndefined();
    });

    test("stored tokens with light colors and no dark colors get the light-only nudge", async () => {
      const slug = uniqueSlug();
      const lightOnly = await call({
        slug,
        themeTokens: { light: { "--color-primary": "oklch(0.55 0.2 260)", "--radius-lg": "8px" } },
      });
      expect(lightOnly.structuredContent.lightOnlyColors).toBe(true);
      expect(lightOnly.structuredContent.nudge).toBe(LIGHT_ONLY_NUDGE);

      // The note follows the stored tokens, so an upsert that keeps them repeats it.
      const kept = await call({ slug, body: "<h1>again</h1>" });
      expect(kept.structuredContent.lightOnlyColors).toBe(true);
      expect(kept.structuredContent.nudge).toBe(LIGHT_ONLY_NUDGE);

      const quiet: Array<Record<string, unknown>> = [
        { themeTokens: { light: { "--font-sans": "Inter", "--radius-lg": "8px" } } },
        {
          themeTokens: {
            light: { "--color-primary": "oklch(0.55 0.2 260)" },
            dark: { "--color-primary": "oklch(0.7 0.15 260)" },
          },
        },
        { themeTokens: { dark: { "--color-primary": "oklch(0.7 0.15 260)" } } },
        {},
      ];
      for (const extra of quiet) {
        const result = await call(extra);
        expect(result.structuredContent.lightOnlyColors).toBe(false);
        expect(result.structuredContent.nudge).toBeUndefined();
      }
    });

    test("the nudge joins every sentence that applies, in a fixed order", async () => {
      const lightOnly = { light: { "--color-primary": "oklch(0.55 0.2 260)" } };
      const legacy = await call({ designVersion: 1, themeTokens: lightOnly });
      expect(legacy.structuredContent.nudge).toBe(`${V1_NUDGE} ${LIGHT_ONLY_NUDGE}`);

      const current = await call({ body: styledPage(9), themeTokens: lightOnly });
      expect(current.structuredContent.nudge).toBe(`${LIGHT_ONLY_NUDGE} ${NUDGE_TEXT(9)}`);
      expect(current.content[0]!.text).toContain(`${LIGHT_ONLY_NUDGE} ${NUDGE_TEXT(9)}`);
    });

    test("the color nudge fires at 8 color literals and not at 7", async () => {
      // The page server shares this threshold: from 8 on, dark mode keeps the page light.
      expect(COLOR_LITERAL_THRESHOLD).toBe(8);
      const seven = await call({ body: styledPage(7) });
      expect(seven.structuredContent.colorLiteralCount).toBe(7);
      expect(seven.structuredContent.nudge).toBeUndefined();

      const eight = await call({ body: styledPage(8) });
      expect(eight.structuredContent.colorLiteralCount).toBe(8);
      expect(eight.structuredContent.nudge).toBe(NUDGE_TEXT(8));
      expect(eight.content[0]!.text).toContain(NUDGE_TEXT(8));
    });

    test("the color count covers style attributes and ignores colors elsewhere", async () => {
      const result = await call({
        body: [
          "<style>.a{color:#fff;background:#0f172a}</style>",
          '<p style="color:#2563eb;border:1px solid hsl(0 0% 90%)">a</p>',
          "<p style='fill:oklch(0.5 0.2 30)'>b</p>",
          // Not counted: text, script, and attributes that are not style.
          "<p>Use #fff or rgb(0 0 0) for white.</p>",
          '<script>const c = "#ff0000";</script>',
          '<svg fill="#fff"><circle stroke="rgb(0 0 0)"/></svg>',
        ].join(""),
      });
      expect(result.structuredContent.colorLiteralCount).toBe(5);
    });

    test("pages on design version 1, and pages that are not HTML, get no color count or nudge", async () => {
      const legacy = await call({ body: styledPage(20), designVersion: 1 });
      expect(legacy.structuredContent.colorLiteralCount).toBeUndefined();
      expect(legacy.structuredContent.nudge).toBeUndefined();

      const json = await call({
        body: JSON.stringify({ note: styledPage(20) }),
        contentType: "application/json",
      });
      expect(json.structuredContent.colorLiteralCount).toBeUndefined();
      expect(json.structuredContent.nudge).toBeUndefined();

      const svg = await call({
        body: `<svg xmlns="http://www.w3.org/2000/svg">${styledPage(20)}</svg>`,
        contentType: "image/svg+xml",
      });
      expect(svg.structuredContent.colorLiteralCount).toBeUndefined();
      expect(svg.structuredContent.nudge).toBeUndefined();
    });

    test("an upsert is judged by the design version the page keeps", async () => {
      const slug = uniqueSlug();
      await call({ slug, body: "<h1>old</h1>", designVersion: 1 });
      const kept = await call({ slug, body: styledPage(20) });
      expect(kept.structuredContent.colorLiteralCount).toBeUndefined();
      expect(kept.structuredContent.nudge).toBeUndefined();

      const moved = await call({ slug, body: styledPage(20), designVersion: 2 });
      expect(moved.structuredContent.colorLiteralCount).toBe(20);
      expect(moved.structuredContent.nudge).toBe(NUDGE_TEXT(20));
    });

    test("a failed save carries no nudge", async () => {
      const result = await call({ body: styledPage(20), theme: "neon" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent.nudge).toBeUndefined();
    });
  });
});

describe("countColorLiterals", () => {
  test("counts every color literal form in a style block", () => {
    const css =
      ".a{color:#fff;background:#ffffff;border-color:#ffffff80;outline-color:#fffa}" +
      ".b{color:rgb(0 0 0);fill:rgba(0,0,0,.5);stroke:hsl(0 0% 0%);x:hsla(0,0%,0%,.5);y:oklch(0.5 0.2 30)}";
    expect(countColorLiterals(`<style>${css}</style>`)).toBe(9);
  });

  test("counts style attributes with either quote and every style block", () => {
    const html =
      "<p style=\"color:#fff\">a</p><p style='background:rgb(0 0 0)'>b</p>" +
      "<style>.a{color:#000}</style><style media=print>.b{color:#111}</style>";
    expect(countColorLiterals(html)).toBe(4);
  });

  test("is case-insensitive", () => {
    expect(countColorLiterals("<STYLE>.a{color:#FFF;b:RGB(0 0 0)}</STYLE>")).toBe(2);
  });

  test("counts an unclosed style block to the end of the body", () => {
    expect(countColorLiterals("<style>.a{color:#fff}.b{color:#000}")).toBe(2);
  });

  test("ignores colors outside style regions", () => {
    const html =
      "<p>#fff rgb(0 0 0)</p><script>var c = '#ff0000'</script>" +
      '<svg fill="#fff"></svg><p data-style="color:#fff"></p>';
    expect(countColorLiterals(html)).toBe(0);
  });

  test("ignores hex-like text that is not a color", () => {
    const css = ".a{width:#12345}.b{x:#1234567}#header{}.c{content:'#xyz'}.d{color:var(--c)}";
    expect(countColorLiterals(`<style>${css}</style>`)).toBe(0);
  });

  test("counts white and black as values in style regions, not inside names", () => {
    const css =
      ".a{color:white;background:black;border:1px solid white}" +
      ".b{white-space:nowrap;--black:1;font-family:'Archivo Black'}.white{}#black{}";
    expect(countColorLiterals(`<style>${css}</style>`)).toBe(3);
    expect(countColorLiterals('<p style="background: black">x</p>')).toBe(1);
    expect(countColorLiterals("<p>white on black</p>")).toBe(0);
  });

  test("counts color classes in class attributes", () => {
    const palette =
      '<p class="bg-blue-500 hover:text-gray-600/80 dark:border-zinc-800 !ring-red-50">a</p>' +
      "<p class='from-sky-400 via-violet-500 to-rose-950 shadow-slate-900 divide-stone-100'>b</p>" +
      '<p class="outline-amber-300 decoration-lime-200 accent-teal-700 caret-cyan-600">c</p>' +
      '<p class="placeholder-neutral-400 fill-emerald-500 stroke-indigo-500 text-fuchsia-500">d</p>' +
      '<p class="bg-orange-100 text-yellow-800 border-green-300 bg-purple-50 text-pink-400">e</p>';
    expect(countColorLiterals(palette)).toBe(22);
    expect(countColorLiterals('<p class="bg-white text-black bg-white/80 text-white">x</p>')).toBe(
      4,
    );
    expect(
      countColorLiterals(
        '<p class="bg-[#fff] text-[rgb(0_0_0)] border-[hsl(0_0%_90%)] ring-[oklch(0.5_0.2_30)]">x</p>',
      ),
    ).toBe(4);
  });

  test("ignores token classes, other class names, and color classes outside class attributes", () => {
    const html =
      '<p class="bg-card text-muted-foreground border-border bg-primary swarm-panel">a</p>' +
      '<p class="border-white ring-black my-bg-red-500 bg-red text-red bg-blue-500x">b</p>' +
      '<p data-class="bg-red-500">c</p><p>bg-red-500 text-white</p>' +
      "<style>.bg-white{display:block}</style>";
    expect(countColorLiterals(html)).toBe(0);
  });

  test("returns 0 for a body without style regions", () => {
    expect(countColorLiterals("")).toBe(0);
    expect(countColorLiterals("<h1>plain</h1>")).toBe(0);
  });

  test("stays fast on a body of many unterminated tags", () => {
    // 20,000 "<style " tags with no ">" cost about a second with an unbounded
    // attribute match and about 2 ms with the capped one.
    const started = performance.now();
    expect(countColorLiterals("<style ".repeat(20_000))).toBe(0);
    expect(countColorLiterals(' style="'.repeat(20_000))).toBe(0);
    expect(countColorLiterals(' class="'.repeat(20_000))).toBe(0);
    expect(countColorLiterals(`<p class="${"bg-red-".repeat(20_000)}">`)).toBe(0);
    expect(countColorLiterals(`<p class="bg-red-${"5".repeat(100_000)}x">`)).toBe(0);
    expect(countColorLiterals(`<p class="${"-[".repeat(50_000)}">`)).toBe(0);
    expect(countColorLiterals(`<style>${"whites ".repeat(20_000)}</style>`)).toBe(0);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("create_page MCP tool capability gating", () => {
  test("not registered without 'pages' capability; registered with it", async () => {
    // Save + clear env then load the server module fresh.
    const orig = process.env.CAPABILITIES;
    try {
      // Default capabilities don't include 'pages' (step-3 enforced).
      process.env.CAPABILITIES = "core,task-pool,profiles,services,scheduling,memory,workflows";
      // Force a fresh module evaluation so the capability check re-runs.
      delete require.cache[require.resolve("../server")];
      const without = await import("../server");
      expect(without.hasCapability("pages")).toBe(false);

      process.env.CAPABILITIES =
        "core,task-pool,profiles,services,scheduling,memory,workflows,pages";
      delete require.cache[require.resolve("../server")];
      const withPages = await import("../server");
      expect(withPages.hasCapability("pages")).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.CAPABILITIES;
      else process.env.CAPABILITIES = orig;
      delete require.cache[require.resolve("../server")];
    }
  });
});
