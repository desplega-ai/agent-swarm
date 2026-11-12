import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";

/** More rows than one list scan window (2,000), so a list spans three windows. */
const ROWS = 5_200;
const BUCKETS = 7;

/**
 * A row list walks the model in key windows. Every row must come back once
 * and a filter must hold across window edges (ids are random, so the edges
 * fall at arbitrary rows).
 */
export const knowledgeAppsLargeModel: Scenario = {
  name: "knowledge-apps-large-model",
  order: 551,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-large-owner");
    const created = await ctx.api("POST", "/api/apps", {
      agentId: owner,
      body: {
        name: `E2E large model ${ctx.nonce}`,
        description: "list scan windows",
        definition: {
          models: { item: { columns: { n: { kind: "number" }, bucket: { kind: "string" } } } },
          queries: {},
          actions: {},
          pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
          defaultPage: "main",
        },
      },
    });
    expectStatus(created, [201], "create the app");
    const appId = asString(asRecord(asRecord(created.json).app).id, "app id");
    try {
      for (let start = 0; start < ROWS; start += 500) {
        const rows = Array.from({ length: Math.min(500, ROWS - start) }, (_, i) => ({
          values: { n: start + i, bucket: `b${(start + i) % BUCKETS}` },
        }));
        const bulk = await ctx.api("POST", `/api/apps/${appId}/models/item/rows/bulk`, {
          body: { rows },
        });
        expectStatus(bulk, [200], "bulk create rows");
      }
      const rowsPath = `/api/apps/${appId}/models/item/rows`;

      let response = await ctx.api("GET", `${rowsPath}?limit=1`);
      expectStatus(response, [200], "list all rows");
      expect(asRecord(response.json).total === ROWS, "an unfiltered list returns every row once");

      const inBucket = Array.from({ length: ROWS }, (_, n) => n).filter(
        (n) => n % BUCKETS === 3,
      ).length;
      response = await ctx.api("GET", `${rowsPath}?filter.bucket=b3&limit=1000`);
      expectStatus(response, [200], "list a filtered bucket");
      expect(asRecord(response.json).total === inBucket, "a filter holds across scan windows");

      response = await ctx.api("GET", `${rowsPath}?sort=n:desc&limit=3`);
      expect(
        asRecords(response.json, "rows")
          .map((row) => row.n)
          .join() === `${ROWS - 1},${ROWS - 2},${ROWS - 3}`,
        "the sort sees rows from every window",
      );
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
