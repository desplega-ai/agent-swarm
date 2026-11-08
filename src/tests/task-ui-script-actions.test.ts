/**
 * Card `script` actions: write-time checks, the pinned allowlist, the lease
 * lock and cooldown, and the in-place card refresh. The script runtime is
 * stubbed; everything else runs on a real DB.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { insertScript, upsertScriptByName } from "../be/scripts/db";
import * as runSavedModule from "../be/scripts/run-saved";
import { acquireTaskUiScriptActionRun, getTaskUiSpec, upsertTaskUiSpec } from "../be/task-ui-spec";
import { registerStoreProgressTool } from "../tools/store-progress";
import { runTaskUiAction } from "../ui-spec/actions";
import { scriptActionIssues, TASK_UI_SPEC_UPDATED_EVENT } from "../ui-spec/script-actions";
import type { TaskUiSpec, TaskUiSpecDocument } from "../utils/task-ui-spec";
import { workflowEventBus } from "../workflows/event-bus";

const dbPath = `/tmp/test-task-ui-script-actions-${crypto.randomUUID()}.sqlite`;
const SCRIPT = "deploy-metrics";
const previousEnv = {
  UI_SPEC_ENABLED: process.env.UI_SPEC_ENABLED,
  UI_SPEC_ACTIONS_ENABLED: process.env.UI_SPEC_ACTIONS_ENABLED,
  UI_SPEC_SCRIPT_ACTIONS: process.env.UI_SPEC_SCRIPT_ACTIONS,
};

type RunOutput = Awaited<ReturnType<typeof runSavedModule.runSavedScriptAsAgent>>;
const ok = (result: unknown): RunOutput => ({
  result,
  stdout: "",
  stderr: "",
  truncated: { stdout: false, stderr: false },
  durationMs: 5,
  exitCode: 0,
});
const runSpy = spyOn(runSavedModule, "runSavedScriptAsAgent");

let agentId = "";
let requesterId = "";
let otherUserId = "";
let contentHash = "";

const card = (title: string, withButton = true): TaskUiSpecDocument => ({
  root: "c",
  elements: {
    c: { type: "Card", props: { title }, children: withButton ? ["a"] : [] },
    a: { type: "Actions", props: {}, children: ["b"] },
    b: { type: "Button", props: { id: "refresh", label: "Refresh" }, children: [] },
  },
});
const refreshAction = { kind: "script" as const, script: SCRIPT, args: { repo: "agent-swarm" } };
const pin = (hash = contentHash) => `${SCRIPT}@${hash.slice(0, 12)}`;

async function taskWithRefresh(): Promise<string> {
  const task = await createTaskExtended("Deploy metrics", {
    agentId,
    source: "api",
    requestedByUserId: requesterId,
  });
  await upsertTaskUiSpec(task.id, {
    spec: card("Deploys: 1"),
    actions: { refresh: refreshAction },
    fallbackText: "Deploys: 1",
  });
  return task.id;
}

const click = (taskId: string, actorUserId = requesterId) =>
  runTaskUiAction({ taskId, actionId: "refresh", surface: "web", actorUserId });

const runRow = (taskId: string) =>
  getDbClient().get<{ runCount: number; lastError: string | null; lockedUntil: string | null }>(
    `SELECT run_count AS runCount, last_error AS lastError, locked_until AS lockedUntil
    FROM task_ui_action_runs WHERE task_id = ? AND action_id = 'refresh'`,
    [taskId],
  );

/** Moves the last run back past the cooldown. */
const expireCooldown = (taskId: string) =>
  getDbClient().run(
    "UPDATE task_ui_action_runs SET last_run_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?",
    [taskId],
  );

beforeAll(async () => {
  initDb(dbPath);
  agentId = (
    await createAgent({
      name: "script action test",
      role: "worker",
      isLead: false,
      status: "busy",
      capabilities: [],
    })
  ).id;
  requesterId = (await createUser({ name: "Requester" })).id;
  otherUserId = (await createUser({ name: "Bystander" })).id;
  contentHash = (
    await insertScript({
      name: SCRIPT,
      scope: "global",
      source: "export default async () => ({})",
      description: "Deploy metrics card",
      intent: "Refresh a metrics card",
      signatureJson: "{}",
      argsJsonSchema: JSON.stringify({
        type: "object",
        properties: { repo: { type: "string" } },
        required: ["repo"],
      }),
      embeddingMode: "skip",
    })
  ).contentHash;
});

afterAll(async () => {
  runSpy.mockRestore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(dbPath + suffix, { force: true })));
});

beforeEach(() => {
  process.env.UI_SPEC_ENABLED = "true";
  process.env.UI_SPEC_ACTIONS_ENABLED = "true";
  process.env.UI_SPEC_SCRIPT_ACTIONS = pin();
  runSpy.mockReset();
  runSpy.mockImplementation(async () =>
    ok({ spec: card(`Deploys: ${runSpy.mock.calls.length + 1}`) }),
  );
});

describe("write-time checks", () => {
  test("a pinned global script with valid args passes", async () => {
    expect(await scriptActionIssues({ refresh: refreshAction })).toEqual([]);
  });

  test("a name not on the allowlist is refused", async () => {
    process.env.UI_SPEC_SCRIPT_ACTIONS = "other@0123456789ab";
    expect((await scriptActionIssues({ refresh: refreshAction }))[0]).toContain(
      "is not allowlisted in UI_SPEC_SCRIPT_ACTIONS",
    );
  });

  test("a hash that does not match the script reads as changed, not as unlisted", async () => {
    process.env.UI_SPEC_SCRIPT_ACTIONS = `${SCRIPT}@ffffffffffff`;
    expect((await scriptActionIssues({ refresh: refreshAction }))[0]).toContain(
      "changed since it was allowlisted",
    );
  });

  test("a script that is not global is refused", async () => {
    process.env.UI_SPEC_SCRIPT_ACTIONS = "agent-only@0123456789ab";
    await insertScript({
      name: "agent-only",
      scope: "agent",
      scopeId: agentId,
      source: "export default async () => ({})",
      description: "d",
      intent: "i",
      signatureJson: "{}",
      embeddingMode: "skip",
    });
    const action = { kind: "script" as const, script: "agent-only" };
    expect((await scriptActionIssues({ refresh: action }))[0]).toContain("is not a global script");
  });

  test("oversized args and args that fail the schema are refused", async () => {
    const big = { ...refreshAction, args: { repo: "x".repeat(5000) } };
    expect((await scriptActionIssues({ refresh: big }))[0]).toContain("the limit is 4096");
    const wrong = { ...refreshAction, args: { repo: 7 } };
    expect((await scriptActionIssues({ refresh: wrong }))[0]).toContain("argsJsonSchema");
  });

  test("the action flag is required", async () => {
    process.env.UI_SPEC_ACTIONS_ENABLED = "false";
    expect((await scriptActionIssues({ refresh: refreshAction }))[0]).toContain(
      "UI_SPEC_ACTIONS_ENABLED",
    );
  });

  test("store-progress refuses an unlisted script action once", async () => {
    process.env.UI_SPEC_SCRIPT_ACTIONS = "";
    const server = new McpServer({ name: "script-action-test", version: "1" });
    registerStoreProgressTool(server);
    const handler = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (
              a: unknown,
              m: unknown,
            ) => Promise<{ structuredContent: { success: boolean; message: string } }>;
          }
        >;
      }
    )._registeredTools["store-progress"]!.handler;
    const task = await createTaskExtended("Refuse script", { agentId, source: "system" });
    await startTask(task.id);
    const args = {
      taskId: task.id,
      status: "completed",
      output: "Done",
      uiSpec: { spec: card("Deploys"), actions: { refresh: refreshAction } },
    };
    const meta = { requestInfo: { headers: { "x-agent-id": agentId } } };
    const refused = await handler(args, meta);
    expect(refused.structuredContent.success).toBe(false);
    expect(refused.structuredContent.message).toContain("is not allowlisted");
    const accepted = await handler(args, meta);
    expect(accepted.structuredContent.success).toBe(true);
    expect((await getTaskById(task.id))?.status).toBe("completed");
    expect(await getTaskUiSpec(task.id)).toBeNull();
  });
});

describe("runTaskUiAction with a script action", () => {
  test("a click runs the script with the frozen args and replaces the card", async () => {
    const taskId = await taskWithRefresh();
    const events: unknown[] = [];
    const onEvent = (data: unknown) => events.push(data);
    workflowEventBus.on(TASK_UI_SPEC_UPDATED_EVENT, onEvent);
    try {
      const result = await click(taskId);
      expect(result.status).toBe("refreshed");
      expect(runSpy).toHaveBeenCalledTimes(1);
      const call = runSpy.mock.calls[0]![0];
      expect(call.input).toEqual({ repo: "agent-swarm" });
      expect(call.agentId).toBe(agentId);
      const stored = (await getTaskUiSpec(taskId)) as TaskUiSpec;
      expect((stored.spec.elements.c as { props: { title: string } }).props.title).toBe(
        "Deploys: 2",
      );
      // The script returned no actions, so the stored Refresh carries over.
      expect(stored.actions).toEqual({ refresh: refreshAction });
      expect(stored.fallbackText).toContain("Deploys: 2");
      expect((await runRow(taskId))?.runCount).toBe(1);
      expect(events).toEqual([{ taskId }]);
    } finally {
      workflowEventBus.off(TASK_UI_SPEC_UPDATED_EVENT, onEvent);
    }
  });

  test("inside the cooldown a click is rate limited; after it the script runs again", async () => {
    const taskId = await taskWithRefresh();
    expect((await click(taskId)).status).toBe("refreshed");
    const second = await click(taskId);
    expect(second).toMatchObject({ status: "rate_limited" });
    expect((second as { retryAfterSec: number }).retryAfterSec).toBeGreaterThan(0);
    await expireCooldown(taskId);
    expect((await click(taskId)).status).toBe("refreshed");
    expect((await runRow(taskId))?.runCount).toBe(2);
  });

  test("a held lease answers running; an expired lease is reclaimed", async () => {
    const taskId = await taskWithRefresh();
    const lease = {
      taskId,
      actionId: "refresh",
      surface: "web" as const,
      leaseMs: 45_000,
      cooldownMs: 30_000,
    };
    expect((await acquireTaskUiScriptActionRun(lease)).status).toBe("acquired");
    expect((await click(taskId)).status).toBe("running");
    expect(runSpy).not.toHaveBeenCalled();
    // The holder crashed: a minute later its lease has run out.
    const later = await acquireTaskUiScriptActionRun({ ...lease, nowMs: Date.now() + 60_000 });
    expect(later.status).toBe("acquired");
  });

  test("five concurrent clicks run the script once", async () => {
    const taskId = await taskWithRefresh();
    const results = await Promise.all(Array.from({ length: 5 }, () => click(taskId)));
    expect(results.filter((r) => r.status === "refreshed")).toHaveLength(1);
    expect(results.every((r) => ["refreshed", "running", "rate_limited"].includes(r.status))).toBe(
      true,
    );
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  test("invalid output keeps the old card and records the error", async () => {
    const taskId = await taskWithRefresh();
    runSpy.mockImplementation(async () => ok({ spec: { root: "x", elements: {} } }));
    const result = await click(taskId);
    expect(result.status).toBe("invalid_output");
    expect((await getTaskUiSpec(taskId))?.fallbackText).toBe("Deploys: 1");
    expect((await runRow(taskId))?.lastError).toBeTruthy();
    const log = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM agent_log WHERE taskId = ? AND eventType = 'task_ui_script_action_failed'",
      [taskId],
    );
    expect(log?.n).toBe(1);
  });

  test("a Button naming an undeclared action in the output is invalid", async () => {
    const taskId = await taskWithRefresh();
    runSpy.mockImplementation(async () =>
      ok({ spec: card("New"), actions: { other: { kind: "follow_up", prompt: "go" } } }),
    );
    const result = await click(taskId);
    expect(result).toMatchObject({ status: "invalid_output" });
    expect((result as { error: string }).error).toContain('names action "refresh"');
  });

  test("a failed script keeps the old card", async () => {
    const taskId = await taskWithRefresh();
    runSpy.mockImplementation(async () => ({ ...ok(undefined), exitCode: 1 }));
    expect(await click(taskId)).toEqual({ status: "script_failed", error: "script exited 1" });
    expect((await getTaskUiSpec(taskId))?.fallbackText).toBe("Deploys: 1");
    expect((await runRow(taskId))?.lockedUntil).toBeNull();
  });

  test("a name removed from the allowlist after write is refused at click", async () => {
    const taskId = await taskWithRefresh();
    process.env.UI_SPEC_SCRIPT_ACTIONS = "";
    expect((await click(taskId)).status).toBe("not_allowlisted");
    expect(runSpy).not.toHaveBeenCalled();
  });

  test("an edited script disarms the card until it is re-pinned", async () => {
    const taskId = await taskWithRefresh();
    const edited = await upsertScriptByName({
      name: SCRIPT,
      scope: "global",
      source: "export default async () => ({ changed: true })",
      description: "Deploy metrics card",
      intent: "Refresh a metrics card",
      signatureJson: "{}",
      embeddingMode: "skip",
    });
    try {
      expect((await click(taskId)).status).toBe("script_changed");
      expect(runSpy).not.toHaveBeenCalled();
      process.env.UI_SPEC_SCRIPT_ACTIONS = pin(edited.script.contentHash);
      expect((await click(taskId)).status).toBe("refreshed");
    } finally {
      contentHash = edited.script.contentHash;
    }
  });

  test("only the requester may click", async () => {
    const taskId = await taskWithRefresh();
    expect((await click(taskId, otherUserId)).status).toBe("forbidden");
    expect(runSpy).not.toHaveBeenCalled();
  });

  test("a follow_up action still runs once only", async () => {
    const task = await createTaskExtended("Follow-up once", {
      agentId,
      source: "api",
      requestedByUserId: requesterId,
    });
    await upsertTaskUiSpec(task.id, {
      spec: card("Deploys"),
      actions: { refresh: { kind: "follow_up", prompt: "Run it again." } },
      fallbackText: "Deploys",
    });
    expect((await click(task.id)).status).toBe("started");
    expect((await click(task.id)).status).toBe("already_done");
  });
});
