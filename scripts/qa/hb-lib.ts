/**
 * QA harness for PR #1682 (heartbeat Reclaim/Unpin). Boots the real API from a
 * checkout, drives it with fake workers over HTTP + MCP, and backdates rows
 * through a second sqlite handle (WAL) to skip the minute-scale stall timers.
 */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { restartSut, type Sut, startSut, stopSut } from "../e2e/sut";

export { restartSut, type Sut, startSut, stopSut };

export type Api = ReturnType<typeof makeApi>;

export function makeApi(sut: Sut) {
  return async function api(
    method: string,
    path: string,
    o: {
      agent?: string;
      runtime?: string;
      sourceTask?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${sut.apiKey}`,
      ...o.headers,
    };
    if (o.agent) headers["X-Agent-ID"] = o.agent;
    if (o.runtime) headers["X-Runtime-Instance-ID"] = o.runtime;
    if (o.sourceTask) headers["X-Source-Task-Id"] = o.sourceTask;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${sut.baseUrl}${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text };
  };
}

export async function mcpConnect(
  sut: Sut,
  agent: string,
  opts: { runtime?: string; sourceTask?: string } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sut.apiKey}`,
    "X-Agent-ID": agent,
  };
  if (opts.runtime) headers["X-Runtime-Instance-ID"] = opts.runtime;
  if (opts.sourceTask) headers["X-Source-Task-Id"] = opts.sourceTask;
  const client = new Client({ name: "qa", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${sut.baseUrl}/mcp`), { requestInit: { headers } }),
  );
  return {
    async call(name: string, args: Record<string, unknown>) {
      const r: any = await client.callTool({ name, arguments: args });
      const sc = r.structuredContent ?? null;
      const text = (r.content ?? []).map((c: any) => c.text ?? "").join("\n");
      return { isError: !!r.isError, data: sc, text };
    },
    close: () => client.close(),
  };
}

export function openDb(sut: Sut) {
  const db = new Database(sut.dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
  every = 300,
) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(every);
  }
  return false;
}

export type Worker = { id: string; runtime: string; name: string };

export async function registerWorker(
  api: Api,
  name: string,
  o: { lead?: boolean; runtime?: string; role?: string } = {},
): Promise<Worker> {
  const id = randomUUID();
  const runtime = o.runtime ?? `rt-${name}-${randomUUID().slice(0, 6)}`;
  const r = await api("POST", "/api/agents", {
    agent: id,
    runtime,
    body: {
      name,
      role: o.role ?? "worker",
      isLead: !!o.lead,
      status: "idle",
      runtimeInstanceId: runtime,
      maxTasks: 1,
    },
  });
  if (r.status >= 300) throw new Error(`register ${name}: ${r.status} ${r.text}`);
  // POST /api/agents drops `role`; it is set through the profile route.
  const pr = await api("PUT", `/api/agents/${id}/profile`, {
    agent: id,
    body: { role: o.role ?? "worker" },
  });
  if (pr.status >= 300) throw new Error(`role ${name}: ${pr.status} ${pr.text}`);
  return { id, runtime, name };
}

export async function createTask(
  api: Api,
  text: string,
  o: Record<string, unknown> = {},
): Promise<string> {
  const r = await api("POST", "/api/tasks", {
    body: { task: text, source: "api", routingReason: "human_pinned", ...o },
  });
  if (r.status >= 300) throw new Error(`create task: ${r.status} ${r.text}`);
  return r.json.id as string;
}

/** poll as a worker (optionally a specific runtime) */
export const poll = (api: Api, w: Worker, runtime?: string) =>
  api("GET", "/api/poll", { agent: w.id, runtime: runtime ?? w.runtime });

export const getTask = async (api: Api, id: string) => (await api("GET", `/api/tasks/${id}`)).json;

export async function registerSession(api: Api, w: Worker, taskId: string, runtime?: string) {
  return api("POST", "/api/active-sessions", {
    agent: w.id,
    runtime: runtime ?? w.runtime,
    body: {
      agentId: w.id,
      taskId,
      triggerType: "task_assigned",
      runtimeInstanceId: runtime ?? w.runtime,
    },
  });
}

/** Make the task look stalled: no session, last update `min` minutes ago. */
export function stall(db: Database, taskId: string, min = 10, dropSession = true) {
  db.run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [minutesAgo(min), taskId]);
  if (dropSession) db.run("DELETE FROM active_sessions WHERE taskId = ?", [taskId]);
}

export const row = (db: Database, id: string) =>
  db.query("SELECT * FROM agent_tasks WHERE id = ?").get(id) as any;
export const rows = (db: Database, sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];

export type Finding = {
  id: string;
  sev: "P0" | "P1" | "P2" | "P3" | "INFO";
  title: string;
  observed: string;
  expected: string;
  repro: string;
};
export type Result = { name: string; status: "PASS" | "FAIL" | "NOT RUN" | "INFO"; detail: string };

export const results: Result[] = [];
export const findings: Finding[] = [];

export async function scenario(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) ?? "";
    results.push({ name, status: "PASS", detail });
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e: any) {
    results.push({ name, status: "FAIL", detail: String(e?.message ?? e) });
    console.log(`FAIL  ${name} — ${String(e?.message ?? e).slice(0, 600)}`);
  }
}

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
