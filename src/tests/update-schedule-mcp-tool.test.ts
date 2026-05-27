/**
 * MCP tool-level regression test for `update-schedule`.
 *
 * Covers the end-to-end path through the tool (not just the helper), verifying
 * that the mergeScheduleTiming / validateRecurringTiming wiring is active on
 * the actual MCP call path.
 *
 * Does NOT duplicate schedule-validation-helper.test.ts (pure helper logic).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createScheduledTask, getScheduledTaskById, initDb } from "../be/db";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";

const TEST_DB_PATH = "./test-update-schedule-mcp-tool.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "update-schedule-mcp-test", version: "1.0.0" });
  registerUpdateScheduleTool(server);
  return server;
}

function callUpdateSchedule(
  server: McpServer,
  args: Record<string, unknown>,
  callerAgentId: string,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools["update-schedule"];
  if (!tool) throw new Error("update-schedule not registered");
  return tool.handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  });
}

type ScheduleOutput = {
  success: boolean;
  message: string;
  schedule?: {
    cronExpression?: string | null;
    intervalMs?: number | null;
    enabled: boolean;
    nextRunAt?: string | null;
  };
};

function structured(result: CallToolResult): ScheduleOutput {
  return result.structuredContent as ScheduleOutput;
}

let creatorId: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  await initDb(TEST_DB_PATH);
  const creator = await createAgent({
    name: "update-schedule-mcp-creator",
    isLead: false,
    status: "idle",
  });
  creatorId = creator.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("update-schedule MCP tool", () => {
  test("regression: { cronExpression: null, intervalMs: null, enabled: false } returns success:false and leaves DB row unchanged", async () => {
    const server = buildServer();
    const schedule = await createScheduledTask({
      name: `mcp-regression-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "hourly task",
      createdByAgentId: creatorId,
      timezone: "UTC",
    });

    const before = await getScheduledTaskById(schedule.id)!;

    const result = await callUpdateSchedule(
      server,
      { scheduleId: schedule.id, cronExpression: null, intervalMs: null, enabled: false },
      creatorId,
    );
    const sc = structured(result);

    expect(sc.success).toBe(false);
    expect(sc.message).toContain("At least one of intervalMs or cronExpression must be set");

    // DB row must be unchanged — no partial write on validation failure
    const after = await getScheduledTaskById(schedule.id)!;
    expect(after.cronExpression).toBe(before.cronExpression);
    expect(after.intervalMs).toBe(before.intervalMs);
    expect(after.enabled).toBe(before.enabled);
  });

  test("cron-to-interval switch: { cronExpression: null, intervalMs: 60000 } succeeds and nextRunAt is recomputed", async () => {
    const server = buildServer();
    const schedule = await createScheduledTask({
      name: `mcp-cron-switch-${Date.now()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "hourly task",
      createdByAgentId: creatorId,
      timezone: "UTC",
    });

    const result = await callUpdateSchedule(
      server,
      { scheduleId: schedule.id, cronExpression: null, intervalMs: 60000 },
      creatorId,
    );
    const sc = structured(result);

    expect(sc.success).toBe(true);
    // cron cleared, interval applied
    expect(sc.schedule?.cronExpression).toBeUndefined();
    expect(sc.schedule?.intervalMs).toBe(60000);
    // nextRunAt must be recomputed from the new interval
    expect(sc.schedule?.nextRunAt).toBeTruthy();
  });

  test("interval happy path: { intervalMs: 120000 } on interval schedule succeeds and nextRunAt updates", async () => {
    const server = buildServer();
    const schedule = await createScheduledTask({
      name: `mcp-interval-update-${Date.now()}`,
      intervalMs: 60000,
      taskTemplate: "heartbeat task",
      createdByAgentId: creatorId,
      timezone: "UTC",
    });

    const result = await callUpdateSchedule(
      server,
      { scheduleId: schedule.id, intervalMs: 120000 },
      creatorId,
    );
    const sc = structured(result);

    expect(sc.success).toBe(true);
    expect(sc.schedule?.intervalMs).toBe(120000);
    expect(sc.schedule?.nextRunAt).toBeTruthy();
  });
});
