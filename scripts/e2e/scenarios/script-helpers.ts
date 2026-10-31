// Shared helpers for the script-* scenarios (order band 400-499). Black box: HTTP, MCP and
// the read-only database handle only. Not a scenario: listed in NON_SCENARIO_FILES.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { ScenarioContext } from "../run";

/** Register a worker (or a lead) and return its id. The name carries the run nonce. */
export async function registerAgent(
  ctx: ScenarioContext,
  label: string,
  options: { lead?: boolean } = {},
): Promise<string> {
  const name = `e2e-script-${label}-${ctx.nonce}`;
  const response = await ctx.api("POST", "/api/agents", {
    body: options.lead ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register ${label} agent`);
  return asString(asRecord(response.json).id, `${label} agent id`);
}

/** `POST /api/scripts/run` that must answer 200. Returns the run envelope. */
export async function runScript(
  ctx: ScenarioContext,
  agentId: string,
  body: Record<string, unknown>,
  label = "script run",
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/scripts/run", { agentId, body });
  expectStatus(response, [200], label);
  return asRecord(response.json);
}

/** A run envelope that must be a clean success. */
export function expectRunOk(run: Record<string, unknown>, label: string): void {
  expect(
    run.exitCode === 0 && run.error === undefined && run.runtimeError === undefined,
    `${label}: expected a clean run, got ${JSON.stringify(run).slice(0, 500)}`,
  );
}

/** Text of an MCP tool result (all text content blocks joined). */
export function toolText(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const block = asRecord(item);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .join("\n");
}

/** Call a tool and require `isError !== true`. Returns the raw result record. */
export async function callToolOk(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = asRecord(await connection.callTool(name, args));
  expect(result.isError !== true, `${name} returned isError: ${toolText(result).slice(0, 400)}`);
  return result;
}

/** Call a tool and require `isError === true`. Returns the raw result record. */
export async function callToolErr(
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = asRecord(await connection.callTool(name, args));
  expect(result.isError === true, `${name} should have failed but returned ok`);
  return result;
}

/** `structuredContent` of a tool result. */
export function structured(result: unknown): Record<string, unknown> {
  return asRecord(asRecord(result).structuredContent);
}

/** Open an MCP session as `agentId`, run `fn`, always close it. */
export async function withMcp<T>(
  ctx: ScenarioContext,
  agentId: string,
  fn: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const connection = await ctx.connectMcp(agentId);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

/** Save a typechecked script over the HTTP API and return its id (via the list route). */
export async function upsertScript(
  ctx: ScenarioContext,
  agentId: string,
  body: { name: string; source: string } & Record<string, unknown>,
): Promise<{ id: string; version: number; contentDeduped: boolean }> {
  const response = await ctx.api("POST", "/api/scripts/upsert", { agentId, body });
  expectStatus(response, [200], `upsert script ${body.name}`);
  const saved = asRecord(response.json);
  const id = await findScriptId(
    ctx,
    body.name,
    agentId,
    body.scope === "global" ? "global" : "agent",
  );
  return {
    id,
    version: Number(saved.version),
    contentDeduped: saved.contentDeduped === true,
  };
}

/** Look a saved script up in `GET /api/scripts` by name and scope owner. */
export async function findScriptId(
  ctx: ScenarioContext,
  name: string,
  agentId: string,
  scope: "agent" | "global",
): Promise<string> {
  const listed = await ctx.api("GET", `/api/scripts?scope=${scope}&includeScratch=true`);
  expectStatus(listed, [200], "list scripts");
  const scripts = asRecord(listed.json).scripts;
  expect(Array.isArray(scripts), "script list has no scripts array");
  const found = scripts
    .map(asRecord)
    .find((script) => script.name === name && (scope === "global" || script.scopeId === agentId));
  expect(found, `script ${name} (${scope}) is not in GET /api/scripts`);
  return asString(found.id, `script ${name} id`);
}

export type Stub = {
  origin: string;
  hostname: string;
  port: number;
  /** Every request the stub received, oldest first. */
  seen: Array<{ method: string; path: string; headers: Record<string, string>; body: string }>;
  stop: () => void;
};

/**
 * A loopback HTTP stub the SUT can reach. NODE_ENV=test lets the API's outbound guards talk
 * to loopback, so connections, MCP servers and script `fetch` can target this server.
 */
export function startStub(
  handler: (request: Request, body: string) => Response | Promise<Response>,
): Stub {
  const seen: Stub["seen"] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers.entries()),
        body,
      });
      return handler(request, body);
    },
  });
  const port = server.port ?? 0;
  return {
    origin: `http://127.0.0.1:${port}`,
    hostname: "127.0.0.1",
    port,
    seen,
    stop: () => {
      void server.stop(true);
    },
  };
}
