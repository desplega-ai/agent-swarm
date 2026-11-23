import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerAgent } from "./knowledge-helpers";

// Locks in today's substring filters on user text. Two behaviors exist:
//
// - Raw pattern (GET /api/mcp-servers?search, GET /api/schedules?name): the input is
//   wrapped in '%...%' unescaped, so '%' in the input matches any run of characters and
//   '_' matches any one character. Case folds for ASCII letters only: "AbC" finds "abc",
//   but "é" does not find "É".
// - Literal pattern (GET /api/workflows?q): '%', '_' and '\' are escaped, so they
//   match only themselves. Case still folds for ASCII letters.

type Named = { id: string; name: string };

function sameSet(actual: string[], expected: string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  expect(
    JSON.stringify(a) === JSON.stringify(e),
    `${label}: expected {${e.join(", ")}}, got {${a.join(", ")}}`,
  );
}

async function mcpServerSearch(ctx: ScenarioContext, owner: string, search: string) {
  const query = new URLSearchParams({ ownerAgentId: owner, search });
  const response = await ctx.api("GET", `/api/mcp-servers?${query}`);
  expectStatus(response, [200], `mcp-servers search "${search}"`);
  return asRecords(response.json, "servers").map((row) => asString(row.name, "server name"));
}

export const divergenceLikeCase: Scenario = {
  name: "divergence-like-case",
  order: 9_130,
  async run(ctx) {
    const owner = await registerAgent(ctx, "div-like");
    const n = ctx.nonce;
    const serverIds: string[] = [];
    const scheduleIds: string[] = [];
    const workflowIds: string[] = [];
    try {
      // ── MCP servers: raw pattern, isolated by owner ─────────────────────────────────────
      const serverNames = [
        "abc",
        "xABCx",
        "AbC-def",
        "a_c",
        "aXc",
        "100%",
        "1000",
        "Éclair",
        "éclair",
      ];
      for (const name of serverNames) {
        const response = await ctx.api("POST", "/api/mcp-servers", {
          body: { name, transport: "stdio", command: "true", scope: "agent", ownerAgentId: owner },
        });
        expectStatus(response, [201], `create mcp server "${name}"`);
        serverIds.push(asString(asRecord(asRecord(response.json).server).id, "server id"));
      }
      const serverCases: [string, string[]][] = [
        // ASCII case folds both ways.
        ["AbC", ["abc", "xABCx", "AbC-def"]],
        ["abc", ["abc", "xABCx", "AbC-def"]],
        // '_' is a one-character wildcard.
        ["a_c", ["abc", "xABCx", "AbC-def", "a_c", "aXc"]],
        // '%' is a wildcard: "100%" also finds "1000", and "%" alone finds everything.
        ["100%", ["100%", "1000"]],
        ["%", serverNames],
        // Non-ASCII letters do not fold: "é" and "É" are different characters.
        ["éclair", ["éclair"]],
        ["ÉCLAIR", ["Éclair"]],
        ["CLAIR", ["Éclair", "éclair"]],
        ["abd", []],
      ];
      for (const [search, expected] of serverCases) {
        sameSet(await mcpServerSearch(ctx, owner, search), expected, `mcp-servers "${search}"`);
      }

      // ── Schedules: raw pattern on the name; names carry the nonce ───────────────────────
      const scheduleSuffixes = ["AbC", "xabcx", "a_c", "aXc", "100%", "1000"];
      const schedules: Named[] = [];
      for (const suffix of scheduleSuffixes) {
        const name = `div-like-${n}-${suffix}`;
        const response = await ctx.api("POST", "/api/schedules", {
          body: {
            name,
            cronExpression: "0 3 1 1 *",
            taskTemplate: `divergence like ${n}`,
            targetAgentId: owner,
            enabled: false,
          },
        });
        expectStatus(response, [201], `create schedule "${name}"`);
        const id = asString(asRecord(response.json).id, "schedule id");
        scheduleIds.push(id);
        schedules.push({ id, name: suffix });
      }
      const scheduleSearch = async (name: string) => {
        const response = await ctx.api("GET", `/api/schedules?${new URLSearchParams({ name })}`);
        expectStatus(response, [200], `schedules name "${name}"`);
        const ids = asRecords(response.json, "schedules").map((row) => asString(row.id, "id"));
        return schedules.filter((s) => ids.includes(s.id)).map((s) => s.name);
      };
      const scheduleCases: [string, string[]][] = [
        [`${n}-aBc`, ["AbC"]],
        [`${n}-ABC`.toLowerCase(), ["AbC"]],
        [`${n}-a_c`, ["AbC", "a_c", "aXc"]],
        [`${n}-100%`, ["100%", "1000"]],
        [`${n}-%c`, ["AbC", "xabcx", "a_c", "aXc"]],
      ];
      for (const [search, expected] of scheduleCases) {
        sameSet(await scheduleSearch(search), expected, `schedules name "${search}"`);
      }

      // ── Workflows: literal pattern on name, description and key; names carry the nonce ──
      const workflows: Named[] = [];
      for (const suffix of scheduleSuffixes) {
        const name = `div-like-${n}-${suffix}`;
        const response = await ctx.api("POST", "/api/workflows", {
          body: {
            name,
            definition: {
              nodes: [{ id: "a", type: "script", config: { runtime: "bash", script: "echo" } }],
            },
          },
        });
        expectStatus(response, [201], `create workflow "${name}"`);
        const id = asString(asRecord(response.json).id, "workflow id");
        workflowIds.push(id);
        workflows.push({ id, name: suffix });
      }
      const workflowSearch = async (q: string) => {
        const response = await ctx.api("GET", `/api/workflows?${new URLSearchParams({ q })}`);
        expectStatus(response, [200], `workflows q "${q}"`);
        expect(Array.isArray(response.json), `workflows q "${q}": body is not an array`);
        const ids = (response.json as unknown[]).map((row) => asString(asRecord(row).id, "id"));
        return workflows.filter((w) => ids.includes(w.id)).map((w) => w.name);
      };
      const workflowCases: [string, string[]][] = [
        [`${n}-aBc`, ["AbC"]],
        [`${n.toUpperCase()}-XABCX`, ["xabcx"]],
        // Escaped: '_' and '%' match only themselves.
        [`${n}-a_c`, ["a_c"]],
        [`${n}-100%`, ["100%"]],
        [`${n}-%c`, []],
        // Substring anywhere: "abc" sits inside "xabcx".
        ["abc", ["AbC", "xabcx"]],
      ];
      for (const [q, expected] of workflowCases) {
        sameSet(await workflowSearch(q), expected, `workflows q "${q}"`);
      }
    } finally {
      for (const id of workflowIds) await ctx.api("DELETE", `/api/workflows/${id}`);
      for (const id of scheduleIds) await ctx.api("DELETE", `/api/schedules/${id}`);
      for (const id of serverIds) await ctx.api("DELETE", `/api/mcp-servers/${id}`);
    }
  },
};
