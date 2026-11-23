import { sql } from "../db";
import { asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { repoRoot } from "../sut";
import {
  callTool,
  expectToolError,
  expectToolOk,
  type McpSession,
  registerAgent,
} from "./knowledge-helpers";

/** The kit gallery the pages skill ships; together they cover all 4 templates. */
const EXAMPLES = [
  ["kit-report-incident-review", "kit-report"],
  ["kit-one-pager-trial-result", "kit-onepager"],
  ["kit-one-pager-decision-memo", "kit-onepager"],
  ["kit-dashboard-release-health", "kit-dashboard"],
  ["kit-deck-quarterly-review", "kit-deck"],
] as const;
const PAPER_BACKGROUND = "oklch(0.973 0.004 91.446)";

type Kit = { template: string; slots: Record<string, unknown> };

async function example(name: string): Promise<Kit> {
  return (await Bun.file(
    `${repoRoot}/templates/skills/pages/files/examples/${name}.json`,
  ).json()) as Kit;
}

async function createKitPage(
  session: McpSession,
  slug: string,
  kit: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; data: Record<string, unknown> }> {
  const outcome = expectToolOk(
    await callTool(session, "create_page", {
      title: `Kit ${slug}`,
      slug,
      kit,
      authMode: "public",
      ...extra,
    }),
    `create_page kit ${slug}`,
  );
  return { id: asString(outcome.data.id, "page id"), data: outcome.data };
}

async function served(ctx: ScenarioContext, id: string, query = ""): Promise<string> {
  return (await view(ctx, id, query)).html;
}

/** One anonymous view, with whether the kit render came from the cache. */
async function view(
  ctx: ScenarioContext,
  id: string,
  query = "",
): Promise<{ html: string; kitRender: string | null }> {
  const response = await ctx.api("GET", `/p/${id}${query}`, { apiKey: null });
  expectStatus(response, [200], `serve page ${id}${query}`);
  return { html: response.text, kitRender: response.headers.get("x-swarm-kit-render") };
}

function storedKit(ctx: ScenarioContext, id: string): string | null {
  return (
    ctx.db.get<{ kit: string | null }>(sql`SELECT kit FROM pages WHERE id = ${id}`)?.kit ?? null
  );
}

export const pageKit: Scenario = {
  name: "page-kit",
  // After design-system, which leaves the org on "declined": kit pages render on the default look.
  order: 693,
  async run(ctx) {
    const agent = await registerAgent(ctx, "page-kit");
    const session = await ctx.connectMcp(agent);
    try {
      // ── Every template renders from its spec, on the theme head, with no color literal ──
      const pages: Record<string, string> = {};
      for (const [name, rootClass] of EXAMPLES) {
        const kit = await example(name);
        const page = await createKitPage(session, `${name}-${ctx.nonce}`, kit);
        expect(page.data.kitTemplate === kit.template, `${name}: result names the template`);
        expect(page.data.designVersion === 2, `${name}: kit pages are design version 2`);
        expect(page.data.colorLiteralCount === 0, `${name}: rendered with no color literal`);
        const html = await served(ctx, page.id);
        expect(
          html.includes(`class="swarm-page ${rootClass}"`) || html.includes(`class="${rootClass}"`),
          `${name}: ${rootClass} root`,
        );
        expect(
          html.includes('id="swarm-theme"') && html.includes('id="swarm-kit"'),
          `${name}: theme head and kit CSS`,
        );
        expect(html.includes("window.swarmSdk"), `${name}: the browser SDK is injected`);
        expect(
          storedKit(ctx, page.id)?.includes(`"template":"${kit.template}"`) === true,
          `${name}: spec stored`,
        );
        pages[name] = page.id;
      }
      const dashboardHtml = await served(ctx, pages["kit-dashboard-release-health"] as string);
      expect(dashboardHtml.includes("<swarm-chart"), "charts render as <swarm-chart> SVG");
      expect(
        dashboardHtml.includes("<title>14 May, Crashes per 10,000 sessions: 110</title>"),
        "every bar has a tooltip",
      );
      const deckHtml = await served(ctx, pages["kit-deck-quarterly-review"] as string);
      expect(
        deckHtml.includes('id="s7" aria-label="Slide 7 of 7"'),
        "the deck renders one section per slide",
      );
      expect(
        deckHtml.includes('"ArrowRight"') && deckHtml.includes("break-after: page"),
        "keyboard navigation and one slide per printed page",
      );

      // ── The page theme still restyles a kit page ──────────────────────────────────────
      const themed = await createKitPage(
        session,
        `kit-themed-${ctx.nonce}`,
        await example("kit-one-pager-decision-memo"),
        { theme: "paper" },
      );
      expect(
        (await served(ctx, themed.id)).includes(PAPER_BACKGROUND),
        "theme paper reaches a kit page",
      );

      // ── A repeat view serves the cached render; an edit renders again ─────────────────
      const cachedId = pages["kit-report-incident-review"] as string;
      const first = await view(ctx, cachedId);
      const repeat = await view(ctx, cachedId);
      expect(repeat.kitRender === "hit", `a repeat view is a cache hit: ${repeat.kitRender}`);
      expect(repeat.html === first.html, "a repeat view serves the same HTML");
      const edited = await example("kit-report-incident-review");
      const editedTitle = `Cache check ${ctx.nonce}`;
      (edited.slots.header as { props: { title: string } }).props.title = editedTitle;
      await createKitPage(session, `kit-report-incident-review-${ctx.nonce}`, edited);
      const afterEdit = await view(ctx, cachedId);
      expect(afterEdit.kitRender === "miss", `an edit renders again: ${afterEdit.kitRender}`);
      expect(afterEdit.html.includes(editedTitle), "the next view shows the edit");
      const afterEditRepeat = await view(ctx, cachedId);
      expect(
        afterEditRepeat.kitRender === "hit" && afterEditRepeat.html === afterEdit.html,
        "the edited render is cached",
      );

      // ── Invalid slots are rejected with their paths ───────────────────────────────────
      const report = await example("kit-report-incident-review");
      const slots = report.slots as { metrics: { props: { items: Record<string, unknown>[] } } };
      const noCompare = structuredClone(report);
      delete (noCompare.slots as typeof slots).metrics.props.items[0]?.compare;
      expectToolError(
        await callTool(session, "create_page", {
          title: "Bad",
          slug: `kit-bad-${ctx.nonce}`,
          kit: noCompare,
        }),
        "a metric without a comparison",
        "slots.metrics.props.items.0.compare",
      );
      expectToolError(
        await callTool(session, "create_page", {
          title: "Bad",
          kit: {
            template: "report",
            slots: {
              header: { type: "Header", props: { title: "x" } },
              sections: [{ type: "Section", children: [{ type: "Marquee", props: {} }] }],
            },
          },
        }),
        "an unknown component",
        "slots.sections.0.children.0",
      );
      expectToolError(
        await callTool(session, "create_page", {
          title: "Bad",
          kit: {
            template: "report",
            slots: {
              header: { type: "Header", props: { title: "x" } },
              sections: [
                {
                  type: "Section",
                  children: [{ type: "Table", props: { headers: ["a", "b"], rows: [["1"]] } }],
                },
              ],
            },
          },
        }),
        "a short table row",
        "Row has 1 cells; the table has 2 headers.",
      );
      expectToolError(
        await callTool(session, "create_page", {
          title: "Bad",
          body: "<p>x</p>",
          contentType: "text/html",
          kit: report,
        }),
        "body and kit together",
        "either body or kit",
      );
      const poster = await callTool(session, "create_page", {
        title: "Bad",
        kit: { template: "poster", slots: {} },
      });
      expect(poster.isError, "an unknown template is rejected by the input schema");

      // ── A dashboard data slot reads the owner's KV on every view ──────────────────────
      const dashboard = await example("kit-dashboard-release-health");
      const key = `release-health-${ctx.nonce}`;
      dashboard.slots.data = { key };
      const live = await createKitPage(session, `kit-live-${ctx.nonce}`, dashboard);
      const namespace = `task:agent:${agent}`;
      expect(
        live.data.dataNamespace === namespace,
        `result names the data namespace: ${String(live.data.dataNamespace)}`,
      );
      expect(
        !(await served(ctx, live.id)).includes("Live adoption"),
        "before the KV write the spec renders",
      );
      expectToolOk(
        await callTool(session, "kv-set", {
          namespace,
          key,
          value: {
            metrics: {
              type: "Metrics",
              props: { items: [{ label: "Live adoption", value: "64%", compare: "target 50%" }] },
            },
            notice: null,
          },
        }),
        "kv-set the dashboard data",
      );
      const refreshedView = await view(ctx, live.id);
      const refreshed = refreshedView.html;
      expect(refreshedView.kitRender === "miss", "a data write renders again");
      expect(refreshed.includes("Live adoption"), "the KV value replaces the metrics slot");
      const refreshedRepeat = await view(ctx, live.id);
      expect(
        refreshedRepeat.kitRender === "hit" && refreshedRepeat.html === refreshed,
        "a repeat dashboard view serves the cached render",
      );
      expect(!refreshed.includes("Android rollout is paused"), "null clears the notice slot");
      expectToolOk(
        await callTool(session, "kv-set", {
          namespace,
          key,
          value: { metrics: { type: "Metrics", props: { items: [{ label: "x", value: "1" }] } } },
        }),
        "kv-set an invalid data value",
      );
      expect(
        (await served(ctx, live.id)).includes("Android rollout is paused"),
        "an invalid data value falls back to the spec",
      );

      // ── A body write turns the page back into free HTML ───────────────────────────────
      const freeId = pages["kit-one-pager-trial-result"] as string;
      expectToolOk(
        await callTool(session, "create_page", {
          title: "Kit kit-one-pager-trial-result",
          slug: `kit-one-pager-trial-result-${ctx.nonce}`,
          body: '<!doctype html><html><head></head><body><main class="swarm-page"><h1>Free</h1></main></body></html>',
          contentType: "text/html",
          authMode: "public",
        }),
        "overwrite a kit page with a body",
      );
      expect(storedKit(ctx, freeId) === null, "the body write cleared the spec");
      const free = await served(ctx, freeId);
      expect(
        free.includes("<h1>Free</h1>") && !free.includes("kit-onepager"),
        "the free body is served",
      );
    } finally {
      await session.close();
    }
  },
};
