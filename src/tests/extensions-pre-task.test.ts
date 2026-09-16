import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  completeTask,
  createAgent,
  createScheduledTask,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  getKv,
  getTaskByWorkflowRunStepId,
  initDb,
  startTask,
} from "../be/db";
import * as dbClient from "../be/db-client";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { disableExtension, enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { handleTasks } from "../http/tasks";
import { dispatchScheduleTarget } from "../scheduler/scheduler";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerSendTaskTool } from "../tools/send-task";
import { registerTaskActionTool } from "../tools/task-action";
import { markExtensionRequestOrigin } from "../tools/utils";
import type { ExtensionInstallBody } from "../types";
import { workflowEventBus } from "../workflows/event-bus";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import { loadBundleFixture } from "./fixtures/extensions/load";

const TEST_DB_PATH = "./test-extensions-pre-task.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

async function installAndEnable(name: string, config?: Record<string, unknown>) {
  const bundle = await loadBundleFixture(name);
  const installed = await installExtension({ ...bundle, config });
  return await enableExtension(installed.extension.id);
}

async function installSource(name: string, hooks: string) {
  const template = await loadBundleFixture("minimal");
  const bundle: ExtensionInstallBody = {
    manifest: { ...template.manifest, name, description: name },
    files: { "hooks.ts": hooks },
  };
  const installed = await installExtension(bundle);
  return await enableExtension(installed.extension.id);
}

type TestResponse = { status: number; body: Record<string, unknown> };

async function postTask(body: Record<string, unknown>): Promise<TestResponse> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = "/api/tasks";
  req.headers = { "content-type": "application/json" };
  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  expect(await handleTasks(req, res, ["api", "tasks"], new URLSearchParams(), undefined)).toBe(
    true,
  );
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

function registeredSendTask(server: McpServer) {
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<Record<string, unknown>> }
      >;
    }
  )._registeredTools["send-task"]!;
}

function registeredTaskAction(server: McpServer) {
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<Record<string, unknown>> }
      >;
    }
  )._registeredTools["task-action"]!;
}

function sendTaskArgs(task: string) {
  return {
    task,
    offerMode: false,
    leadOnly: false,
    allowDuplicate: true,
    overrideSlackContext: false,
  };
}

describe("extension task boundaries", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    await stopExtensionRuntime();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    await stopExtensionRuntime();
    const client = getDbClient();
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM extensions");
    await client.run("DELETE FROM agents");
  });

  test("REST task creation applies rewrites and reports blocks as 422", async () => {
    const rewrite = await installAndEnable("rewrite-task-priority");
    const created = await postTask({ task: "rewrite this task" });
    expect(created.status).toBe(201);
    expect(created.body.priority).toBe(1);
    expect(await listExtensionRuns(rewrite.id)).toMatchObject([
      { event: "pre.task.create", action: "modify" },
    ]);

    await stopExtensionRuntime();
    await getDbClient().run("DELETE FROM extensions");
    const blocker = await installAndEnable("block-tasks-from-source", { source: "rest" });
    const blocked = await postTask({ task: "block this task" });
    expect(blocked.body.extension).toMatchObject({ name: "block-tasks-from-source" });
    expect(blocked).toEqual({
      status: 422,
      body: {
        error: "Task source rest is blocked",
        extension: { id: blocker.id, name: "block-tasks-from-source" },
      },
    });

    await disableExtension(blocker.id);
    const retried = await postTask({ task: "block this task" });
    expect(retried.status).toBe(201);
  });

  test("scheduler and workflow executor provide their task creation origins", async () => {
    const extension = await installSource(
      "record-task-origin",
      `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", async (event, ctx) => {
    await ctx.state.set(event.description, event.origin);
  });
};
export default extension;
`,
    );
    const schedule = await createScheduledTask({
      name: "extension-origin-schedule",
      taskTemplate: "scheduled-origin-task",
      intervalMs: 60_000,
    });
    // The production path creates the task inside a transaction; hooks must still fire.
    const dispatched = await dispatchScheduleTarget(schedule);
    expect(dispatched.task?.scheduleId).toBe(schedule.id);
    expect(
      (
        await getKv(
          `task:agent:${extension.agentId}`,
          "ext:record-task-origin:scheduled-origin-task",
        )
      )?.value,
    ).toBe("schedule");

    const workflow = await createWorkflow({
      name: "extension-origin-workflow",
      definition: { nodes: [], edges: [] },
    });
    const run = await createWorkflowRun({ id: crypto.randomUUID(), workflowId: workflow.id });
    const step = await createWorkflowRunStep({
      id: crypto.randomUUID(),
      runId: run.id,
      nodeId: "origin-task",
      nodeType: "agent-task",
    });
    const executor = new AgentTaskExecutor({
      db: await import("../be/db"),
      eventBus: workflowEventBus,
      interpolate: (template) => template,
    });
    const result = await executor.run({
      config: { template: "workflow-origin-task" },
      context: {},
      meta: {
        runId: run.id,
        stepId: step.id,
        nodeId: "origin-task",
        workflowId: workflow.id,
        dryRun: false,
      },
    });
    expect(result.status).toBe("success");
    expect((await getTaskByWorkflowRunStepId(step.id))?.source).toBe("workflow");
    expect(
      (
        await getKv(
          `task:agent:${extension.agentId}`,
          "ext:record-task-origin:workflow-origin-task",
        )
      )?.value,
    ).toBe("workflow");
  });

  test("send-task dispatches before its transaction and returns a tool error on block", async () => {
    await installAndEnable("block-tasks-from-source", { source: "mcp" });
    const caller = await createAgent({ name: "pre-task-caller", isLead: false, status: "idle" });
    const observed: boolean[] = [];
    const original = dbClient.isInTransaction;
    const transactionSpy = spyOn(dbClient, "isInTransaction").mockImplementation(() => {
      const active = original();
      observed.push(active);
      return active;
    });
    try {
      const server = new McpServer({ name: "pre-task-send", version: "1.0.0" });
      registerSendTaskTool(server);
      const result = await registeredSendTask(server).handler(sendTaskArgs("blocked tool task"), {
        sessionId: "pre-task",
        requestInfo: { headers: { "x-agent-id": caller.id } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("Task source mcp is blocked");
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((active) => active === false)).toBe(true);
    } finally {
      transactionSpy.mockRestore();
    }
  });

  test("task-action create returns a tool error when an extension blocks creation", async () => {
    await installAndEnable("block-tasks-from-source", { source: "mcp" });
    const caller = await createAgent({
      name: "pre-task-action-caller",
      isLead: false,
      status: "idle",
    });
    const server = new McpServer({ name: "pre-task-action", version: "1.0.0" });
    registerTaskActionTool(server);
    const result = await registeredTaskAction(server).handler(
      { action: "create", task: "blocked action task", leadOnly: false },
      {
        sessionId: "pre-task-action",
        requestInfo: { headers: { "x-agent-id": caller.id } },
      },
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Task source mcp is blocked");
  });

  test("drops derived fields and fails open for invalid option rewrites", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await installSource(
        "drop-task-status",
        `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: { status: "draft" } as never }));
};
export default extension;
`,
      );
      const task = await createTaskWithSiblingAwareness("keep task status", { source: "api" });
      expect(task.status).toBe("unassigned");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('ignored disallowed key "status"'),
      );
    } finally {
      warning.mockRestore();
    }

    await stopExtensionRuntime();
    await getDbClient().run("DELETE FROM extensions");
    const invalid = await installSource(
      "invalid-task-priority",
      `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: { priority: "urgent" } as never }));
};
export default extension;
`,
    );
    const task = await createTaskWithSiblingAwareness("keep task priority", { source: "api" });
    expect(task.priority).toBe(50);
    expect(await listExtensionRuns(invalid.id)).toMatchObject([
      { event: "pre.task.create", action: "error" },
    ]);
  });

  test("extension tool calls derive their origin and skip the creating extension", async () => {
    const creator = await installAndEnable("rewrite-task-priority");
    await installAndEnable("block-tasks-from-source", {
      source: "extension:rewrite-task-priority",
    });
    const server = new McpServer({ name: "extension-origin-send", version: "1.0.0" });
    registerSendTaskTool(server);
    const extra = markExtensionRequestOrigin({
      sessionId: "extension",
      requestInfo: { headers: { "x-agent-id": creator.agentId! } },
    });
    const result = await registeredSendTask(server).handler(
      sendTaskArgs("extension-created task"),
      extra,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      "Task source extension:rewrite-task-priority is blocked",
    );
    expect(await listExtensionRuns(creator.id)).toEqual([]);
  });

  test("follow-up hooks suppress Slack tasks and preserve normal follow-up creation", async () => {
    const extension = await installAndEnable("suppress-lead-follow-up");
    const lead = await createAgent({ name: "follow-up-lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "follow-up-worker", isLead: false, status: "idle" });

    const slackTask = await createTaskExtended("Slack work", {
      agentId: worker.id,
      source: "slack",
    });
    await startTask(slackTask.id);
    const completedSlack = await completeTask(slackTask.id, "done in Slack");
    expect(
      await createWorkerTaskFollowUp({
        task: completedSlack!,
        status: "completed",
        output: "done in Slack",
      }),
    ).toBeNull();

    const apiTask = await createTaskExtended("API work", {
      agentId: worker.id,
      source: "api",
    });
    await startTask(apiTask.id);
    const completedApi = await completeTask(apiTask.id, "done by API");
    const followUp = await createWorkerTaskFollowUp({
      task: completedApi!,
      status: "completed",
      output: "done by API",
    });
    expect(followUp).toMatchObject({ agentId: lead.id, parentTaskId: apiTask.id, priority: 50 });

    const chronological = (await listExtensionRuns(extension.id)).reverse();
    expect(chronological.map(({ event, action }) => ({ event, action }))).toEqual([
      { event: "pre.task.followUp", action: "block" },
      { event: "pre.task.followUp", action: "continue" },
      { event: "pre.task.create", action: "continue" },
    ]);

    await disableExtension(extension.id);
    const secondSlackTask = await createTaskExtended("Second Slack work", {
      agentId: worker.id,
      source: "slack",
    });
    await startTask(secondSlackTask.id);
    const secondCompletedSlack = await completeTask(secondSlackTask.id, "done after disable");
    expect(
      await createWorkerTaskFollowUp({
        task: secondCompletedSlack!,
        status: "completed",
        output: "done after disable",
      }),
    ).toMatchObject({ agentId: lead.id, parentTaskId: secondSlackTask.id });
  });

  test("follow-up hooks rewrite the description, assignee, priority, and follow-up config", async () => {
    await createAgent({ name: "rewrite-follow-up-lead", isLead: true, status: "idle" });
    const worker = await createAgent({
      name: "rewrite-follow-up-worker",
      isLead: false,
      status: "idle",
    });
    const alternate = await createAgent({
      name: "rewrite-follow-up-target",
      isLead: false,
      status: "idle",
    });
    await installSource(
      "rewrite-follow-up",
      `import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.followUp", () => modify({
    description: "Review the rewritten result",
    agentId: ${JSON.stringify(alternate.id)},
    priority: 7,
    followUpConfig: { disabled: true },
  }));
};
export default extension;
`,
    );

    const task = await createTaskExtended("Rewrite follow-up source", {
      agentId: worker.id,
      source: "api",
    });
    await startTask(task.id);
    const completed = await completeTask(task.id, "done");
    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "done",
    });

    expect(followUp).toMatchObject({
      task: "Review the rewritten result",
      agentId: alternate.id,
      priority: 7,
      followUpConfig: { disabled: true },
    });
  });

  test("follow-up hooks that violate the task schema are ignored and the follow-up still lands", async () => {
    const lead = await createAgent({
      name: "invalid-follow-up-lead",
      isLead: true,
      status: "idle",
    });
    const worker = await createAgent({
      name: "invalid-follow-up-worker",
      isLead: false,
      status: "idle",
    });
    const extension = await installSource(
      "invalid-follow-up",
      `import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.followUp", () => modify({ priority: -1 }));
};
export default extension;
`,
    );

    const task = await createTaskExtended("Invalid follow-up source", {
      agentId: worker.id,
      source: "api",
    });
    await startTask(task.id);
    const completed = await completeTask(task.id, "done");
    const followUp = await createWorkerTaskFollowUp({
      task: completed!,
      status: "completed",
      output: "done",
    });

    expect(followUp).toMatchObject({ agentId: lead.id, parentTaskId: task.id, priority: 50 });
    const runs = await listExtensionRuns(extension.id);
    expect(runs.some((run) => run.event === "pre.task.followUp" && run.action === "error")).toBe(
      true,
    );
  });
});
