import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";
import { cleanupStack, putConfig, reloadConfig } from "./platform-helpers";

const PAGES = {
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};

function definition(models: number, columns: number, actions: number, columnName = "c") {
  const columnDefs = Object.fromEntries(
    Array.from({ length: columns }, (_, i) => [`${columnName}${i}`, { kind: "string" }]),
  );
  return {
    models: Object.fromEntries(
      Array.from({ length: models }, (_, i) => [`model${i}`, { columns: columnDefs }]),
    ),
    queries: {},
    actions: Object.fromEntries(
      Array.from({ length: actions }, (_, i) => [`action${i}`, { kind: "task", prompt: "go" }]),
    ),
    ...PAGES,
  };
}

/**
 * App definition caps: the defaults are 50 models, 200 columns per model and
 * 100 actions; each is a bounded per-swarm config key enforced at write time,
 * so lowering one never breaks a saved app. An app whose generated script
 * types overflow the per-app budget gets a visible warning on its write and on
 * a script-upsert that names it.
 */
export const knowledgeAppsLimits: Scenario = {
  name: "knowledge-apps-limits",
  order: 554,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-limits-owner");
    const cleanup = cleanupStack(ctx);
    const setCap = async (key: string, value: string) => {
      const row = await putConfig(ctx, { key, value });
      cleanup.add(`delete ${key}`, async () => {
        await ctx.api("DELETE", `/api/config/${asString(row.id, "config id")}`);
        await reloadConfig(ctx);
      });
      await reloadConfig(ctx);
    };
    const createApp = (name: string, body: unknown) =>
      ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: { name: `${name} ${ctx.nonce}`, definition: body },
      });
    const track = (response: { json: unknown }) => {
      const id = asString(asRecord(asRecord(response.json).app).id, "app id");
      cleanup.add(`delete app ${id}`, async () => {
        await ctx.api("DELETE", `/api/apps/${id}`);
      });
      return id;
    };
    try {
      // Past the old 10 / 40 / 20 caps, within the new defaults.
      let response = await createApp("E2E limits wide", definition(11, 41, 21));
      expectStatus(response, [201], "an app past the old caps saves");
      const wideId = track(response);
      expect(asRecord(response.json).warnings === undefined, "a default-size app keeps its types");

      response = await createApp("E2E limits over", definition(51, 1, 0));
      expectStatus(response, [400], "51 models exceed the default cap");
      expect(
        JSON.stringify(response.json).includes("must define at most 50 models"),
        "the error names the default model cap",
      );

      response = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: "APPS_MAX_MODELS", value: "1001", isSecret: false },
      });
      expectStatus(response, [400], "a cap above the bound is rejected");

      await setCap("APPS_MAX_MODELS", "2");
      response = await createApp("E2E limits lowered", definition(3, 1, 0));
      expectStatus(response, [400], "a lowered model cap applies after reload");
      expect(
        JSON.stringify(response.json).includes("must define at most 2 models"),
        "the error names the configured cap",
      );
      response = await ctx.api("GET", `/api/apps/${wideId}`);
      expectStatus(response, [200], "read the saved wide app");
      expect(
        asRecord(asRecord(response.json).app).definitionError === undefined,
        "a saved app over a lowered cap does not need repair",
      );

      // 50 x 400 columns with 40-character names renders about 1.2 MB of
      // types, past the 1 MiB per-app budget.
      await setCap("APPS_MAX_MODELS", "50");
      await setCap("APPS_MAX_COLUMNS_PER_MODEL", "400");
      response = await createApp("E2E limits huge", definition(50, 400, 0, "c".repeat(36)));
      expectStatus(response, [201], "a raised column cap admits 400 columns");
      const hugeId = track(response);
      const warnings = JSON.stringify(asRecord(response.json).warnings ?? []);
      expect(
        warnings.includes(hugeId) && warnings.includes("per-app budget"),
        `the oversized app's write warns about its types: ${warnings}`,
      );

      response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: owner,
        body: {
          name: `e2e-app-limits-${ctx.nonce}`,
          scope: "agent",
          description: "names an app without script types",
          intent: "prove the type-budget warning reaches script-upsert",
          source: `import type { ScriptContext } from "swarm-sdk";
export default async function (_args: unknown, ctx: ScriptContext) {
  return ctx.swarm.app_query({ appId: ${JSON.stringify(hugeId)}, query: "all" });
}
`,
        },
      });
      expectStatus(response, [200], "upsert a script naming the oversized app");
      const scriptWarnings = JSON.stringify(asRecord(response.json).warnings ?? []);
      expect(
        scriptWarnings.includes(hugeId) && scriptWarnings.includes("no generated script types"),
        `script-upsert warns about the untyped app: ${scriptWarnings}`,
      );
    } finally {
      await cleanup.run();
    }
  },
};
