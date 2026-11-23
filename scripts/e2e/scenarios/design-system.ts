import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  expectToolError,
  expectToolOk,
  type McpSession,
  registerAgent,
} from "./knowledge-helpers";
import { expectRunOk, runScript } from "./script-helpers";

/** The Agent Swarm brand, copied from the agent-swarm-page-branding skill. */
const BRAND_CSS = `:root {
  --font-sans: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "Space Mono", ui-monospace, monospace;
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --surface: oklch(0.985 0.0015 286);
  --primary: oklch(0.555 0.163 48.998);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.375);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --border: oklch(0.92 0.004 286.32);
  --ring: oklch(0.555 0.163 48.998);
  --destructive: oklch(0.577 0.245 27.325);
  --success: oklch(0.596 0.145 163.225);
  --radius-md: 0.5rem;
  --radius-lg: 0.625rem;
  --radius-xl: 0.75rem;
  --shadow-sm: 0 1px 2px oklch(0.141 0.005 285.823 / 0.05);
}`;
const BRAND_FONTS =
  "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Space+Mono:wght@400;700&display=swap";
const BRAND_RECORD = {
  basePreset: "hive",
  themeTokens: { format: "css", css: BRAND_CSS },
  fontsHref: BRAND_FONTS,
  logo: { url: "https://www.agent-swarm.dev/logo.png", alt: "Agent Swarm" },
  mode: "light",
  chartPalette: [
    "oklch(0.555 0.163 48.998)",
    "oklch(0.546 0.245 262.881)",
    "oklch(0.596 0.145 163.225)",
    "oklch(0.541 0.281 293.009)",
    "oklch(0.592 0.249 0.584)",
    "oklch(0.52 0.105 223.128)",
    "oklch(0.648 0.2 131.684)",
    "oklch(0.591 0.293 322.896)",
    "oklch(0.5 0.134 242.749)",
  ],
  source: { kind: "manual", ref: "agent-swarm-page-branding skill" },
};
/** The paper preset background: present only when the viewer preset wins. */
const PAPER_BACKGROUND = "oklch(0.973 0.004 91.446)";
const DARK_CLASS = 'classList.add("dark")';
const ASK = "no design system yet";

async function createHtmlPage(
  session: McpSession,
  slug: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; nudge: string }> {
  const outcome = expectToolOk(
    await callTool(session, "create_page", {
      title: `Design system ${slug}`,
      slug,
      body: '<!doctype html><html><head></head><body><main class="swarm-page"><h1>Hi</h1></main></body></html>',
      contentType: "text/html",
      authMode: "public",
      ...extra,
    }),
    `create_page ${slug}`,
  );
  return { id: asString(outcome.data.id, "page id"), nudge: String(outcome.data.nudge ?? "") };
}

async function served(ctx: ScenarioContext, id: string, query: string): Promise<string> {
  const response = await ctx.api("GET", `/p/${id}?${query}`, { apiKey: null });
  expectStatus(response, [200], `serve page ${id}?${query}`);
  return response.text;
}

async function stateOf(ctx: ScenarioContext): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", "/api/design-system");
  expectStatus(response, [200], "GET /api/design-system");
  return asRecord(response.json);
}

export const designSystem: Scenario = {
  name: "design-system",
  // After every other pages scenario: the org design system restyles pages for the rest of the run.
  order: 553,
  async run(ctx) {
    const agent = await registerAgent(ctx, "design-system");
    const session = await ctx.connectMcp(agent);
    try {
      // ── No record: the first HTML page ships on the default look and carries the ask ───
      expect((await stateOf(ctx)).status === "none", "a fresh swarm has no design system");
      const first = await createHtmlPage(session, `ds-first-${ctx.nonce}`);
      expect(first.nudge.includes(ASK), `the first page asks for a design system: ${first.nudge}`);
      expect(
        (await served(ctx, first.id, "__swarm-theme=paper")).includes(PAPER_BACKGROUND),
        "without a design system the viewer preset styles the page",
      );

      // ── Writes are validated; the raw KV path is closed ────────────────────────────────
      let response = await ctx.api("PUT", "/api/design-system", { body: { basePreset: "nope" } });
      expectStatus(response, [400], "unknown basePreset");
      response = await ctx.api("PUT", "/api/design-system", {
        body: { fontsHref: "https://evil.example/fonts.css" },
      });
      expectStatus(response, [400], "fontsHref off Google Fonts");
      response = await ctx.api("PUT", "/api/design-system", {
        body: { themeTokens: { light: { "--color-primary": "red;}body{x" } } },
      });
      expectStatus(response, [400], "unsafe token value");
      response = await ctx.api("PUT", "/api/kv/_/design-system/org", {
        agentId: agent,
        body: { value: { v: 1 } },
      });
      expectStatus(response, [403], "raw kv-set on the reserved namespace");
      expectToolError(
        await callTool(session, "design-system-set", { chartPalette: ["url(x)"] }),
        "design-system-set with an unsafe chart color",
        "chartPalette[0]",
      );

      // ── Declined: stored, and nobody asks again ────────────────────────────────────────
      expectToolOk(
        await callTool(session, "design-system-set", { status: "declined" }),
        "decline the design system",
      );
      const declined = await stateOf(ctx);
      expect(declined.status === "declined", "GET reports declined");
      const afterDecline = await createHtmlPage(session, `ds-declined-${ctx.nonce}`);
      expect(!afterDecline.nudge.includes(ASK), "no ask after declined");

      // ── Dry run validates without saving ────────────────────────────────────────────────
      const dry = expectToolOk(
        await callTool(session, "design-system-set", { ...BRAND_RECORD, dryRun: true }),
        "dry-run the brand record",
      );
      expect(dry.data.saved === false, "dry run reports saved: false");
      const ignored = (dry.data.ignoredTokens as string[] | undefined) ?? [];
      expect(ignored.includes("--shadow-sm"), `non-contract names are reported: ${ignored.join()}`);
      expect((await stateOf(ctx)).status === "declined", "a dry run saves nothing");

      // ── Active: saved over REST, previous kept for undo ─────────────────────────────────
      response = await ctx.api("PUT", "/api/design-system", { agentId: agent, body: BRAND_RECORD });
      expectStatus(response, [200], "PUT the brand record");
      const saved = asRecord(asRecord(response.json).designSystem);
      const savedTokens = asRecord(asRecord(saved.tokens).light);
      expect(
        savedTokens["--color-primary"] === "oklch(0.555 0.163 48.998)" &&
          savedTokens["--radius-xl"] === "0.75rem",
        "the importer normalized the brand tokens",
      );
      expect(saved.updatedByAgentId === agent, "the record names the writing agent");
      const active = await stateOf(ctx);
      expect(active.status === "active", "GET reports active");
      expect(asRecord(active.previous).status === "declined", "previous holds the replaced value");
      const viaTool = expectToolOk(
        await callTool(session, "design-system-get", {}),
        "design-system-get",
      );
      expect(viaTool.data.status === "active", "design-system-get reports active");

      // ── A page without theme takes the org tokens, fonts and light lock ─────────────────
      const branded = await served(ctx, first.id, "__swarm-theme=paper&__swarm-mode=dark");
      expect(branded.includes("--radius-xl: 0.75rem;"), "org tokens reach a page without theme");
      expect(!branded.includes(PAPER_BACKGROUND), "the viewer preset no longer repaints the brand");
      expect(branded.includes("Space+Grotesk:wght@300..700&amp;family"), "org fontsHref is linked");
      expect(!branded.includes(DARK_CLASS), 'mode "light" serves light to a dark viewer');

      // ── A page with its own theme ignores the design system ─────────────────────────────
      const themed = await createHtmlPage(session, `ds-themed-${ctx.nonce}`, { theme: "github" });
      expect(!themed.nudge.includes(ASK), "no ask after active");
      const themedHead = await served(ctx, themed.id, "__swarm-mode=dark");
      expect(!themedHead.includes("--radius-xl: 0.75rem;"), "a page theme ignores org tokens");
      expect(!themedHead.includes("wght@300..700"), "a page theme keeps the default fonts");
      expect(themedHead.includes(DARK_CLASS), "a page theme still follows the viewer's mode");

      // ── The seed script builds a preview without saving ────────────────────────────────
      const run = await runScript(ctx, agent, {
        name: "design-system-seed",
        args: { css: BRAND_CSS, mode: "light", fontsHref: BRAND_FONTS },
      });
      expectRunOk(run, "design-system-seed");
      const seeded = asRecord(run.result);
      expect(
        seeded.saved === false,
        `seed does not save by default: ${JSON.stringify(seeded).slice(0, 300)}`,
      );
      const previewApiUrl = asString(seeded.previewApiUrl, "preview api url");
      const preview = ctx.db.get<{
        theme: string | null;
        theme_tokens: string | null;
        authMode: string;
      }>(
        sql`SELECT theme, theme_tokens, "authMode" FROM pages WHERE id = ${previewApiUrl.slice(previewApiUrl.lastIndexOf("/") + 1)}`,
      );
      expect(
        preview?.theme === "hive" &&
          String(preview.theme_tokens).includes('"--radius-xl":"0.75rem"'),
        `the preview page carries the seeded tokens: ${JSON.stringify(preview)}`,
      );
      expect(preview?.authMode === "authed", "the preview page is not public");
      expect((await stateOf(ctx)).status === "active", "the seed left the saved record alone");
    } finally {
      // Leave no brand behind: declined styles nothing and stops the ask for later scenarios.
      await callTool(session, "design-system-set", { status: "declined" });
      await session.close();
    }
  },
};
