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
  createUser,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  getKv,
  getMostRecentTaskInThread,
  getTaskByWorkflowRunStepId,
  initDb,
  startTask,
} from "../be/db";
import * as dbClient from "../be/db-client";
import type { InstallExtensionArgs as ExtensionInstallBody } from "../be/extensions/db";
import { installExtension, listExtensionRuns } from "../be/extensions/db";
import { getCatalogEntry } from "../extensions/catalog";
import type { TaskBlockedEvent, TaskCreateEvent } from "../extensions/contract";
import { disableExtension, enableExtension, stopExtensionRuntime } from "../extensions/lifecycle";
import { initExtensionPostBridge, teardownExtensionPostBridge } from "../extensions/post-bridge";
import { handleTasks } from "../http/tasks";
import { dispatchScheduleTarget } from "../scheduler/scheduler";
import { bufferThreadMessage, instantFlush } from "../slack/thread-buffer";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { registerSendTaskTool, sendTaskHandler } from "../tools/send-task";
import { registerTaskActionTool } from "../tools/task-action";
import { userCtx } from "../tools/task-tool-ctx";
import { markExtensionRequestOrigin } from "../tools/utils";
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
    await client.run("DELETE FROM users");
    await client.run("DELETE FROM agents");
  });

  describe("post.task.blocked", () => {
    const events: unknown[] = [];
    const capture = (event: unknown) => {
      events.push(event);
    };

    beforeAll(() => {
      initExtensionPostBridge();
      workflowEventBus.on("task.create_blocked", capture);
    });

    afterAll(() => {
      workflowEventBus.off("task.create_blocked", capture);
      teardownExtensionPostBridge();
    });

    beforeEach(() => {
      events.length = 0;
    });

    async function waitForCounter(
      extension: Awaited<ReturnType<typeof installAndEnable>>,
      key: string,
      count = 1,
    ): Promise<void> {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const entry = await getKv(`task:agent:${extension.agentId}`, key);
        if (entry?.value === count) return;
        await Bun.sleep(10);
      }
      throw new Error(`post.task.blocked was not recorded ${count} time(s)`);
    }

    async function recordedBlock(
      extension: Awaited<ReturnType<typeof installAndEnable>>,
      count = 1,
    ): Promise<TaskBlockedEvent> {
      await waitForCounter(extension, "ext:record-blocks:count", count);
      return (await getKv(`task:agent:${extension.agentId}`, "ext:record-blocks:last"))
        ?.value as TaskBlockedEvent;
    }

    test.each([
      "rest",
      "mcp",
      "slack",
      "schedule",
    ] as const)("%s delivers one blocked event with its source and requester", async (origin) => {
      const blocker = await installAndEnable("block-tasks-from-source", { source: origin });
      const recorder = await installAndEnable("record-blocks");
      let requester: TaskBlockedEvent["requester"] = {};
      let scheduleId: string | undefined;

      if (origin === "rest") {
        const user = await createUser({ name: "Blocked REST requester" });
        requester = { userId: user.id };
        expect(
          (await postTask({ task: "blocked REST task", requestedByUserId: user.id })).status,
        ).toBe(422);
      } else if (origin === "mcp") {
        const caller = await createAgent({ name: "blocked-mcp-caller", status: "idle" });
        requester = { agentId: caller.id };
        const server = new McpServer({ name: "blocked-event-send", version: "1.0.0" });
        registerSendTaskTool(server);
        const result = await registeredSendTask(server).handler(sendTaskArgs("blocked MCP task"), {
          sessionId: "blocked-event",
          requestInfo: { headers: { "x-agent-id": caller.id } },
        });
        expect(result.isError).toBe(true);
      } else if (origin === "slack") {
        requester = { slackUserId: "U_BLOCKED_EVENT" };
        await createAgent({ name: "blocked-slack-lead", isLead: true, status: "idle" });
        bufferThreadMessage(
          "C_BLOCKED_EVENT",
          "1000.0001",
          "blocked Slack task",
          "U_BLOCKED_EVENT",
          "1000.0002",
        );
        await instantFlush("C_BLOCKED_EVENT:1000.0001");
      } else {
        const schedule = await createScheduledTask({
          name: "blocked-event-schedule",
          taskTemplate: "blocked schedule task",
          intervalMs: 60_000,
        });
        scheduleId = schedule.id;
        await expect(dispatchScheduleTarget(schedule)).rejects.toThrow(
          "Task source schedule is blocked",
        );
      }

      const event = await recordedBlock(recorder);
      expect(events).toHaveLength(1);
      expect(event).toMatchObject({
        extension: { id: blocker.id, name: "block-tasks-from-source" },
        origin,
        source: origin === "rest" ? "api" : origin,
        requester,
      });
      expect(event.requester).toEqual(requester);
      if (scheduleId) expect(event.context?.scheduleId).toBe(scheduleId);
      expect(event).not.toHaveProperty("task");
      expect(event).not.toHaveProperty("taskId");
    });

    test("scrubs and bounds the payload, preserving correlation on each retry", async () => {
      const secret = `ghp_${"Z".repeat(36)}`;
      await installSource(
        "secret-blocker",
        `
import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => block(${JSON.stringify(`Ticket required: ${secret}`)}));
};
export default extension;
`,
      );
      const recorder = await installAndEnable("record-blocks");
      const context = {
        contextKey: "github:acme/project:7",
        scheduleId: crypto.randomUUID(),
        workflowRunId: crypto.randomUUID(),
        workflowRunStepId: crypto.randomUUID(),
        parentTaskId: crypto.randomUUID(),
        vcsRepo: "acme/project",
        vcsNumber: 7,
        slackChannelId: "C_CORRELATED_BLOCK",
        slackThreadTs: "2000.0001",
      };
      const requester = {
        userId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        slackUserId: "U_CORRELATED_BLOCK",
      };
      for (const attempt of [1, 2]) {
        await expect(
          createTaskWithSiblingAwareness(
            `${"x".repeat(480)} ${secret}`,
            {
              ...context,
              source: "github",
              requestedByUserId: requester.userId,
              creatorAgentId: requester.agentId,
              slackUserId: requester.slackUserId,
            },
            { origin: "webhook" },
          ),
        ).rejects.toThrow("Ticket required:");
        const event = await recordedBlock(recorder, attempt);
        expect(events).toHaveLength(attempt);
        expect(event.reason).toContain("[REDACTED:");
        expect(event.reason).not.toContain(secret);
        expect(event.description).toHaveLength(500);
        expect(event.description).not.toContain("ghp_");
        expect(event.context).toEqual(context);
        expect(event.requester).toEqual(requester);
      }
    });

    test("a rejected model rewrite emits a block attributed to its editor", async () => {
      const codex = await createAgent({
        name: "blocked-rewrite-codex",
        harnessProvider: "codex",
        status: "idle",
      });
      const editor = await installSource(
        "incompatible-model",
        `
import { modify, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => modify({ model: "claude-opus-5-5" }));
};
export default extension;
`,
      );
      const recorder = await installAndEnable("record-blocks");
      const result = await postTask({
        task: "incompatible rewrite",
        agentId: codex.id,
        routingReason: "human_pinned",
      });
      expect(result.status).toBe(422);
      const event = await recordedBlock(recorder);
      expect(events).toHaveLength(1);
      expect(event.extension).toEqual({ id: editor.id, name: "incompatible-model" });
      expect(event.reason).toContain("rewrite");
      expect(event.reason).toContain("codex");
    });

    test("the creator is skipped while the blocking extension receives its own block", async () => {
      const creator = await installAndEnable("record-blocks");
      const blocker = await installSource(
        "blocking-recorder",
        `
import { block, type SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => block("blocked by recorder"));
  api.on("post.task.blocked", async (_event, ctx) => { await ctx.state.incr("count"); });
};
export default extension;
`,
      );
      const observerBundle = await loadBundleFixture("record-blocks");
      const installedObserver = await installExtension({
        ...observerBundle,
        manifest: { ...observerBundle.manifest, name: "last-block-observer" },
        priority: 1_000,
      });
      const observer = await enableExtension(installedObserver.extension.id);
      const server = new McpServer({ name: "extension-blocked-event", version: "1.0.0" });
      registerSendTaskTool(server);
      const result = await registeredSendTask(server).handler(
        sendTaskArgs("extension task"),
        markExtensionRequestOrigin({
          sessionId: "blocked-extension",
          requestInfo: { headers: { "x-agent-id": creator.agentId! } },
        }),
      );
      expect(result.isError).toBe(true);
      // The final subscriber acknowledges only after every earlier recipient has finished.
      await waitForCounter(observer, "ext:last-block-observer:count");
      expect(
        (await getKv(`task:agent:${blocker.agentId}`, "ext:blocking-recorder:count"))?.value,
      ).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ origin: "extension:record-blocks" });
      expect(await getKv(`task:agent:${creator.agentId}`, "ext:record-blocks:count")).toBeNull();
      expect(await listExtensionRuns(creator.id)).toEqual([]);
      const runs = await listExtensionRuns(blocker.id);
      expect(runs).toContainEqual(
        expect.objectContaining({
          event: "post.task.blocked",
          agentId: creator.agentId,
          subject: "extension:record-blocks: blocking-recorder",
        }),
      );
    });

    test("continue and valid rewrites emit no blocked event", async () => {
      const recorder = await installAndEnable("record-blocks");
      expect((await postTask({ task: "continued task" })).status).toBe(201);
      await installAndEnable("rewrite-task-priority");
      const modified = await postTask({ task: "rewritten task" });
      expect(modified.status).toBe(201);
      expect(modified.body.priority).toBe(1);
      expect(events).toEqual([]);
      expect(await getKv(`task:agent:${recorder.agentId}`, "ext:record-blocks:count")).toBeNull();
    });

    test("a throwing bus observer does not replace the blocked response", async () => {
      await installAndEnable("block-tasks-from-source", { source: "rest" });
      let calls = 0;
      const observer = () => {
        calls++;
        throw new Error("broken block observer");
      };
      const error = spyOn(console, "error").mockImplementation(() => {});
      workflowEventBus.on("task.create_blocked", observer);
      try {
        expect((await postTask({ task: "still blocked" })).status).toBe(422);
        expect(calls).toBe(1);
      } finally {
        workflowEventBus.off("task.create_blocked", observer);
        error.mockRestore();
      }
    });
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

  test("GitHub sender allowlist separates internal and external senders", async () => {
    const template = getCatalogEntry("github-sender-allowlist");
    if (!template) throw new Error("github-sender-allowlist is missing from the catalog");
    const installed = await installExtension({
      manifest: template.manifest,
      files: template.files,
      config: {
        internal: ["tarasyarema", "harlequinetcie"],
        external: ["fuvidani", "capchase-bot"],
        reviewBots: ["review-bot"],
      },
    });
    await enableExtension(installed.extension.id);

    const createFromGitHub = (
      description: string,
      vcsAuthor: string,
      taskType: string,
      vcsUrl: string,
      source: "github" | "api" = "github",
    ) =>
      createTaskWithSiblingAwareness(
        description,
        { source, vcsAuthor, taskType, vcsUrl },
        { origin: "webhook" },
      );

    await createFromGitHub(
      "internal sender issue",
      "HARLEQUINETCIE",
      "github-issue",
      "https://github.com/acme/project/issues/1",
    );
    await createFromGitHub(
      "internal sender review",
      "tarasyarema",
      "github-review",
      "https://github.com/acme/project/pull/2",
    );
    await createFromGitHub(
      "external sender PR comment",
      "FuViDaNi",
      "github-comment",
      "https://github.com/acme/project/pull/2",
    );
    await createFromGitHub(
      "external sender PR assignment",
      "capchase-bot",
      "github-pr",
      "https://github.com/acme/project/pull/3",
    );
    await createFromGitHub(
      "external sender PR review",
      "fuvidani",
      "github-review",
      "https://github.com/acme/project/pull/4",
    );

    await expect(
      createFromGitHub(
        "external sender issue comment",
        "fuvidani",
        "github-comment",
        "https://github.com/acme/project/issues/5",
      ),
    ).rejects.toThrow('GitHub sender "fuvidani" is blocked: external senders are allowed only');
    await expect(
      createFromGitHub(
        "unknown sender issue",
        "unknown-user",
        "github-issue",
        "https://github.com/acme/project/issues/6",
      ),
    ).rejects.toThrow('GitHub sender "unknown-user" is blocked: sender is not on the internal');

    await expect(
      createFromGitHub(
        "unknown sender review",
        "unknown-user",
        "github-review",
        "https://github.com/acme/project/pull/7",
      ),
    ).rejects.toThrow('GitHub sender "unknown-user" is blocked: sender is not on the internal');
    await createFromGitHub(
      "review bot review",
      "REVIEW-BOT",
      "github-review",
      "https://github.com/acme/project/pull/8",
    );
    await expect(
      createFromGitHub(
        "review bot PR comment",
        "review-bot",
        "github-comment",
        "https://github.com/acme/project/pull/9",
      ),
    ).rejects.toThrow('GitHub sender "review-bot" is blocked: review bots are allowed only');
    await createFromGitHub(
      "non-GitHub source",
      "unknown-user",
      "github-issue",
      "https://github.com/acme/project/issues/10",
      "api",
    );
  });

  test("Slack event metadata retains mixed-sender batches and rejects metadata rewrites", async () => {
    await createAgent({ name: "slack-metadata-lead", isLead: true, status: "idle" });
    await installSource(
      "a-rewrite-slack-metadata",
      `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: {
    priority: 7, slack: { trigger: "mention", messages: [] }
  } as never }));
};
export default extension;
`,
    );
    const recorder = await installAndEnable("record-task-create");
    const channelId = "C_EVENT_METADATA";
    const threadTs = "3000.0001";
    bufferThreadMessage(channelId, threadTs, "first request", "U_FIRST", "3000.0002");
    bufferThreadMessage(channelId, threadTs, "second request", "U_SECOND", "3000.0003");

    await instantFlush(`${channelId}:${threadTs}`);

    const event = (await getKv(`task:agent:${recorder.agentId}`, "ext:record-task-create:last"))
      ?.value as TaskCreateEvent & { slack?: unknown };
    expect(event.slack).toEqual({
      trigger: "thread-buffer",
      messages: [
        { ts: "3000.0002", userId: "U_FIRST", text: "first request" },
        { ts: "3000.0003", userId: "U_SECOND", text: "second request" },
      ],
    });
    expect(event.origin).toBe("slack");
    expect(event.options).toMatchObject({
      slackTriggerMessageTs: "3000.0003",
      slackUserId: "U_FIRST",
      priority: 7,
    });
    expect(event.options).not.toHaveProperty("slack");
    const task = await getMostRecentTaskInThread(channelId, threadTs);
    expect(task).toMatchObject({
      priority: 7,
      slackTriggerMessageTs: "3000.0003",
      slackUserId: "U_FIRST",
    });
    expect(task).not.toHaveProperty("slack");

    await createTaskWithSiblingAwareness("ordinary API task", { source: "api" });
    const apiEvent = (await getKv(`task:agent:${recorder.agentId}`, "ext:record-task-create:last"))
      ?.value as TaskCreateEvent & { slack?: unknown };
    expect(apiEvent).not.toHaveProperty("slack");
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

  test("a hook that rewrites the model or assignee into a harness mismatch is blocked", async () => {
    const claude = await createAgent({
      name: "pre-task-claude",
      isLead: false,
      status: "idle",
      harnessProvider: "claude",
    });
    const codex = await createAgent({
      name: "pre-task-codex",
      isLead: false,
      status: "idle",
      harnessProvider: "codex",
    });
    const hook = (data: Record<string, unknown>) =>
      `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: ${JSON.stringify(data)} }));
};
export default extension;
`;

    const reroute = await installSource("reroute-to-codex", hook({ agentId: codex.id }));
    const rerouted = await postTask({
      task: "opus task rerouted to codex",
      agentId: claude.id,
      routingReason: "human_pinned",
      model: "claude-opus-5-5",
    });
    expect(rerouted.status).toBe(422);
    expect(String(rerouted.body.error)).toContain("claude-opus-5-5");
    expect(String(rerouted.body.error)).toContain("codex");
    expect(rerouted.body.extension).toEqual({ id: reroute.id, name: "reroute-to-codex" });

    const caller = await createAgent({
      name: "pre-task-model-caller",
      isLead: false,
      status: "idle",
    });
    const server = new McpServer({ name: "pre-task-model-guard", version: "1.0.0" });
    registerSendTaskTool(server);
    const sent = await registeredSendTask(server).handler(
      {
        ...sendTaskArgs("opus tool task rerouted to codex"),
        agentId: claude.id,
        routingReason: "human_pinned",
        routingNote: "test pins the claude agent",
        model: "claude-opus-5-5",
      },
      { sessionId: "pre-task-model-guard", requestInfo: { headers: { "x-agent-id": caller.id } } },
    );
    expect(sent.isError).toBe(true);
    expect(JSON.stringify(sent)).toContain("reroute-to-codex");

    await stopExtensionRuntime();
    await getDbClient().run("DELETE FROM extensions");
    await installSource("pin-opus", hook({ model: "claude-opus-5-5" }));
    const repinned = await postTask({
      task: "codex task pinned to opus",
      agentId: codex.id,
      routingReason: "human_pinned",
    });
    expect(repinned.status).toBe(422);
    expect(String(repinned.body.error)).toContain("claude-opus-5-5");

    const compatible = await postTask({
      task: "claude task pinned to opus",
      agentId: claude.id,
      routingReason: "human_pinned",
    });
    expect(compatible.status).toBe(201);
    expect(compatible.body.model).toBe("claude-opus-5-5");
  });

  test("user send-task rejects an extension that retargets the Lead assignment", async () => {
    await createAgent({ name: "user-task-lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "user-task-worker", isLead: false, status: "idle" });
    const user = await createUser({ name: "Extension Guard User" });
    await installSource(
      "retarget-user-task",
      `import type { SwarmExtension } from "swarm-extension";
const extension: SwarmExtension = (api) => {
  api.on("pre.task.create", () => ({ action: "modify", data: { agentId: "${worker.id}" } }));
};
export default extension;
`,
    );

    const result = await sendTaskHandler(
      userCtx(user),
      sendTaskArgs("extension must not retarget this user task"),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "A pre.task.create extension cannot change the user task's Lead assignment.",
    );
    expect(
      (await getDbClient().get<{ count: number }>("SELECT COUNT(*) AS count FROM agent_tasks"))
        ?.count,
    ).toBe(0);
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
