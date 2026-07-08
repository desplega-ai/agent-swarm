import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  closeDb,
  createScheduledTask,
  getScheduledTaskById,
  initDb,
  updateScheduledTask,
} from "../be/db";
import { handleSchedules } from "../http/schedules";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { ScheduledTask, ScheduledTaskSummary } from "../types";

const TEST_DB_PATH = "./test-schedule-http-triage-tools.sqlite";
const TEST_PORT = 13031;

function createTestServer(): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const myAgentId = req.headers["x-agent-id"] as string | undefined;

    const handled = await handleSchedules(req, res, pathSegments, queryParams, myAgentId);
    if (!handled) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

const baseUrl = `http://localhost:${TEST_PORT}`;
const headers = {
  "Content-Type": "application/json",
  "X-Agent-ID": crypto.randomUUID(),
};

describe("Schedule HTTP triage tooling", () => {
  let server: Server;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(TEST_DB_PATH + suffix).catch(() => {});
    }
    initDb(TEST_DB_PATH);
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await unlink(TEST_DB_PATH + suffix).catch(() => {});
    }
  });

  test("PATCH /api/schedules/:id clears one field without restating the schedule", async () => {
    const schedule = createScheduledTask({
      name: `http-patch-schedule-${crypto.randomUUID()}`,
      intervalMs: 60000,
      taskTemplate: "keep me",
      model: "gpt-5.5",
    });

    const res = await fetch(`${baseUrl}/api/schedules/${schedule.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ model: null }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScheduledTask;
    expect(body.model).toBeUndefined();
    expect(body.intervalMs).toBe(60000);
    expect(body.taskTemplate).toBe("keep me");
    expect(getScheduledTaskById(schedule.id)?.model).toBeUndefined();
  });

  test("GET /api/schedules filters by consecutive errors and last run status", async () => {
    const ok = createScheduledTask({
      name: `http-schedule-ok-${crypto.randomUUID()}`,
      intervalMs: 60000,
      taskTemplate: "healthy",
    });
    const failing = createScheduledTask({
      name: `http-schedule-failing-${crypto.randomUUID()}`,
      intervalMs: 60000,
      taskTemplate: "failing",
    });
    updateScheduledTask(ok.id, {
      lastRunAt: new Date(Date.now() - 120000).toISOString(),
      consecutiveErrors: 0,
    });
    updateScheduledTask(failing.id, {
      lastRunAt: new Date(Date.now() - 60000).toISOString(),
      consecutiveErrors: 2,
      lastErrorAt: new Date().toISOString(),
      lastErrorMessage: "boom",
    });

    const res = await fetch(
      `${baseUrl}/api/schedules?lastRunStatus=failed&consecutiveErrorsMin=2`,
      { headers },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { schedules: ScheduledTaskSummary[]; count: number };
    expect(body.schedules.some((s) => s.id === failing.id)).toBe(true);
    expect(body.schedules.some((s) => s.id === ok.id)).toBe(false);
  });
});
