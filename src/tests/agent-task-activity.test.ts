import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import { handleAgentsRest } from "../http/agents";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-agent-task-activity.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    if (await handleAgentsRest(req, res, segments, url.searchParams, undefined)) return;
    res.writeHead(404).end();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("GET /api/agents/:id/task-activity", () => {
  test("counts tasks per UTC day inside the window, for that agent only", async () => {
    const agent = await createAgent({ name: "a", isLead: false, status: "idle", capabilities: [] });
    const other = await createAgent({ name: "b", isLead: false, status: "idle", capabilities: [] });
    const day = (offset: number) =>
      new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const stamp = async (agentId: string, date: string) => {
      const task = await createTaskExtended("t", { agentId });
      await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
        `${date}T12:00:00.000Z`,
        task.id,
      ]);
    };
    await stamp(agent.id, day(1));
    await stamp(agent.id, day(1));
    await stamp(agent.id, day(3));
    await stamp(agent.id, day(40));
    await stamp(other.id, day(1));

    const res = await fetch(`${baseUrl}/api/agents/${agent.id}/task-activity?days=30`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: [
        { date: day(3), count: 1 },
        { date: day(1), count: 2 },
      ],
    });
  });

  test("404s for an unknown agent", async () => {
    const res = await fetch(`${baseUrl}/api/agents/nope/task-activity`);
    expect(res.status).toBe(404);
  });
});
