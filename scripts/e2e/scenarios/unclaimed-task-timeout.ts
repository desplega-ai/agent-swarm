import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const STALL_MINUTES = "1";
const FAIL_MINUTES = "2";
const WAIT_FOR_BOUNDARY_MS = 61_000;

type ConfigRow = { id: string };
type TaskRow = { status: string; failureReason: string | null };
type LogRow = { metadata: string | null };

export const unclaimedTaskTimeout: Scenario = {
  name: "unclaimed-task-timeout",
  async run(ctx) {
    const configIds: string[] = [];
    try {
      for (const [key, value] of [
        ["HEARTBEAT_UNCLAIMED_STALL_MIN", STALL_MINUTES],
        ["HEARTBEAT_UNCLAIMED_FAIL_MIN", FAIL_MINUTES],
      ] as const) {
        const response = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", scopeId: null, key, value, isSecret: false },
        });
        expectStatus(response, [200], `set ${key}`);
        const id = asRecord(response.json).id;
        expect(typeof id === "string", `${key} config response has no id`);
        configIds.push(id);
      }
      expectStatus(
        await ctx.api("POST", "/api/config/reload", { body: {} }),
        [200],
        "reload unclaimed timeout config",
      );

      const workerResponse = await ctx.api("POST", "/api/agents", {
        body: { name: `e2e-offline-${ctx.nonce}`, role: "worker", status: "offline" },
      });
      expectStatus(workerResponse, [201], "register offline worker");
      const agentId = asRecord(workerResponse.json).id;
      expect(typeof agentId === "string", "Registered offline worker has no id");

      const taskResponse = await ctx.api("POST", "/api/tasks", {
        body: { task: `E2E unclaimed timeout ${ctx.nonce}`, agentId, source: "api" },
      });
      expectStatus(taskResponse, [201], "create unclaimed task");
      const taskId = asRecord(taskResponse.json).id;
      expect(typeof taskId === "string", "Created unclaimed task has no id");

      await Bun.sleep(WAIT_FOR_BOUNDARY_MS);
      expectStatus(
        await ctx.api("POST", "/api/heartbeat/sweep", { body: {} }),
        [200],
        "trigger warning sweep",
      );

      let task = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(task, [200], "read warned task");
      const warned = asRecord(task.json);
      expect(warned.status === "pending", `Warned task has unexpected status ${warned.status}`);
      expect(
        warned.progress === "Waiting to start: The assigned agent has not claimed this task.",
        `Warned task has unexpected progress: ${String(warned.progress)}`,
      );

      const warningLog = ctx.db.get<LogRow>(
        "SELECT metadata FROM agent_log WHERE taskId = ? AND eventType = 'task_progress' ORDER BY createdAt DESC LIMIT 1",
        [taskId],
      );
      const warningMetadata = warningLog?.metadata ? JSON.parse(warningLog.metadata) : null;
      expect(
        warningMetadata?.stalled === true && warningMetadata?.reason === "no_agent",
        `Warning did not carry failure class no_agent: ${warningLog?.metadata ?? "<missing log>"}`,
      );

      await Bun.sleep(WAIT_FOR_BOUNDARY_MS);
      expectStatus(
        await ctx.api("POST", "/api/heartbeat/sweep", { body: {} }),
        [200],
        "trigger failure sweep",
      );

      task = await ctx.api("GET", `/api/tasks/${taskId}`);
      expectStatus(task, [200], "read failed task");
      const failed = asRecord(task.json);
      expect(failed.status === "failed", `Unclaimed task ended with status ${failed.status}`);
      expect(
        failed.failureReason === "The assigned agent has not claimed this task.",
        `Unclaimed task has unexpected failure reason: ${String(failed.failureReason)}`,
      );

      const row = ctx.db.get<TaskRow>(
        "SELECT status, failureReason FROM agent_tasks WHERE id = ?",
        [taskId],
      );
      expect(
        row?.status === "failed" && row.failureReason === failed.failureReason,
        `agent_tasks row did not persist the terminal failure: ${JSON.stringify(row)}`,
      );
    } finally {
      for (const id of configIds) {
        await ctx.api("DELETE", `/api/config/${id}`);
      }
      if (configIds.length > 0) {
        await ctx.api("POST", "/api/config/reload", { body: {} });
      }
    }
  },
};
