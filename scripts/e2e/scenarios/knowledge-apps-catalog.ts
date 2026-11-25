import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";
import { callToolErr, callToolOk, structured, toolText, withMcp } from "./script-helpers";

/**
 * What one tool call costs an agent: a harness reads one channel (text or structured), so the
 * larger of the two. A spilled result (over the 10 KB wire limit) fails here instead.
 */
function channelBytes(result: Record<string, unknown>, label: string): number {
  expect(structured(result).truncation === undefined, `${label} did not spill to KV`);
  const encoder = new TextEncoder();
  return Math.max(
    encoder.encode(toolText(result)).length,
    encoder.encode(JSON.stringify(structured(result))).length,
  );
}

/**
 * `app-catalog` answers "what may I put on a page" from the catalog the server validates
 * against, so an agent reads one bounded response instead of the dashboard source. `app-get`
 * points at the app's agent-fs sources folder.
 */
export const knowledgeAppsCatalog: Scenario = {
  name: "knowledge-apps-catalog",
  order: 558.6,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-catalog-owner");
    await withMcp(ctx, owner, async (mcp) => {
      // ── the index: every component with one line and its slots, under 6 KB ──
      let result = await callToolOk(mcp, "app-catalog", {});
      const indexBytes = channelBytes(result, "index");
      const components = asRecord(structured(result).components);
      const names = Object.keys(components);
      ctx.log(`index_bytes=${indexBytes} components=${names.length}`);
      expect(indexBytes <= 6_000, `the index is at most 6 KB (${indexBytes})`);
      expect(
        names.includes("Chart") && JSON.stringify(components.Stack).includes('["default"]'),
        `the index lists components with slots: ${JSON.stringify(components.Stack)}`,
      );
      expect(
        Object.keys(asRecord(structured(result).actions)).includes("app.mutate"),
        "the index lists action types",
      );

      // ── every component fits one bounded response ──
      let largest = 0;
      for (const name of names) {
        result = await callToolOk(mcp, "app-catalog", { component: name });
        const size = channelBytes(result, name);
        largest = Math.max(largest, size);
        expect(size <= 10_000, `component ${name} is at most 10 KB (${size})`);
        expect(structured(result).props !== undefined, `component ${name} returns its props`);
      }
      ctx.log(`largest_component_bytes=${largest}`);
      result = await callToolOk(mcp, "app-catalog", { component: "Chart" });
      const chartProps = JSON.stringify(structured(result).props);
      expect(
        chartProps.includes('"series"') && !chartProps.includes("$schema"),
        "a component returns its compact props schema",
      );
      result = await callToolOk(mcp, "app-catalog", { component: "Table", prop: "columns" });
      expect(
        JSON.stringify(structured(result).schema).includes('"kind"'),
        "prop drills into one prop's schema",
      );
      result = await callToolOk(mcp, "app-catalog", { action: "app.mutate" });
      expect(
        JSON.stringify(structured(result).params).includes('"op"'),
        "an action returns its params",
      );

      // ── a miss names the closest 3 ──
      result = await callToolErr(mcp, "app-catalog", { component: "Chrat" });
      const closest = structured(result).closest as string[] | undefined;
      expect(
        closest?.length === 3 && closest[0] === "Chart",
        `an unknown component names the closest 3: ${JSON.stringify(closest)}`,
      );
      await callToolErr(mcp, "app-catalog", { component: "Nope" });

      // ── one call answers the binding questions ($param, everyMs/watch, page params, date) ──
      result = await callToolOk(mcp, "app-catalog", { topic: "expressions" });
      const reference = asString(structured(result).content, "expressions reference");
      for (const answer of [
        "/route/params",
        '{ "$param": "<name>" }',
        "everyMs",
        "watch",
        "pages.<p>.params.<name>",
        "There is no `date` param kind",
      ]) {
        expect(reference.includes(answer), `the expressions reference answers "${answer}"`);
      }
      expect(channelBytes(result, "expressions") <= 6_000, "the reference is small");

      // ── app-get points at the sources folder ──
      const created = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: {
          name: `E2E catalog ${ctx.nonce}`,
          definition: {
            models: {},
            pages: { main: { root: "t", elements: { t: { type: "Text", props: { content: "x" } } } } },
            defaultPage: "main",
          },
        },
      });
      expectStatus(created, [201], "create an app");
      const appId = asString(asRecord(asRecord(created.json).app).id, "app id");
      try {
        result = await callToolOk(mcp, "app-get", { appId });
        expect(
          structured(result).sourcesPath === `shared/app:${appId}/src/`,
          `app-get returns sourcesPath: ${JSON.stringify(structured(result).sourcesPath)}`,
        );
        expect(toolText(result).includes(`Sources: shared/app:${appId}/src/`), "and says so in text");
      } finally {
        await ctx.api("DELETE", `/api/apps/${appId}`, { agentId: owner });
      }
    });

    // ── the REST twin ──
    let response = await ctx.api("GET", "/api/apps/catalog?component=Chart", { agentId: owner });
    expectStatus(response, [200], "GET catalog component");
    expect(asRecord(response.json).component === "Chart", "REST returns the component");
    response = await ctx.api("GET", "/api/apps/catalog?topic=expressions", { agentId: owner });
    expectStatus(response, [200], "GET catalog topic");
    response = await ctx.api("GET", "/api/apps/catalog?component=Nope", { agentId: owner });
    expectStatus(response, [404], "GET an unknown component");
    response = await ctx.api("GET", "/api/apps/catalog?component=Chart&action=app.mutate", {
      agentId: owner,
    });
    expectStatus(response, [400], "GET with two selectors");
  },
};
