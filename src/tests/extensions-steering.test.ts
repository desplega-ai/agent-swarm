import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getChildTasks,
  getDbClient,
  getKv,
  getLogsByTaskId,
  getSteeringMessagesForTask,
  getTaskById,
  initDb,
  pauseTask,
  startTask,
} from "../be/db";
import { getExtensionByName, installExtension, listExtensionRuns } from "../be/extensions/db";
import { requestSteering, SteeringBlockedError } from "../be/steering";
import type { TaskSteerEvent } from "../extensions/contract";
import { enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handleTasks } from "../http/tasks";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import * as slackApp from "../slack/app";
import { requestSlackThreadSteering } from "../slack/steering";
import { bufferThreadMessage, instantFlush } from "../slack/thread-buffer";
import { steerTaskHandler } from "../tools/steer-task";
import { ownerCtx } from "../tools/task-tool-ctx";
import { loadBundleFixture } from "./fixtures/extensions/load";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = `./test-extensions-steering-${process.pid}.sqlite`;
const ENV_KEYS = [
  "STEERING_ENABLED",
  "SLACK_THREAD_STEERING",
  "SLACK_THREAD_STEERING_MODE",
  "SLACK_RENDER_V2",
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
let leadId: string;
let server: Server;
let baseUrl: string;

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function installPolicy(config: Record<string, unknown>, name = "steering-policy") {
  const bundle = await loadBundleFixture("steering-policy");
  const installed = await installExtension({
    ...bundle,
    manifest: { ...bundle.manifest, name },
    config,
  });
  return await enableExtension(installed.extension.id);
}

async function runningTask() {
  const task = await createTaskExtended("Existing task", {
    agentId: leadId,
    source: "slack",
    slackChannelId: "C_STEER_POLICY",
    slackThreadTs: "1000.0001",
  });
  await startTask(task.id);
  return task;
}

async function lastEvent(name = "steering-policy"): Promise<TaskSteerEvent | undefined> {
  const extension = await getExtensionByName(name);
  return (await getKv(`task:agent:${extension?.agentId}`, `ext:${name}:last`))?.value as
    | TaskSteerEvent
    | undefined;
}

async function expectNoSteering(taskId: string) {
  expect(await getSteeringMessagesForTask(taskId)).toEqual([]);
  expect(
    (await getLogsByTaskId(taskId)).filter((log) => log.eventType === "task_steering"),
  ).toEqual([]);
  expect(await getChildTasks(taskId)).toEqual([]);
}

describe("extension steering boundary", () => {
  beforeAll(async () => {
    process.env.STEERING_ENABLED = "true";
    process.env.SLACK_THREAD_STEERING = "lead";
    process.env.SLACK_THREAD_STEERING_MODE = "queue";
    process.env.SLACK_RENDER_V2 = "false";
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      const path = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
      if (await handleMcpBridge(req, res, path, new URLSearchParams(), leadId)) return;
      await handleTasks(req, res, path, new URLSearchParams(), leadId);
    });
    baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM kv_entries WHERE key LIKE 'ext:%'");
    await client.run("DELETE FROM agents");
    leadId = (
      await createAgent({
        name: "Steering policy lead",
        isLead: true,
        status: "busy",
        maxTasks: 10,
        harnessProvider: "pi",
      })
    ).id;
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    await removeDbFiles();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("continue records the task, source, mode and sender before queuing the original text", async () => {
    await installPolicy({ action: "continue" });
    const task = await runningTask();
    const result = await requestSteering({
      taskId: task.id,
      message: "Add the charts",
      mode: "steer",
      source: "mcp",
      createdByKind: "agent",
      createdByAgentId: leadId,
    });
    expect(result.outcome).toBe("steered");
    expect(await lastEvent()).toMatchObject({
      task: { id: task.id, status: "in_progress" },
      message: "Add the charts",
      mode: "steer",
      source: "mcp",
      sender: { kind: "agent", agentId: leadId },
    });
    expect((await getSteeringMessagesForTask(task.id))[0]?.body).toBe("Add the charts");
  });

  test("valid modifications flow through successive handlers and are the only text delivered", async () => {
    await installPolicy({ action: "modify", prefix: "first: " });
    await installPolicy({ action: "modify", prefix: "second: " }, "steering-policy-z");
    const task = await runningTask();
    await requestSteering({ taskId: task.id, message: "Add the charts" });
    expect((await lastEvent("steering-policy-z"))?.message).toBe("first: Add the charts");
    expect((await getSteeringMessagesForTask(task.id))[0]?.body).toBe(
      "second: first: Add the charts",
    );
  });

  test("block returns an actionable refusal without steering rows, logs or follow-up tasks", async () => {
    const extension = await installPolicy({ action: "block" });
    const task = await runningTask();
    try {
      await requestSteering({ taskId: task.id, message: "Do not deliver" });
      throw new Error("Expected steering to be blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(SteeringBlockedError);
      expect(error).toMatchObject({
        statusCode: 403,
        extension: { id: extension.id },
        reason: "Steering denied by policy",
      });
    }
    await expectNoSteering(task.id);
    expect((await listExtensionRuns(extension.id)).map((run) => run.action)).toEqual(["block"]);
  });

  test("a blocked paused task is not resumed", async () => {
    await installPolicy({ action: "block" });
    const task = await runningTask();
    await pauseTask(task.id);
    await expect(
      requestSteering({ taskId: task.id, message: "Do not resume" }),
    ).rejects.toBeInstanceOf(SteeringBlockedError);
    expect((await getTaskById(task.id))?.status).toBe("paused");
    await expectNoSteering(task.id);
  });

  for (const action of ["empty", "retarget", "throw"]) {
    test(`${action} fails open and records an extension error`, async () => {
      const extension = await installPolicy({ action });
      const task = await runningTask();
      await requestSteering({ taskId: task.id, message: "Keep the original" });
      expect((await getSteeringMessagesForTask(task.id))[0]?.body).toBe("Keep the original");
      expect((await listExtensionRuns(extension.id))[0]?.action).toBe("error");
    });
  }

  test("valid rewritten text is secret-scrubbed before storage", async () => {
    const secret = `sk-ant-${"a".repeat(40)}`;
    await installPolicy({ action: "modify", prefix: `${secret} ` });
    const task = await runningTask();
    await requestSteering({ taskId: task.id, message: "Keep this" });
    const body = (await getSteeringMessagesForTask(task.id))[0]?.body;
    expect(body).not.toContain(secret);
    expect(body).toContain("Keep this");
  });

  test("extension-originated steering skips its own handler", async () => {
    const extension = await installPolicy({ action: "block" });
    const task = await runningTask();
    await requestSteering({
      taskId: task.id,
      message: "From the extension",
      createdByKind: "agent",
      createdByAgentId: extension.agentId!,
    });
    expect(await lastEvent()).toBeUndefined();
    expect((await getSteeringMessagesForTask(task.id))[0]?.body).toBe("From the extension");
  });

  test("HTTP steering returns 403 for a policy block", async () => {
    await installPolicy({ action: "block" });
    const task = await runningTask();
    const response = await fetch(`${baseUrl}/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": leadId },
      body: JSON.stringify({ message: "Do not deliver" }),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Steering denied by policy");
    await expectNoSteering(task.id);
  });

  test("MCP steering reports a policy block as a tool error", async () => {
    await installPolicy({ action: "block" });
    const task = await runningTask();
    const result = await steerTaskHandler(ownerCtx({ agentId: leadId }), {
      taskId: task.id,
      message: "Do not deliver",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Steering denied by policy");
    expect(await lastEvent()).toMatchObject({ source: "mcp" });
    await expectNoSteering(task.id);
  });

  test("script SDK steering reaches the hook through the bridge with the script source", async () => {
    await installPolicy({ action: "continue" });
    const task = await runningTask();
    const sdk = createSwarmSdk(
      new SwarmConfig({
        system: {
          apiKey: { value: "steering-sdk-test-key", isSecret: true },
          agentId: { value: leadId, isSecret: false },
          mcpBaseUrl: { value: baseUrl, isSecret: false },
        },
        user: {},
      }),
    );

    const result = await sdk.task_steer({ taskId: task.id, message: "From the script SDK" });

    expect(result).toMatchObject({
      success: true,
      status: 200,
      data: { success: true, outcome: "queued" },
    });
    expect(await lastEvent()).toMatchObject({
      task: { id: task.id },
      message: "From the script SDK",
      mode: "queue",
      source: "script",
      sender: { kind: "agent", agentId: leadId },
    });
    expect(await getSteeringMessagesForTask(task.id)).toEqual([
      expect.objectContaining({ source: "script", body: "From the script SDK" }),
    ]);
  });

  test("Slack supplies message timestamps and sender metadata without acknowledgement log rows on block", async () => {
    await installPolicy({ action: "block" });
    const task = await runningTask();
    const user = await createUser({ name: "Steering sender" });
    await expect(
      requestSlackThreadSteering({
        channelId: "C_STEER_POLICY",
        threadTs: "1000.0001",
        message: "Do not deliver",
        messageTimestamps: ["1000.0002", "1000.0003"],
        requestedByUserId: user.id,
        slackUserId: "U_SENDER",
      }),
    ).rejects.toBeInstanceOf(SteeringBlockedError);
    expect(await lastEvent()).toMatchObject({
      source: "slack",
      sender: { kind: "user", userId: user.id },
      messageTimestamps: ["1000.0002", "1000.0003"],
      slack: { channelId: "C_STEER_POLICY", threadTs: "1000.0001", userId: "U_SENDER" },
    });
    await expectNoSteering(task.id);
  });

  test("a blocked buffer flush is consumed and later senders still get delivered", async () => {
    await installPolicy({ action: "block", slackUserId: "U_BLOCKED" });
    const task = await runningTask();
    const acked: string[] = [];
    const posted: string[] = [];
    const appSpy = spyOn(slackApp, "getSlackApp").mockReturnValue({
      client: {
        users: { info: async () => ({ ok: false }) },
        reactions: {
          add: async (args: { timestamp: string; name: string }) => {
            acked.push(`${args.timestamp}:${args.name}`);
            return { ok: true };
          },
          remove: async () => ({ ok: true }),
        },
        chat: {
          postMessage: async (args: { text: string }) => {
            posted.push(args.text);
            return { ok: true };
          },
        },
      },
    } as unknown as NonNullable<ReturnType<typeof slackApp.getSlackApp>>);
    try {
      bufferThreadMessage("C_STEER_POLICY", "1000.0001", "Drop this", "U_BLOCKED", "1000.0002");
      bufferThreadMessage("C_STEER_POLICY", "1000.0001", "Keep this", "U_ALLOWED", "1000.0003");
      await instantFlush("C_STEER_POLICY:1000.0001");
      expect((await getSteeringMessagesForTask(task.id)).map((row) => row.body)).toEqual([
        "Keep this",
      ]);
      expect(acked).toContain("1000.0002:no_entry");
      expect(posted).toHaveLength(1);
      expect(await getChildTasks(task.id)).toEqual([]);
      expect(
        (await getLogsByTaskId(task.id)).filter((log) => log.newValue === "slack_reaction"),
      ).toEqual([expect.objectContaining({ metadata: expect.stringContaining("1000.0003") })]);
    } finally {
      appSpy.mockRestore();
    }
  });
});
