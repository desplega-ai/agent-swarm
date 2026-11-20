import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";

// Locks in today's order of text sorts: plain byte (code point) order, not a locale
// collation. Digits sort before uppercase, uppercase before '_', '_' before lowercase,
// and a non-ASCII letter after all of them. "10" sorts before "9" (no numeric sort),
// and "B" and "Z" sort before "a" (no case folding).
//
// Surfaces: GET /api/mcp-servers (ORDER BY name) and GET /api/kv/_/{namespace}
// (ORDER BY key, and a prefix filter that is a case-sensitive key range).

function sameOrder(actual: string[], expected: string[], label: string): void {
  expect(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
  );
}

export const divergenceTextOrder: Scenario = {
  name: "divergence-text-order",
  order: 9_140,
  async run(ctx) {
    const owner = await registerAgent(ctx, "div-order");
    const namespace = `e2e-div-order-${ctx.nonce}`;
    const serverIds: string[] = [];
    const kvKeys: string[] = [];
    try {
      // ── MCP servers by name ─────────────────────────────────────────────────────────────
      const names = ["B", "a", "_x", "Z", "é", "10", "9"];
      for (const name of names) {
        const response = await ctx.api("POST", "/api/mcp-servers", {
          body: { name, transport: "stdio", command: "true", scope: "agent", ownerAgentId: owner },
        });
        expectStatus(response, [201], `create mcp server "${name}"`);
        serverIds.push(asString(asRecord(asRecord(response.json).server).id, "server id"));
      }
      const listed = await ctx.api(
        "GET",
        `/api/mcp-servers?${new URLSearchParams({ ownerAgentId: owner })}`,
      );
      expectStatus(listed, [200], "list mcp servers");
      sameOrder(
        asRecords(listed.json, "servers").map((row) => asString(row.name, "server name")),
        ["10", "9", "B", "Z", "_x", "a", "é"],
        "GET /api/mcp-servers order",
      );

      // ── KV keys (the key alphabet has no non-ASCII letter) ──────────────────────────────
      const keys = ["B", "a", "_x", "Z", "10", "9", "b2", "Ba", ":z", "-x", ".y"];
      for (const key of keys) {
        const response = await ctx.api("PUT", `/api/kv/_/${namespace}/${encodeURIComponent(key)}`, {
          body: { value: key },
        });
        expectStatus(response, [200], `put kv "${key}"`);
        kvKeys.push(key);
      }
      const kvList = async (prefix?: string) => {
        const query = prefix === undefined ? "" : `?${new URLSearchParams({ prefix })}`;
        const response = await ctx.api("GET", `/api/kv/_/${namespace}${query}`);
        expectStatus(response, [200], `list kv prefix ${prefix ?? "(none)"}`);
        return asRecords(response.json, "entries").map((row) => asString(row.key, "kv key"));
      };
      sameOrder(
        await kvList(),
        ["-x", ".y", "10", "9", ":z", "B", "Ba", "Z", "_x", "a", "b2"],
        "GET /api/kv/_/{namespace} order",
      );
      // The prefix is a key range, so it keeps case: "B" does not find "b2".
      sameOrder(await kvList("B"), ["B", "Ba"], "kv prefix B");
      sameOrder(await kvList("b"), ["b2"], "kv prefix b");
      sameOrder(await kvList("1"), ["10"], "kv prefix 1");
    } finally {
      for (const key of kvKeys) {
        await ctx.api("DELETE", `/api/kv/_/${namespace}/${encodeURIComponent(key)}`);
      }
      for (const id of serverIds) await ctx.api("DELETE", `/api/mcp-servers/${id}`);
    }
  },
};
