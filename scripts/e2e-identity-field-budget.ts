#!/usr/bin/env bun
/**
 * Identity-field budget gate E2E.
 *
 * Boots the real HTTP/MCP server on a free port with a throwaway SQLite DB,
 * drives the ratchet through both REST and MCP update-profile, and asserts
 * every outcome by re-reading the persisted agent row.
 *
 * Run from the repository root:
 *   bun scripts/e2e-identity-field-budget.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { McpHttpClient } from "../src/mcp-client/http-client";

const API_KEY = "identity-field-budget-e2e-key";
const HTTP_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MCP_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOUL_BUDGET = 10_000;
const IDENTITY_BUDGET = 10_000;
const BOOTSTRAP_BUDGET = 20_000;

type AgentRow = {
  id: string;
  name: string;
  description?: string;
  soulMd?: string;
  identityMd?: string;
  claudeMd?: string;
  toolsMd?: string;
  heartbeatMd?: string;
};

type WriteResult = { accepted: boolean; detail: string };

const probe = Bun.serve({ port: 0, fetch: () => new Response("port probe") });
const port = probe.port;
probe.stop(true);

const baseUrl = `http://127.0.0.1:${port}`;
const tmpDir = `/tmp/identity-field-budget-e2e-${crypto.randomUUID()}`;
await Bun.$`mkdir -p ${tmpDir}`.quiet();
const dbPath = join(tmpDir, "db.sqlite");
const logPath = join(tmpDir, "server.log");
const logWriter = Bun.file(logPath).writer();
const server = Bun.spawn(["bun", "run", "start:http"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    MCP_BASE_URL: baseUrl,
    DATABASE_PATH: dbPath,
    AGENT_SWARM_API_KEY: API_KEY,
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    JIRA_DISABLE: "true",
    LINEAR_DISABLE: "true",
  },
  stdout: "pipe",
  stderr: "pipe",
});

(async () => {
  for await (const chunk of server.stdout) logWriter.write(chunk);
})().catch(() => {});
(async () => {
  for await (const chunk of server.stderr) logWriter.write(chunk);
})().catch(() => {});

let passed = 0;
let failed = 0;

function report(ok: boolean, surface: string, scenario: string, detail?: string): void {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${surface} | ${scenario}${detail ? ` | ${detail}` : ""}`);
}

async function request(
  method: string,
  path: string,
  options: { agentId?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (options.agentId) headers["X-Agent-ID"] = options.agentId;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await request("GET", "/health")).status === 200) return;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error("local API did not become ready within 30 seconds");
}

async function registerAgent(agentId: string, name: string): Promise<void> {
  const result = await request("POST", "/api/agents", {
    agentId,
    body: { name, isLead: false },
  });
  if (result.status !== 201) {
    throw new Error(
      `agent registration failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
}

async function readAgent(agentId: string): Promise<AgentRow> {
  const result = await request("GET", `/api/agents/${agentId}`);
  if (result.status !== 200) {
    throw new Error(`agent read failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body as AgentRow;
}

function seedLegacyOversize(agentId: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE agents SET claudeMd = ?, toolsMd = ? WHERE id = ?").run(
      "c".repeat(BOOTSTRAP_BUDGET + 10),
      "t".repeat(BOOTSTRAP_BUDGET + 5),
      agentId,
    );
  } finally {
    db.close();
  }
}

async function runMatrix(
  surface: string,
  agentId: string,
  write: (updates: Record<string, unknown>) => Promise<WriteResult>,
): Promise<void> {
  const positive = await write({ description: `${surface} positive control` });
  let row = await readAgent(agentId);
  report(
    positive.accepted && row.description === `${surface} positive control`,
    surface,
    "positive control: ordinary profile write accepted",
    positive.detail,
  );

  const withinSoul = "s".repeat(SOUL_BUDGET);
  const within = await write({ soulMd: withinSoul });
  row = await readAgent(agentId);
  report(
    within.accepted && row.soulMd === withinSoul,
    surface,
    "within-budget soulMd write accepted",
    within.detail,
  );

  const identityBaseline = "i".repeat(IDENTITY_BUDGET - 1);
  const baseline = await write({ identityMd: identityBaseline });
  if (!baseline.accepted) throw new Error(`${surface} identity baseline write failed`);
  const crossing = await write({ identityMd: "x".repeat(IDENTITY_BUDGET + 1) });
  row = await readAgent(agentId);
  report(
    !crossing.accepted && row.identityMd === identityBaseline,
    surface,
    "growth crossing identityMd budget rejected; row unchanged",
    crossing.detail,
  );

  seedLegacyOversize(agentId);
  row = await readAgent(agentId);
  if (
    row.claudeMd?.length !== BOOTSTRAP_BUDGET + 10 ||
    row.toolsMd?.length !== BOOTSTRAP_BUDGET + 5
  ) {
    throw new Error(`${surface} legacy oversize setup did not persist`);
  }

  const overBudgetClaude = row.claudeMd;
  const growth = await write({ claudeMd: `${overBudgetClaude}g` });
  row = await readAgent(agentId);
  report(
    !growth.accepted && row.claudeMd === overBudgetClaude,
    surface,
    "growth on already-over-budget claudeMd rejected; row unchanged",
    growth.detail,
  );

  const shrunkClaude = "q".repeat(BOOTSTRAP_BUDGET + 9);
  const shrink = await write({ claudeMd: shrunkClaude });
  row = await readAgent(agentId);
  report(
    shrink.accepted && row.claudeMd === shrunkClaude,
    surface,
    "over-budget claudeMd shrink accepted",
    shrink.detail,
  );

  const equalTools = "u".repeat(BOOTSTRAP_BUDGET + 5);
  const equal = await write({ toolsMd: equalTools });
  row = await readAgent(agentId);
  report(
    equal.accepted && row.toolsMd === equalTools,
    surface,
    "equal-length over-budget toolsMd rewrite accepted",
    equal.detail,
  );

  const heartbeat = "h".repeat(50_000);
  const ungated = await write({ heartbeatMd: heartbeat });
  row = await readAgent(agentId);
  report(
    ungated.accepted && row.heartbeatMd === heartbeat,
    surface,
    "negative control: far-over-budget heartbeatMd accepted",
    ungated.detail,
  );
}

function mcpResult(result: Awaited<ReturnType<McpHttpClient["callToolRaw"]>>): WriteResult {
  if (!result.ok)
    return { accepted: false, detail: `JSON-RPC error: ${JSON.stringify(result.error)}` };
  const payload = result.result as typeof result.result & {
    structuredContent?: { success?: boolean; message?: string };
  };
  const message = payload.structuredContent?.message ?? payload.content[0]?.text ?? "no message";
  return {
    accepted: payload.isError !== true && payload.structuredContent?.success !== false,
    detail: message,
  };
}

async function cleanup(): Promise<void> {
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  logWriter.end();
  await Bun.$`rm -rf ${tmpDir}`.quiet();
}

let exitCode = 1;
try {
  await waitForServer();
  console.log(`Local API ready on ${baseUrl} with throwaway DB ${dbPath}`);

  await registerAgent(HTTP_AGENT_ID, "HTTP budget agent");
  await runMatrix("HTTP", HTTP_AGENT_ID, async (updates) => {
    const response = await request("PUT", `/api/agents/${HTTP_AGENT_ID}/profile`, {
      body: updates,
    });
    const detail = String(
      response.body.error ?? response.body.message ?? `HTTP ${response.status}`,
    );
    return { accepted: response.status === 200, detail };
  });

  await registerAgent(MCP_AGENT_ID, "MCP budget agent");
  const mcp = new McpHttpClient(baseUrl, API_KEY, MCP_AGENT_ID, undefined, {
    clientInfo: { name: "identity-field-budget-e2e", version: "1.0.0" },
  });
  await mcp.initialize();
  await runMatrix("MCP", MCP_AGENT_ID, async (updates) =>
    mcpResult(await mcp.callToolRaw("update-profile", updates)),
  );

  const beforeCombined = await readAgent(MCP_AGENT_ID);
  const combined = mcpResult(
    await mcp.callToolRaw("update-profile", {
      name: "MCP partially renamed agent",
      soulMd: `${beforeCombined.soulMd}x`,
    }),
  );
  const afterCombined = await readAgent(MCP_AGENT_ID);
  report(
    !combined.accepted &&
      afterCombined.name === beforeCombined.name &&
      afterCombined.soulMd === beforeCombined.soulMd,
    "MCP",
    "combined name + over-budget identity write rejected; name and field unchanged",
    combined.detail,
  );

  console.log(`SUMMARY | ${passed} passed | ${failed} failed`);
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  try {
    logWriter.flush();
    console.error(`\nServer log:\n${await Bun.file(logPath).text()}`);
  } catch {}
} finally {
  await cleanup();
}

process.exit(exitCode);
