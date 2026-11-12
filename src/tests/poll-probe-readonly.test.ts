/**
 * The idle-poll probe in GET /api/poll must stay SELECT-only, helper side
 * effects included: a write inside its read-only transaction takes the SQLite
 * write lock the probe exists to avoid. Read-only transactions run here under
 * `PRAGMA query_only`, so a probe write fails (and a swallowed one is lost)
 * instead of silently upgrading the lock.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-poll-probe-readonly.sqlite";
let server: Server;
let baseUrl = "";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

async function poll(agentId: string): Promise<{ status: number; body: { trigger?: unknown } }> {
  const res = await fetch(`${baseUrl}/api/poll`, { headers: { "X-Agent-ID": agentId } });
  return { status: res.status, body: (await res.json()) as { trigger?: unknown } };
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  const client = getDbClient();
  const transaction = client.transaction.bind(client);
  spyOn(client, "transaction").mockImplementation((fn, opts) =>
    opts?.readOnly
      ? transaction(async (tx) => {
          await tx.run("PRAGMA query_only = ON");
          try {
            return await fn(tx);
          } finally {
            await tx.run("PRAGMA query_only = OFF");
          }
        }, opts)
      : transaction(fn, opts),
  );
  server = createHttpServer(async (req, res) => {
    const agentId = req.headers["x-agent-id"] as string | undefined;
    const url = req.url ?? "";
    if (await handlePoll(req, res, getPathSegments(url), parseQueryParams(url), agentId)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

test("an affinity-skipped pending task keeps the idle probe SELECT-only", async () => {
  const agentId = crypto.randomUUID();
  await createAgent({
    id: agentId,
    name: "probe-worker",
    isLead: false,
    status: "idle",
    capabilities: [],
    maxTasks: 2,
  });
  const task = await createTaskExtended("quarantined assignment", { agentId });
  // A corrupt stored affinity: dispatch skips the task and logs why.
  await getDbClient().run("UPDATE agent_tasks SET routingAffinity = ? WHERE id = ?", [
    "{not-json",
    task.id,
  ]);
  const skipLogs = async () =>
    (
      await getDbClient().get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM agent_log WHERE eventType = 'task_dispatch_rejected_affinity' AND taskId = ?",
        [task.id],
      )
    )?.n;

  // Log due: the probe hands it to the write pass instead of writing it.
  const first = await poll(agentId);
  expect(first.status).toBe(200);
  expect(first.body.trigger).toBeNull();
  expect(await skipLogs()).toBe(1);

  // Log in cooldown: nothing to write, so the poll answers while another
  // connection holds the write lock.
  const holder = new Database(TEST_DB_PATH);
  holder.run("BEGIN IMMEDIATE");
  try {
    const second = await poll(agentId);
    expect(second.status).toBe(200);
    expect(second.body.trigger).toBeNull();
  } finally {
    holder.run("ROLLBACK");
    holder.close();
  }
  expect(await skipLogs()).toBe(1);
}, 30_000);
