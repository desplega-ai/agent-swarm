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
          models: {
            item: { columns: { n: { kind: "number" }, bucket: { kind: "string", index: true } } },
          },
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

      // `bucket` is indexed, so these filters read index keys instead of scanning.
      const idsOf = async (query: string) => {
        const res = await ctx.api("GET", `${rowsPath}?${query}&limit=1000`);
        expectStatus(res, [200], `list ${query}`);
        return asRecords(res.json, "rows")
          .map((row) => asString(row.id, "row id"))
          .sort();
      };
      expect((await idsOf("filter.bucket=nope")).length === 0, "an unused indexed value is empty");

      // Values past 128 chars share one index bucket; the exact re-check splits them.
      const longA = `${"x".repeat(130)}a`;
      const longB = `${"x".repeat(130)}b`;
      const bulk = await ctx.api("POST", `${rowsPath}/bulk`, {
        body: {
          rows: [{ values: { n: -1, bucket: longA } }, { values: { n: -2, bucket: longB } }],
        },
      });
      expectStatus(bulk, [200], "create long-value rows");
      response = await ctx.api("GET", `${rowsPath}?filter.bucket=${longA}&limit=10`);
      expect(
        asRecords(response.json, "rows")
          .map((row) => row.n)
          .join() === "-1",
        "a truncated index bucket returns only the exact match",
      );

      // A patch moves the row to its new bucket; a delete drops it.
      const [movedId] = await idsOf(`filter.bucket=${longA}`);
      response = await ctx.api("PATCH", `${rowsPath}/${movedId}`, {
        body: { values: { bucket: "moved" } },
      });
      expectStatus(response, [200], "patch the indexed column");
      expect((await idsOf(`filter.bucket=${longA}`)).length === 0, "old bucket loses the row");
      expect((await idsOf("filter.bucket=moved")).join() === movedId, "new bucket has the row");
      response = await ctx.api("DELETE", `${rowsPath}/${movedId}`);
      expectStatus(response, [200, 204], "delete the row");
      expect((await idsOf("filter.bucket=moved")).length === 0, "a deleted row leaves the index");
      expect(
        (await idsOf("filter.bucket=b3")).length === inBucket,
        "a bucket list is unchanged by the other writes",
      );
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
