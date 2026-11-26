import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";
import { callToolErr, structured, withMcp } from "./script-helpers";

const NODES = 1000;
const LONG_ID = "k".repeat(4_000);
const LONG_TOKEN = "z".repeat(100_000);
// Unbounded scoring took ~4 s for one such call on a dev box; the bounded helper takes milliseconds.
const BUDGET_MS = 2_000;

/**
 * The closest-key suggestions on a missed `app-get {path}` and on an `app-patch-node` miss score
 * caller-controlled tokens against stored keys on the shared API event loop. A 100 KB token
 * against a 1000-node page with one 4 KB node id must answer within the budget, and ordinary
 * typos must still name the right key.
 */
export const knowledgeAppsClosestBounds: Scenario = {
  name: "knowledge-apps-closest-bounds",
  order: 558.6,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-closest-bounds-owner");
    const ids = [...Array.from({ length: NODES }, (_, i) => `node_${i}`), LONG_ID];
    const elements: Record<string, unknown> = Object.fromEntries(
      ids.map((id) => [id, { type: "Text", props: { content: "x" } }]),
    );
    elements.root = { type: "Stack", children: ids };
    const created = await ctx.api("POST", "/api/apps", {
      agentId: owner,
      body: {
        name: `E2E closest bounds ${ctx.nonce}`,
        definition: {
          models: {},
          defaultPage: "main",
          pages: { main: { root: "root", elements } },
        },
      },
    });
    expectStatus(created, [201], "create the 1000-node fixture app");
    const appId = asString(asRecord(asRecord(created.json).app).id, "app id");
    try {
      await withMcp(ctx, owner, async (mcp) => {
        const slow: string[] = [];
        const timedMiss = async (label: string, tool: string, args: Record<string, unknown>) => {
          const started = performance.now();
          const result = await callToolErr(mcp, tool, { appId, ...args });
          const ms = Math.round(performance.now() - started);
          ctx.log(`${label} duration_ms=${ms}`);
          if (ms >= BUDGET_MS) slow.push(`${label} ${ms} ms`);
          return (structured(result).closest as string[] | undefined) ?? [];
        };

        // ── a 100 KB token is bounded on every suggestion path ──
        const misses: Array<[string, string, Record<string, unknown>]> = [
          ["app-get path", "app-get", { path: `pages.main.elements.${LONG_TOKEN}` }],
          [
            "app-patch-node nodeId",
            "app-patch-node",
            { page: "main", nodeId: LONG_TOKEN, props: { content: "y" } },
          ],
          [
            "app-patch-node parentId",
            "app-patch-node",
            {
              page: "main",
              nodeId: "fresh",
              create: { parentId: LONG_TOKEN, node: { type: "Text", props: { content: "y" } } },
            },
          ],
          [
            "app-patch-node page",
            "app-patch-node",
            { page: LONG_TOKEN, nodeId: "node_1", props: { content: "y" } },
          ],
        ];
        for (const [label, tool, args] of misses) {
          const closest = await timedMiss(label, tool, args);
          expect(closest.length <= 5, `${label} names at most 5 keys (${closest.length})`);
        }
        // Every path is timed before failing, so one run names each unbounded entry point.
        expect(slow.length === 0, `each miss answers within ${BUDGET_MS} ms: ${slow.join(", ")}`);

        // ── ordinary typos still name the right key, long keys included ──
        let closest = await timedMiss("app-get typo", "app-get", {
          path: "pages.main.elements.node_42x",
        });
        expect(closest[0] === "node_42", `a path typo names node_42 first: ${closest}`);
        closest = await timedMiss("app-patch-node typo", "app-patch-node", {
          page: "main",
          nodeId: "nod_7",
          props: { content: "y" },
        });
        expect(closest[0] === "node_7", `a node id typo names node_7 first: ${closest}`);
        closest = await timedMiss("app-patch-node parent typo", "app-patch-node", {
          page: "main",
          nodeId: "fresh",
          create: { parentId: "rooot", node: { type: "Text", props: { content: "y" } } },
        });
        expect(closest[0] === "root", `a parent id typo names root first: ${closest}`);
        closest = await timedMiss("app-get long key", "app-get", {
          path: "pages.main.elements.kkkkkkkk",
        });
        expect(
          closest[0] === LONG_ID,
          `a prefix of a 4 KB node id still names that id first: ${closest.map((c) => c.slice(0, 20))}`,
        );
        closest = await timedMiss("app-patch-node page typo", "app-patch-node", {
          page: "mian",
          nodeId: "node_1",
          props: { content: "y" },
        });
        expect(closest[0] === "main", `a page typo names main: ${closest}`);
        expect(slow.length === 0, `typo lookups answer within ${BUDGET_MS} ms: ${slow.join(", ")}`);
      });
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`, { agentId: owner });
    }
  },
};
