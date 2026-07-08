/**
 * Shared plumbing for the RBAC wire-level e2e suites (rbac-wire-e2e.test.ts,
 * rbac-lifecycle-e2e.test.ts).
 *
 * Unlike the rbac-charact-* suites (which invoke handlers in-process, in some
 * cases deliberately bypassing handleCore), these helpers spawn the REAL
 * server as a subprocess and drive it over HTTP — real auth middleware, real
 * MCP handshake, real audit writer flushing into the real DB file. The
 * spawned server owns its scratch DB; tests read it via a separate readonly
 * bun:sqlite connection (WAL allows the cross-process read).
 */
import { Database } from "bun:sqlite";
import { openSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "../..");
export const E2E_API_KEY = "rbac-e2e-key";

export const LEAD = "11111111-1111-4111-8111-111111111111";
export const WORKER_A = "22222222-2222-4222-8222-222222222222";
export const WORKER_B = "33333333-3333-4333-8333-333333333333";

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("could not determine free port"));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

export type SwarmServer = {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  base: string;
  dbPath: string;
  logPath: string;
  /** SIGTERM + wait for exit. Returns the exit code. */
  stop(): Promise<number | null>;
};

export async function makeScratchDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "rbac-e2e-"));
}

export async function removeScratchDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Spawn `bun src/http.ts` against `dbPath` on a free port. Integrations are
 * disabled; both API-key env vars are pinned so a developer's shell env can't
 * leak in (AGENT_SWARM_API_KEY takes precedence in getApiKey()).
 */
export async function spawnSwarmServer(opts: {
  dbPath: string;
  logPath: string;
  env?: Record<string, string>;
  /** Poll /docs until the server accepts requests (default true). */
  waitForListen?: boolean;
}): Promise<SwarmServer> {
  const port = await getFreePort();
  const logFd = openSync(opts.logPath, "a");
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: REPO_ROOT,
    stdout: logFd,
    stderr: logFd,
    env: {
      ...process.env,
      DATABASE_PATH: opts.dbPath,
      // Keep the local-fs provider (task attachments) inside the scratch dir
      // instead of the repo-root ./data/fs default.
      AGENT_FS_LOCAL_DIR: join(dirname(opts.dbPath), "fs"),
      API_KEY: E2E_API_KEY,
      AGENT_SWARM_API_KEY: E2E_API_KEY,
      PORT: String(port),
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      JIRA_DISABLE: "true",
      LINEAR_DISABLE: "true",
      OAUTH_KEEPALIVE_DISABLE: "true",
      RBAC_AUDIT_DISABLED: "",
      RBAC_AUDIT_FLUSH_MS: "",
      // Keep subprocess suites deterministic: shell-level RBAC_ENABLED=true is
      // ignored unless a suite explicitly opts in through opts.env.
      RBAC_ENABLED: "false",
      ...opts.env,
    },
  });
  const base = `http://localhost:${port}`;

  const server: SwarmServer = {
    proc,
    port,
    base,
    dbPath: opts.dbPath,
    logPath: opts.logPath,
    async stop() {
      proc.kill("SIGTERM");
      await proc.exited;
      return proc.exitCode;
    },
  };

  if (opts.waitForListen !== false) {
    await waitForListen(server);
  }
  return server;
}

export async function waitForListen(server: SwarmServer, deadlineMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (server.proc.exitCode !== null) {
      throw new Error(
        `server exited with code ${server.proc.exitCode} before listening — see ${server.logPath}`,
      );
    }
    try {
      const res = await fetch(`${server.base}/docs`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  throw new Error(`server did not listen within ${deadlineMs}ms — see ${server.logPath}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

export async function api(
  base: string,
  method: string,
  path: string,
  opts: { agentId?: string; bearer?: string; body?: unknown; rawBody?: BodyInit } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearer ?? E2E_API_KEY}`,
  };
  if (opts.agentId !== undefined) headers["X-Agent-ID"] = opts.agentId;
  let bodyInit: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  } else if (opts.rawBody !== undefined) {
    headers["Content-Type"] = "application/octet-stream";
    bodyInit = opts.rawBody;
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: bodyInit });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. empty 200) — keep the raw text
  }
  return { status: res.status, body: parsed };
}

export async function registerAgent(
  base: string,
  agentId: string,
  name: string,
  isLead: boolean,
): Promise<void> {
  const res = await api(base, "POST", "/api/agents", { agentId, body: { name, isLead } });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`agent registration failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
}

// ── MCP client (raw Streamable-HTTP handshake, matching LOCAL_TESTING.md) ───

function mcpHeaders(agentId: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${E2E_API_KEY}`,
    "X-Agent-ID": agentId,
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

export async function mcpInit(base: string, agentId: string): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(agentId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        clientInfo: { name: "rbac-e2e", version: "1" },
        capabilities: {},
      },
    }),
  });
  const sessionId = res.headers.get("mcp-session-id");
  await res.text();
  if (!res.ok || !sessionId) {
    throw new Error(`MCP initialize failed for ${agentId}: HTTP ${res.status}`);
  }
  const notify = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(agentId, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await notify.text();
  return sessionId;
}

/** tools/call over the live MCP session; returns the JSON-RPC `result`. */
export async function mcpCall(
  base: string,
  agentId: string,
  sessionId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: mcpHeaders(agentId, sessionId),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tools/call ${tool} failed: HTTP ${res.status}: ${text}`);
  // Streamable HTTP answers with an SSE body: `event: message\ndata: {...}`.
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const msg = JSON.parse(line.slice("data: ".length));
    if (msg.id === 7) {
      if (msg.error) throw new Error(`tools/call ${tool} error: ${JSON.stringify(msg.error)}`);
      return msg.result;
    }
  }
  throw new Error(`tools/call ${tool}: no data frame with id 7 in response: ${text}`);
}

// ── Audit-table access (readonly, cross-process via WAL) ────────────────────

export type AuditRow = {
  principalType: string;
  principalId: string | null;
  verb: string;
  resourceType: string | null;
  resourceId: string | null;
  decision: string;
  reason: string | null;
  source: string;
};

export function readAuditRows(dbPath: string): AuditRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT principalType, principalId, verb, resourceType, resourceId, decision, reason, source
         FROM permission_audit ORDER BY rowid`,
      )
      .all() as AuditRow[];
  } finally {
    db.close();
  }
}

export function countAuditRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM permission_audit").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** Poll until the audit table reaches `expected` rows (writer flushes every 2s). */
export async function waitForAuditCount(
  dbPath: string,
  expected: number,
  deadlineMs = 8_000,
): Promise<number> {
  const start = Date.now();
  let n = countAuditRows(dbPath);
  while (n < expected && Date.now() - start < deadlineMs) {
    await Bun.sleep(250);
    n = countAuditRows(dbPath);
  }
  return n;
}
