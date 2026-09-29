import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getRootTaskChain,
  getTaskById,
  initDb,
} from "../be/db";
import { getTaskSteeringFields, getTaskSteeringFieldsForTasks } from "../be/steering";
import { getTaskCitations, getTaskCitationsForTasks } from "../be/task-citations";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { AgentTask } from "../types";
import { listenOnFreePort } from "./test-net";

let server: Server;
let baseUrl: string;
let rootId: string;
const chainIds: string[] = [];

async function addCitation(taskId: string, index: number, general = false) {
  await getDbClient().run(
    `INSERT INTO task_citations (task_id, citation_index, kind, ref, label, quote, resolved_url, verified, general)
     VALUES (?, ?, 'url', ?, ?, NULL, ?, 'unchecked', ?)`,
    [
      taskId,
      index,
      `https://example.com/${taskId}/${index}`,
      `c${index}`,
      `https://example.com/${taskId}/${index}`,
      general ? 1 : 0,
    ],
  );
}

/** The pre-batch handler body: one agent lookup and one citations query per task. */
async function unbatchedSession(id: string) {
  const root = (await getTaskById(id))!;
  const chain = await getRootTaskChain(id);
  const decorate = async (task: AgentTask) => ({
    ...task,
    ...(await getTaskSteeringFields(task)),
    citations: await getTaskCitations(task.id),
  });
  return { root: await decorate(root), chain: await Promise.all(chain.map(decorate)) };
}

beforeAll(async () => {
  initDb(":memory:");
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const ok = await handleSessions(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
    );
    if (!ok) {
      res.writeHead(404);
      res.end();
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;

  const lead = await createAgent({
    name: "lead",
    isLead: true,
    status: "idle",
    capabilities: [],
    harnessProvider: "claude",
  });
  const codex = await createAgent({
    name: "codex worker",
    isLead: false,
    status: "idle",
    capabilities: [],
    harnessProvider: "codex",
  });
  const pi = await createAgent({
    name: "pi worker",
    isLead: false,
    status: "idle",
    capabilities: [],
    provider: "pi",
  });

  const root = await createTaskExtended("session root", { agentId: lead.id, source: "api" });
  rootId = root.id;
  const childA = await createTaskExtended("child A", {
    agentId: codex.id,
    parentTaskId: root.id,
    source: "api",
  });
  const childB = await createTaskExtended("child B", {
    agentId: pi.id,
    parentTaskId: root.id,
    source: "api",
  });
  const grandchild = await createTaskExtended("grandchild of A", {
    agentId: codex.id,
    parentTaskId: childA.id,
    source: "api",
  });
  const unassigned = await createTaskExtended("unassigned child", {
    parentTaskId: childB.id,
    source: "api",
    provider: "devin",
  });
  const ghost = await createTaskExtended("child of a deleted agent", {
    agentId: lead.id,
    parentTaskId: root.id,
    source: "api",
  });
  await getDbClient().run("UPDATE agent_tasks SET agentId = ? WHERE id = ?", [
    "00000000-0000-4000-8000-000000000000",
    ghost.id,
  ]);
  chainIds.push(childA.id, childB.id, grandchild.id, unassigned.id, ghost.id);

  // Out-of-order inserts so the per-task citation_index ordering is exercised.
  await addCitation(root.id, 3);
  await addCitation(root.id, 1, true);
  await addCitation(root.id, 2);
  await addCitation(childA.id, 2);
  await addCitation(childA.id, 1);
  await addCitation(grandchild.id, 1, true);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe("GET /api/sessions/{rootTaskId} batching", () => {
  test("response is identical to the per-task path on a multi-task chain", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/${rootId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = JSON.parse(JSON.stringify(await unbatchedSession(rootId)));

    expect(body).toEqual(expected);
    // Guard against a vacuous match: the fixture covers every branch.
    expect(body.chain.map((task: AgentTask) => task.id).sort()).toEqual(
      [rootId, ...chainIds].sort(),
    );
    expect(body.root.isLeadTask).toBe(true);
    expect(body.root.citations.map((c: { index: number }) => c.index)).toEqual([1, 2, 3]);
    expect(body.root.citations[0].general).toBe(true);
    const byId = new Map(body.chain.map((task: AgentTask) => [task.id, task]));
    const [childA, childB, grandchild, unassigned, ghost] = chainIds.map((id) => byId.get(id)) as {
      isLeadTask: boolean;
      supportedSteerModes: string[];
      citations: { index: number }[];
    }[];
    expect(childA!.citations.map((c) => c.index)).toEqual([1, 2]);
    expect(grandchild!.citations).toHaveLength(1);
    expect(childB!.citations).toEqual([]);
    expect(unassigned!.isLeadTask).toBe(false);
    expect(ghost!.isLeadTask).toBe(false);
  });

  test("404 for an unknown root is unchanged", async () => {
    const res = await fetch(`${baseUrl}/api/sessions/00000000-0000-4000-8000-000000000001`);
    expect(res.status).toBe(404);
  });

  test("getRootTaskChain seeks the chain instead of scanning agent_tasks, same order", async () => {
    const OLD_CHAIN_SQL = `WITH RECURSIVE chain(id) AS (
         SELECT id FROM agent_tasks WHERE id = ?
         UNION ALL
         SELECT t.id FROM agent_tasks t
         JOIN chain c ON t.parentTaskId = c.id
       )
       SELECT t.id FROM agent_tasks t
       JOIN chain ON chain.id = t.id
       ORDER BY t.createdAt`;
    // Ties on createdAt: the old plan returned them in idx_agent_tasks_created (rowid) order.
    const ids = [rootId, ...chainIds];
    const saved = await getDbClient().query<{ id: string; createdAt: string }>(
      `SELECT id, createdAt FROM agent_tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    await getDbClient().run(
      `UPDATE agent_tasks SET createdAt = '2026-01-01T00:00:00.000Z' WHERE id IN (${ids
        .slice(1)
        .map(() => "?")
        .join(",")})`,
      ids.slice(1),
    );
    try {
      const old = await getDbClient().query<{ id: string }>(OLD_CHAIN_SQL, [rootId]);
      expect((await getRootTaskChain(rootId)).map((t) => t.id)).toEqual(old.map((r) => r.id));
    } finally {
      for (const row of saved) {
        await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
          row.createdAt,
          row.id,
        ]);
      }
    }

    // Capture the SQL the real call issues, then ask SQLite how it runs it.
    const client = getDbClient();
    const query = client.query.bind(client);
    let issued = "";
    client.query = ((sql: string, params?: unknown[]) => {
      issued = sql;
      return query(sql, params as never);
    }) as typeof client.query;
    try {
      await getRootTaskChain(rootId);
    } finally {
      client.query = query;
    }
    const plan = await client.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${issued}`, [rootId]);
    expect(plan.map((r) => r.detail)).not.toContain("SCAN t USING INDEX idx_agent_tasks_created");
  });

  test("batched loaders chunk past 500 ids and match the per-id loaders", async () => {
    const chain = await getRootTaskChain(rootId);
    // Pad with ids that have no rows so the real ones straddle chunk boundaries.
    const padding = Array.from(
      { length: 1200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    const ids = [...padding.slice(0, 499), ...chain.map((t) => t.id), ...padding.slice(499)];

    const citations = await getTaskCitationsForTasks(ids);
    expect(citations.size).toBe(ids.length);
    for (const task of chain) {
      expect(citations.get(task.id)).toEqual(await getTaskCitations(task.id));
    }
    expect(citations.get(padding[0]!)).toEqual([]);

    const fakeTasks = padding.map((agentId, i) => ({ ...chain[0]!, id: `fake-${i}`, agentId }));
    const tasks = [...fakeTasks.slice(0, 499), ...chain, ...fakeTasks.slice(499)];
    const steering = await getTaskSteeringFieldsForTasks(tasks);
    expect(steering.size).toBe(tasks.length);
    for (const task of tasks) {
      expect(steering.get(task.id)).toEqual(await getTaskSteeringFields(task));
    }
  });
});
