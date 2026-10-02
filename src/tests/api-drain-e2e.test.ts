/**
 * API drain, end to end: a real `src/http.ts` process gets SIGTERM while a
 * worker holds a task. It must keep serving, mark responses with the drain
 * header, dispatch nothing, and exit as soon as the worker has handed the task
 * off, not at the cap.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { API_DRAINING_HEADER } from "../utils/api-drain";
import { getFreePort, waitForServer } from "./test-net";

const API_KEY = "example-test-api-drain-key";
const BOOT_TIMEOUT_MS = 90_000;

interface Api {
  proc: Subprocess<"ignore", "pipe", "pipe">;
  base: string;
  stdout: Promise<string>;
  dbPath: string;
  fsDir: string;
}

const booted: Api[] = [];

async function bootApi(env: Record<string, string>): Promise<Api> {
  const port = await getFreePort();
  const stamp = `${Date.now()}-${port}`;
  const dbPath = `/tmp/test-api-drain-${stamp}.sqlite`;
  const fsDir = `/tmp/test-api-drain-fs-${stamp}`;
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      API_KEY,
      AGENT_FS_LOCAL_DIR: fsDir,
      AGENT_FS_API_URL: "",
      API_AGENT_FS_API_KEY: "",
      AGENT_FS_API_KEY: "",
      CAPABILITIES: "core,task-pool,messaging,profiles,services,memory",
      SLACK_BOT_TOKEN: "",
      GITHUB_WEBHOOK_SECRET: "",
      AGENTMAIL_API_KEY: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain both pipes from the start so a full buffer cannot stall the server.
  const stdout = new Response(proc.stdout).text();
  void new Response(proc.stderr).text();
  const api: Api = { proc, base: `http://127.0.0.1:${port}`, stdout, dbPath, fsDir };
  booted.push(api);
  await waitForServer(`${api.base}/health`);
  return api;
}

afterEach(async () => {
  for (const api of booted.splice(0)) {
    if (api.proc.exitCode === null) api.proc.kill("SIGKILL");
    await api.proc.exited.catch(() => {});
    await rm(api.fsDir, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ["", "-wal", "-shm"]) await unlink(api.dbPath + suffix).catch(() => {});
  }
});

async function call(
  api: Api,
  method: string,
  path: string,
  opts: { agentId?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
  };
  if (opts.agentId) headers["X-Agent-ID"] = opts.agentId;
  const res = await fetch(`${api.base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body, drainHeader: res.headers.get(API_DRAINING_HEADER) };
}

/** A lead, plus a worker that has claimed one task through the real poll route. */
async function seedInFlight(api: Api) {
  const leadId = crypto.randomUUID();
  const workerId = crypto.randomUUID();
  const idleWorkerId = crypto.randomUUID();
  await call(api, "POST", "/api/agents", {
    agentId: leadId,
    body: { name: "DrainLead", isLead: true, role: "lead" },
  });
  for (const [id, name] of [
    [workerId, "DrainWorker"],
    [idleWorkerId, "DrainIdle"],
  ] as const) {
    await call(api, "POST", "/api/agents", { agentId: id, body: { name, role: "worker" } });
  }
  const created = await call(api, "POST", "/api/tasks", {
    agentId: leadId,
    body: { task: "in flight", agentId: workerId, routingReason: "human_pinned" },
  });
  expect(created.status).toBe(201);
  const polled = await call(api, "GET", "/api/poll", { agentId: workerId });
  expect(polled.body.trigger?.taskId).toBe(created.body.id);
  return { leadId, workerId, idleWorkerId, taskId: created.body.id as string };
}

async function untilDraining(api: Api, agentId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ping = await call(api, "POST", "/ping", { agentId });
      if (ping.drainHeader === "1") return ping;
    } catch {
      // the server is gone
    }
    await Bun.sleep(50);
  }
  throw new Error("API never reported draining");
}

async function exitedWithin(api: Api, timeoutMs: number): Promise<number | "timeout"> {
  return await Promise.race([api.proc.exited, Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
}

describe("API drain, real process", () => {
  test(
    "SIGTERM with an in-flight task: serves, flags the drain, dispatches nothing, exits on handoff",
    async () => {
      const api = await bootApi({ API_DRAIN_MAX_MS: "30000" });
      const { leadId, workerId, idleWorkerId, taskId } = await seedInFlight(api);
      const pending = await call(api, "POST", "/api/tasks", {
        agentId: leadId,
        body: { task: "waits", agentId: idleWorkerId, routingReason: "human_pinned" },
      });
      expect(pending.status).toBe(201);

      // Control: before SIGTERM there is no drain header.
      expect((await call(api, "POST", "/ping", { agentId: workerId })).drainHeader).toBeNull();

      const signalledAt = Date.now();
      api.proc.kill("SIGTERM");
      await untilDraining(api, workerId);

      // Still serving, and still holding open for the worker.
      expect((await call(api, "GET", "/health")).status).toBe(200);
      expect(api.proc.exitCode).toBeNull();

      // No new work: an idle worker's poll returns nothing and its task waits.
      const idlePoll = await call(api, "GET", "/api/poll", { agentId: idleWorkerId });
      expect(idlePoll.status).toBe(200);
      expect(idlePoll.body.trigger).toBeNull();
      expect(idlePoll.drainHeader).toBe("1");
      expect((await call(api, "GET", `/api/tasks/${pending.body.id}`)).body.status).toBe("pending");

      // The worker hands off through the same route its SIGTERM handler uses.
      const handoff = await call(api, "POST", `/api/tasks/${taskId}/supersede`, {
        agentId: workerId,
        body: { reason: "graceful_shutdown" },
      });
      expect(handoff.status).toBe(200);
      expect(handoff.body.kind).toBe("resumed");

      // It exits on the handoff: well inside the 30 s cap.
      expect(await exitedWithin(api, 15_000)).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(15_000);
      const log = await api.stdout;
      expect(log).toContain("[drain] draining: waiting up to 30000ms for 1 in-flight task(s)");
      expect(log).toContain("[drain] all 1 in-flight task(s) handed off");
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "SIGTERM with nothing in flight does not wait",
    async () => {
      const api = await bootApi({ API_DRAIN_MAX_MS: "60000" });
      const signalledAt = Date.now();
      api.proc.kill("SIGTERM");
      expect(await exitedWithin(api, 20_000)).toBe(0);
      expect(Date.now() - signalledAt).toBeLessThan(20_000);
      expect(await api.stdout).toContain("[drain] draining: no in-flight tasks on live workers");
    },
    BOOT_TIMEOUT_MS,
  );

  test(
    "a task that is never handed off holds the API only until the cap",
    async () => {
      const api = await bootApi({ API_DRAIN_MAX_MS: "2500" });
      const { workerId } = await seedInFlight(api);
      const signalledAt = Date.now();
      api.proc.kill("SIGTERM");
      await untilDraining(api, workerId);

      expect(await exitedWithin(api, 20_000)).toBe(0);
      expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(2_000);
      expect(await api.stdout).toContain("[drain] timed out after");
    },
    BOOT_TIMEOUT_MS,
  );
});
