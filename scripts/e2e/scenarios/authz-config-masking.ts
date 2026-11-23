// GET /api/config/resolved?includeSecrets=true for a plain agent (own `aseph_` token) opens only
// what its worker gets in its env: its own agent-scope secrets and global secrets with
// exportToEnv=true. A global secret with exportToEnv=false, and another agent's secrets, stay
// masked. The lead and the operator are unchanged.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, registerLead, retireAgent } from "./core-helpers";
import { putConfig } from "./platform-helpers";
import { registerWorker } from "./workflow-helpers";

async function token(ctx: ScenarioContext, agentId: string): Promise<string> {
  const response = await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} });
  expectStatus(response, [200], "mint an agent token");
  return asString(asRecord(response.json).plaintext, "token plaintext");
}

export const authzConfigMasking: Scenario = {
  name: "authz-config-masking",
  order: 363,
  async run(ctx) {
    const a = await registerWorker(ctx, "mask-a");
    const b = await registerWorker(ctx, "mask-b");
    const leadId = await registerLead(ctx, "mask");
    const tokenA = await token(ctx, a);
    const tokenLead = await token(ctx, leadId);
    const prefix = `E2E_AUTHZ_MASK_${ctx.nonce.toUpperCase()}`;
    const keys = {
      hidden: `${prefix}_HIDDEN`,
      exported: `${prefix}_EXPORTED`,
      own: `${prefix}_OWN`,
      other: `${prefix}_OTHER`,
    };
    const values = {
      hidden: `hidden-${ctx.nonce}`,
      exported: `exported-${ctx.nonce}`,
      own: `own-${ctx.nonce}`,
      other: `other-${ctx.nonce}`,
    };
    const rowIds: string[] = [];
    const track = async (input: Parameters<typeof putConfig>[1]) => {
      const row = await putConfig(ctx, input);
      rowIds.push(String(row.id));
    };

    try {
      await track({ key: keys.hidden, value: values.hidden, isSecret: true, exportToEnv: false });
      await track({
        key: keys.exported,
        value: values.exported,
        isSecret: true,
        exportToEnv: true,
      });
      await track({ scope: "agent", scopeId: a, key: keys.own, value: values.own, isSecret: true });
      await track({
        scope: "agent",
        scopeId: b,
        key: keys.other,
        value: values.other,
        isSecret: true,
      });

      const read = async (apiKey: string | undefined, agentId: string) => {
        const response = await ctx.api(
          "GET",
          `/api/config/resolved?agentId=${agentId}&includeSecrets=true`,
          { apiKey },
        );
        expectStatus(response, [200], "read resolved config");
        const byKey = new Map(
          asRecords(response.json, "configs").map((row) => [String(row.key), String(row.value)]),
        );
        return byKey;
      };

      // The plain agent.
      const asA = await read(tokenA, a);
      expect(asA.get(keys.exported) === values.exported, "A reads a global exportToEnv secret");
      expect(asA.get(keys.own) === values.own, "A reads its own agent-scope secret");
      expect(
        asA.get(keys.hidden) !== undefined && asA.get(keys.hidden) !== values.hidden,
        `A must see the exportToEnv=false global secret masked, got ${asA.get(keys.hidden)}`,
      );
      expect(asA.get(keys.other) === undefined, "A's own scope holds no other agent's secret");
      // Naming another agent masks everything for A.
      const aAsB = await read(tokenA, b);
      for (const [name, value] of aAsB) {
        if (name.startsWith(prefix)) {
          expect(
            !Object.values(values).includes(value),
            `A read ${name} in another agent's scope: ${value}`,
          );
        }
      }

      // The other read paths of a plain agent: raw list, by id, the MCP tools, and a script run.
      const hiddenId = rowIds[0];
      const leaks = (text: string) =>
        [values.hidden, values.other].some((secret) => text.includes(secret));
      const byId = await ctx.api("GET", `/api/config/${hiddenId}?includeSecrets=true`, {
        apiKey: tokenA,
      });
      expectStatus(byId, [200], "A reads the unexported secret by id");
      expect(!leaks(JSON.stringify(byId.json)), "GET /api/config/{id} leaks the secret to A");
      const rawList = await ctx.api("GET", "/api/config?includeSecrets=true", { apiKey: tokenA });
      expectStatus(rawList, [200], "A lists config");
      expect(!leaks(JSON.stringify(rawList.json)), "GET /api/config leaks a secret to A");
      const mcp = await ctx.connectMcp(a, { apiKey: tokenA });
      try {
        for (const tool of ["get-config", "list-config"]) {
          const outcome = await callTool(mcp, tool, { includeSecrets: true });
          expect(!outcome.isError, `${tool} failed: ${outcome.text.slice(0, 200)}`);
          expect(!leaks(outcome.text), `${tool} leaks a secret to A`);
          expect(!leaks(JSON.stringify(outcome.data)), `${tool} leaks a secret to A in data`);
        }
      } finally {
        await mcp.close();
      }
      const scriptRun = await ctx.api("POST", "/api/scripts/run", {
        apiKey: tokenA,
        agentId: a,
        body: {
          source: `export default async function (args: any, ctx: any) {
            const read = (key: string) => {
              const entry = ctx.swarm.config.get(key);
              return entry ? ctx.stdlib.Redacted.value(entry) : undefined;
            };
            return {
              hiddenMasked: read(${JSON.stringify(keys.hidden)}) === "********",
              exportedOpen: read(${JSON.stringify(keys.exported)}) === args.exported,
              ownOpen: read(${JSON.stringify(keys.own)}) === args.own,
            };
          }`,
          args: { exported: values.exported, own: values.own },
          intent: "e2e config masking",
        },
      });
      expectStatus(scriptRun, [200], "A runs a script that reads config");
      const scriptResult = asRecord(asRecord(scriptRun.json).result);
      expect(
        scriptResult.hiddenMasked === true &&
          scriptResult.exportedOpen === true &&
          scriptResult.ownOpen === true,
        `A's script run userConfig: ${JSON.stringify(asRecord(scriptRun.json)).slice(0, 400)}`,
      );

      // The lead and the operator are unchanged.
      for (const [label, apiKey] of [
        ["lead", tokenLead],
        ["operator", undefined],
      ] as const) {
        const seen = await read(apiKey, a);
        expect(seen.get(keys.hidden) === values.hidden, `${label} reads the unexported secret`);
        expect(seen.get(keys.exported) === values.exported, `${label} reads the exported secret`);
        expect(seen.get(keys.own) === values.own, `${label} reads A's agent-scope secret`);
      }
    } finally {
      for (const id of rowIds) await ctx.api("DELETE", `/api/config/${id}`);
      await retireAgent(ctx, leadId);
    }
  },
};
