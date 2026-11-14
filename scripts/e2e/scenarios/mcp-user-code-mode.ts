import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { createUser } from "./core-helpers";
import { getLead, toolText, upsertScript } from "./script-helpers";

// Code mode on /mcp-user: script-search, script-get-types and script-run run as the
// requesting user. A run has no agent identity (its ctx.swarm calls send no X-Agent-ID),
// records a script_runs row for the user, and its short-lived token stays off the user's
// token list. A viewer, who holds neither script.search nor script.run, is refused both.

const DOUBLER = `export default async function (args: { n: number }) {
  return { doubled: args.n * 2 };
}`;

// ctx.swarm.agent_info is GET /me, which needs an agent. A 400 "Missing X-Agent-ID" means
// the run's token authenticated (not 401) and named no agent (a user token naming one is 403).
const WHOAMI = `export default async function (_args: unknown, ctx: any) {
  return await ctx.swarm.agent_info({});
}`;

async function connectUser(ctx: ScenarioContext, userId: string): Promise<Client> {
  const minted = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, {
    body: { label: `code mode e2e ${ctx.nonce}` },
  });
  expectStatus(minted, [200], "mint user MCP token");
  const client = new Client({ name: "agent-swarm-e2e-code-mode", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp-user`), {
      requestInit: {
        headers: { Authorization: `Bearer ${String(asRecord(minted.json).plaintext)}` },
      },
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = asRecord(await client.callTool({ name, arguments: args }));
  const structured = asRecord(result.structuredContent);
  return {
    isError: result.isError === true,
    text: toolText(result),
    // structuredContent carries { status, data } with data the scripts API body.
    body: (structured.data ?? {}) as Record<string, unknown>,
  };
}

export const mcpUserCodeMode: Scenario = {
  name: "mcp-user-code-mode",
  order: 492,
  async run(ctx) {
    const lead = await getLead(ctx);
    const scriptName = `e2e-user-code-mode-${ctx.nonce}`;
    await upsertScript(ctx, lead, {
      name: scriptName,
      scope: "global",
      source: DOUBLER,
      description: `Doubles a number (${ctx.nonce})`,
      intent: "e2e user MCP code mode",
    });

    const userId = await createUser(ctx, "code-mode-admin");
    const admin = await connectUser(ctx, userId);
    try {
      const search = await call(admin, "script-search", { query: scriptName });
      expect(!search.isError, `script-search failed: ${search.text.slice(0, 300)}`);
      const names = asRecords(search.body, "results").map((r) => r.name);
      expect(names.includes(scriptName), `script-search finds the global script, got ${names}`);

      const typed = await call(admin, "script-get-types", { name: scriptName });
      const typedBody = typed.body;
      expect(!typed.isError, `script-get-types failed: ${typed.text.slice(0, 300)}`);
      expect(
        typedBody.signature !== undefined,
        `script-get-types returns the signature, got ${typed.text.slice(0, 300)}`,
      );
      expect(
        typed.text.includes('declare module "swarm-sdk"') &&
          typed.text.includes('declare module "stdlib"') &&
          // The whole surface is ~45 KB; a spilled result is a ~10 KB preview.
          typed.text.length > 30_000,
        "script-get-types returns both modules whole",
      );
      const missing = await call(admin, "script-get-types", { name: `none-${ctx.nonce}` });
      expect(missing.isError && missing.text.includes("Script not found"), "unknown script 404s");

      const named = await call(admin, "script-run", { name: scriptName, args: { n: 21 } });
      expect(!named.isError, `named script-run failed: ${named.text.slice(0, 300)}`);
      expect(
        asRecord(named.body.result).doubled === 42,
        `named run returns its result, got ${named.text.slice(0, 300)}`,
      );

      const whoami = await call(admin, "script-run", { source: WHOAMI });
      const whoamiResult = asRecord(whoami.body.result);
      expect(!whoami.isError, `inline script-run failed: ${whoami.text.slice(0, 300)}`);
      expect(
        whoamiResult.status === 400 &&
          String(asRecord(whoamiResult.data).error).includes("X-Agent-ID"),
        `a user run carries no agent identity, got ${JSON.stringify(whoamiResult).slice(0, 300)}`,
      );

      const both = await call(admin, "script-run", { name: scriptName, source: DOUBLER });
      expect(both.isError && both.text.includes("exactly one"), "name plus source is refused");

      const runs = await ctx.api(
        "GET",
        `/api/script-runs?agentId=user-mcp&scriptName=${encodeURIComponent(scriptName)}`,
      );
      expectStatus(runs, [200], "list user MCP script runs");
      const rows = asRecords(runs.json, "runs");
      expect(
        rows.length === 1 &&
          rows[0]?.requestedByUserId === userId &&
          rows[0]?.status === "completed",
        `one completed run recorded for the user, got ${JSON.stringify(rows).slice(0, 400)}`,
      );

      const user = await ctx.api("GET", `/api/users/${userId}`);
      expectStatus(user, [200], "get code mode user");
      const tokens = asRecords(asRecord(asRecord(user.json).user), "tokens");
      expect(
        tokens.length === 1 && tokens[0]?.revokedAt === null,
        `run tokens stay off the list and the MCP token stays live, got ${tokens.length}`,
      );
    } finally {
      await admin.close();
    }

    const viewerId = await createUser(ctx, "code-mode-viewer");
    const demoted = await ctx.api("PUT", `/api/users/${viewerId}/roles`, {
      body: { roles: ["viewer"] },
    });
    expectStatus(demoted, [200], "make the user a viewer");
    const viewer = await connectUser(ctx, viewerId);
    try {
      const run = await call(viewer, "script-run", { name: scriptName, args: { n: 1 } });
      expect(
        run.isError && run.text.includes("script.run"),
        `a viewer cannot run scripts, got ${run.text.slice(0, 300)}`,
      );
      const search = await call(viewer, "script-search", { query: scriptName });
      expect(
        search.isError && search.text.includes("script.search"),
        `a viewer cannot search scripts, got ${search.text.slice(0, 300)}`,
      );
      const types = await call(viewer, "script-get-types", {});
      expect(!types.isError, `a viewer can read the types, got ${types.text.slice(0, 300)}`);
    } finally {
      await viewer.close();
    }
  },
};
