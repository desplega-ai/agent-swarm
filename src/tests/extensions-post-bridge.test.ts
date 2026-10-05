import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createApprovalRequest,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getDbClient,
  initDb,
  updateWorkflowRun,
  updateWorkflowRunStep,
} from "../be/db";
import { installExtension, setExtensionState } from "../be/extensions/db";
import type { SwarmEventMap } from "../extensions/contract";
import { listRegistered, registerLoaded, unregister } from "../extensions/dispatcher";
import { ensureExtensionAgent } from "../extensions/identity";
import { cleanExtensionTmpRoot, loadExtension } from "../extensions/loader";
import { initExtensionPostBridge, teardownExtensionPostBridge } from "../extensions/post-bridge";
import { handleApprovalRequests } from "../http/approval-requests";
import { InProcessBus } from "../realtime/bus";
import { InProcessEventBus, workflowEventBus } from "../workflows/event-bus";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { setupWorkflowResumeListener } from "../workflows/resume";
import { loadBundleFixture } from "./fixtures/extensions/load";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-extensions-post-bridge.sqlite";

const NEW_EVENTS = [
  "post.approval.resolved",
  "post.task.budgetRefused",
  "post.email.received",
  "post.kapso.message",
  "post.vcs.event",
] as const satisfies readonly (keyof SwarmEventMap)[];

type Received = { extension: string; event: string; payload: unknown };
const received: Received[] = [];

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await Bun.file(TEST_DB_PATH + suffix)
      .delete()
      .catch(() => {});
  }
}

/** Register an in-process extension whose handlers record every new event they receive. */
async function registerCapture(name: string) {
  const bundle = await loadBundleFixture("minimal");
  bundle.manifest = { ...bundle.manifest, name };
  const installed = await installExtension({ ...bundle, priority: 100 });
  const record = await setExtensionState(installed.extension.id, {
    agentId: await ensureExtensionAgent(installed.extension.name),
  });
  const loaded = await loadExtension({ record: record!, ...bundle });
  loaded.handlers = NEW_EVENTS.map((event) => ({
    event,
    priority: 100,
    handler: (payload: never) => {
      received.push({ extension: name, event, payload });
    },
  }));
  registerLoaded(loaded);
  return loaded;
}

async function waitForEvents(count: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out: expected ${count} events, got ${received.length}`);
    }
    await Bun.sleep(10);
  }
}

/** Let any wrongly dispatched event arrive before asserting that none did. */
async function settle(): Promise<void> {
  await Bun.sleep(50);
}

describe("extension post bridge: new events", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    initExtensionPostBridge();
  });

  afterAll(async () => {
    teardownExtensionPostBridge();
    for (const loaded of listRegistered()) {
      unregister(loaded.record.id);
      await loaded.dispose();
    }
    await cleanExtensionTmpRoot();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    for (const loaded of listRegistered()) {
      unregister(loaded.record.id);
      await loaded.dispose();
    }
    await cleanExtensionTmpRoot();
    await getDbClient().run("DELETE FROM extensions");
    received.length = 0;
  });

  describe("post.approval.resolved", () => {
    test("a bus emit with a workflow run dispatches the typed payload", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("approval.resolved", {
        requestId: "req-1",
        status: "rejected",
        responses: { q1: { approved: false } },
        workflowRunId: "run-1",
        workflowRunStepId: "step-1",
      });
      await waitForEvents(1);
      expect(received).toEqual([
        {
          extension: "capture",
          event: "post.approval.resolved",
          payload: {
            requestId: "req-1",
            status: "rejected",
            responses: { q1: { approved: false } },
            workflowRunId: "run-1",
            workflowRunStepId: "step-1",
          },
        },
      ]);
    });

    test("a payload with an unknown status is dropped", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("approval.resolved", { requestId: "req-1", status: "pending" });
      workflowEventBus.emit("approval.resolved", { status: "approved" });
      await settle();
      expect(received).toEqual([]);
    });

    describe("through the respond route", () => {
      let server: Server;
      let baseUrl = "";

      beforeAll(async () => {
        server = createHttpServer(async (req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          const handled = await handleApprovalRequests(
            req,
            res,
            url.pathname.split("/").filter(Boolean),
            url.searchParams,
          );
          if (!handled) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          }
        });
        baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
      });

      afterAll(async () => {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      });

      function respond(id: string): Promise<Response> {
        return fetch(`${baseUrl}/api/approval-requests/${id}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responses: { q1: { approved: true } } }),
        });
      }

      const approval = (overrides: Record<string, unknown> = {}) => ({
        id: crypto.randomUUID(),
        title: "Approve deployment",
        questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
        approvers: { policy: "any" as const },
        ...overrides,
      });

      test("a standalone approval dispatches without a run or step id, and workflow resume tolerates it", async () => {
        await registerCapture("capture");
        const task = await createTaskExtended("ask a person", { source: "api" });
        const created = await createApprovalRequest(approval({ sourceTaskId: task.id }));
        const busEvents: unknown[] = [];
        const record = (data: unknown) => busEvents.push(data);
        workflowEventBus.on("approval.resolved", record);
        // The real resume listener, attached to the same bus the route emits on.
        const teardownResume = setupWorkflowResumeListener(
          workflowEventBus,
          new ExecutorRegistry(),
        );
        const error = spyOn(console, "error").mockImplementation(() => {});
        try {
          expect((await respond(created.id)).status).toBe(200);
          await waitForEvents(1);
          await settle();

          expect(received).toEqual([
            {
              extension: "capture",
              event: "post.approval.resolved",
              payload: {
                requestId: created.id,
                status: "approved",
                responses: { q1: { approved: true } },
                sourceTaskId: task.id,
              },
            },
          ]);
          expect(busEvents).toHaveLength(1);
          expect(busEvents[0]).not.toHaveProperty("workflowRunId", expect.anything());
          expect(error).not.toHaveBeenCalled();
        } finally {
          error.mockRestore();
          teardownResume();
          workflowEventBus.off("approval.resolved", record);
        }
      });

      test("a workflow approval still carries its run and step id", async () => {
        await registerCapture("capture");
        const workflow = await createWorkflow({
          name: `post-bridge-approval-${crypto.randomUUID()}`,
          definition: { nodes: [] },
        });
        const runId = crypto.randomUUID();
        const stepId = crypto.randomUUID();
        await createWorkflowRun({ id: runId, workflowId: workflow.id });
        await createWorkflowRunStep({
          id: stepId,
          runId,
          nodeId: "approval",
          nodeType: "human-in-the-loop",
        });
        await updateWorkflowRun(runId, { status: "waiting" });
        await updateWorkflowRunStep(stepId, { status: "waiting" });
        const created = await createApprovalRequest(
          approval({ workflowRunId: runId, workflowRunStepId: stepId }),
        );

        expect((await respond(created.id)).status).toBe(200);
        await waitForEvents(1);

        expect(received[0]?.payload).toEqual({
          requestId: created.id,
          status: "approved",
          responses: { q1: { approved: true } },
          workflowRunId: runId,
          workflowRunStepId: stepId,
        });
      });
    });
  });

  describe("post.task.budgetRefused", () => {
    test("a bus emit dispatches the task and the spend fields", async () => {
      await registerCapture("capture");
      const task = await createTaskExtended("over budget", { source: "api" });
      workflowEventBus.emit("task.budget_refused", {
        taskId: task.id,
        agentId: "agent-1",
        cause: "user",
        userSpendUsd: 12.5,
        userBudgetUsd: 10,
        resetAt: "2026-10-06T00:00:00.000Z",
      });
      await waitForEvents(1);
      const [event] = received;
      expect(event?.event).toBe("post.task.budgetRefused");
      expect(event?.payload).toMatchObject({
        task: { id: task.id },
        agentId: "agent-1",
        cause: "user",
        userSpendUsd: 12.5,
        userBudgetUsd: 10,
        resetAt: "2026-10-06T00:00:00.000Z",
      });
      expect(event?.payload).not.toHaveProperty("agentSpendUsd");
    });

    test("the extension that created the refused task does not receive it", async () => {
      const creator = await registerCapture("creator");
      await registerCapture("observer");
      const task = await createTaskExtended("created by an extension", {
        source: "api",
        creatorAgentId: creator.record.agentId!,
      });
      workflowEventBus.emit("task.budget_refused", {
        taskId: task.id,
        agentId: "agent-1",
        cause: "global",
        globalSpendUsd: 100,
        globalBudgetUsd: 100,
        resetAt: "2026-10-06T00:00:00.000Z",
      });
      await waitForEvents(1);
      await settle();
      expect(received.map((entry) => entry.extension)).toEqual(["observer"]);
    });

    test("an unknown task or cause is dropped", async () => {
      await registerCapture("capture");
      const task = await createTaskExtended("over budget", { source: "api" });
      const resetAt = "2026-10-06T00:00:00.000Z";
      workflowEventBus.emit("task.budget_refused", {
        taskId: crypto.randomUUID(),
        agentId: "agent-1",
        cause: "agent",
        resetAt,
      });
      workflowEventBus.emit("task.budget_refused", {
        taskId: task.id,
        agentId: "agent-1",
        cause: "weekly",
        resetAt,
      });
      await settle();
      expect(received).toEqual([]);
    });
  });

  describe("post.email.received", () => {
    test("a bus emit dispatches the typed payload", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("agentmail.message.received", {
        inboxId: "inbox-1",
        from: "Ada <ada@example.com>",
        subject: "Invoice",
        body: "Please pay.",
        threadId: "thread-1",
        messageId: "message-1",
      });
      await waitForEvents(1);
      expect(received).toEqual([
        {
          extension: "capture",
          event: "post.email.received",
          payload: {
            inboxId: "inbox-1",
            from: "Ada <ada@example.com>",
            subject: "Invoice",
            body: "Please pay.",
            threadId: "thread-1",
            messageId: "message-1",
          },
        },
      ]);
    });
  });

  describe("post.kapso.message", () => {
    test("a bus emit dispatches the typed payload", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("kapso.message.received", {
        phoneNumberId: "pn-1",
        conversationId: "conv-1",
        messageId: "wamid-1",
        from: "34600000000",
        type: "text",
        text: "hola",
      });
      await waitForEvents(1);
      expect(received).toEqual([
        {
          extension: "capture",
          event: "post.kapso.message",
          payload: {
            phoneNumberId: "pn-1",
            conversationId: "conv-1",
            messageId: "wamid-1",
            from: "34600000000",
            type: "text",
            text: "hola",
          },
        },
      ]);
    });

    test("optional fields stay absent when the webhook omits them", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("kapso.message.received", {
        phoneNumberId: "",
        messageId: "wamid-2",
        text: "(non-text message — type: image)",
      });
      await waitForEvents(1);
      expect(received[0]?.payload).toEqual({
        phoneNumberId: "",
        messageId: "wamid-2",
        text: "(non-text message — type: image)",
      });
    });
  });

  describe("post.vcs.event", () => {
    // Payloads copied from the emit sites in src/http/webhooks.ts.
    const cases: {
      name: string;
      data: Record<string, unknown>;
      expected: Record<string, unknown>;
    }[] = [
      {
        name: "github.pull_request.opened",
        data: {
          repo: "acme/api",
          number: 7,
          title: "Add retries",
          body: "Retries the call.",
          action: "opened",
          merged: false,
          html_url: "https://github.com/acme/api/pull/7",
          user_login: "ada",
          changed_files: 3,
        },
        expected: {
          provider: "github",
          kind: "pull_request",
          action: "opened",
          repo: "acme/api",
          number: 7,
          title: "Add retries",
          body: "Retries the call.",
          author: "ada",
          url: "https://github.com/acme/api/pull/7",
          merged: false,
          changedFiles: 3,
        },
      },
      {
        // An action no list would have named: the prefix subscription covers it.
        name: "github.pull_request.auto_merge_enabled",
        data: { repo: "acme/api", number: 7, body: null, action: "auto_merge_enabled" },
        expected: {
          provider: "github",
          kind: "pull_request",
          action: "auto_merge_enabled",
          repo: "acme/api",
          number: 7,
          body: null,
        },
      },
      {
        name: "github.issue.labeled",
        data: { repo: "acme/api", number: 9, title: "Crash", action: "labeled" },
        expected: {
          provider: "github",
          kind: "issue",
          action: "labeled",
          repo: "acme/api",
          number: 9,
          title: "Crash",
        },
      },
      {
        name: "github.issue_comment.created",
        data: { repo: "acme/api", number: 9, action: "created" },
        expected: {
          provider: "github",
          kind: "issue_comment",
          action: "created",
          repo: "acme/api",
          number: 9,
        },
      },
      {
        name: "github.pull_request_review.submitted",
        data: { repo: "acme/api", number: 7, state: "approved", action: "submitted" },
        expected: {
          provider: "github",
          kind: "pull_request_review",
          action: "submitted",
          repo: "acme/api",
          number: 7,
          reviewState: "approved",
        },
      },
      {
        name: "gitlab.merge_request.merge",
        data: {
          repo: "acme/api",
          number: 4,
          title: "Add retries",
          body: "Retries the call.",
          action: "merge",
          merged: true,
          html_url: "https://gitlab.com/acme/api/-/merge_requests/4",
          user_login: "ada",
        },
        expected: {
          provider: "gitlab",
          kind: "merge_request",
          action: "merge",
          repo: "acme/api",
          number: 4,
          title: "Add retries",
          body: "Retries the call.",
          author: "ada",
          url: "https://gitlab.com/acme/api/-/merge_requests/4",
          merged: true,
        },
      },
      {
        name: "gitlab.issue.open",
        data: { repo: "acme/api", number: 2, title: "Crash", action: "open" },
        expected: {
          provider: "gitlab",
          kind: "issue",
          action: "open",
          repo: "acme/api",
          number: 2,
          title: "Crash",
        },
      },
      {
        name: "gitlab.note.created",
        data: { repo: "acme/api", number: 4, action: "created" },
        expected: {
          provider: "gitlab",
          kind: "note",
          action: "created",
          repo: "acme/api",
          number: 4,
        },
      },
      {
        // A pipeline outside a merge request has no number.
        name: "gitlab.pipeline.failed",
        data: { repo: "acme/api", status: "failed", action: "failed" },
        expected: { provider: "gitlab", kind: "pipeline", action: "failed", repo: "acme/api" },
      },
      {
        name: "azure-devops.pull_request.created",
        data: {
          repo: "https://dev.azure.com/acme/web/_git/api",
          number: 12,
          title: "Add retries",
          body: "Retries the call.",
          action: "created",
          user_login: "ada@acme.com",
        },
        expected: {
          provider: "azure-devops",
          kind: "pull_request",
          action: "created",
          repo: "https://dev.azure.com/acme/web/_git/api",
          number: 12,
          title: "Add retries",
          body: "Retries the call.",
          author: "ada@acme.com",
        },
      },
      {
        name: "azure-devops.pull_request.commented",
        data: {
          repo: "https://dev.azure.com/acme/web/_git/api",
          number: 12,
          action: "commented",
          user_login: "grace@acme.com",
        },
        expected: {
          provider: "azure-devops",
          kind: "pull_request",
          action: "commented",
          repo: "https://dev.azure.com/acme/web/_git/api",
          number: 12,
          author: "grace@acme.com",
        },
      },
    ];

    for (const { name, data, expected } of cases) {
      test(`${name} dispatches one typed VcsEvent`, async () => {
        await registerCapture("capture");
        workflowEventBus.emit(name, data);
        await waitForEvents(1);
        await settle();
        expect(received).toEqual([
          { extension: "capture", event: "post.vcs.event", payload: expected },
        ]);
      });
    }

    test("names outside the provider and kind lists are ignored", async () => {
      await registerCapture("capture");
      workflowEventBus.emit("github.check_run.completed", { repo: "acme/api" });
      workflowEventBus.emit("github.pull_request", { repo: "acme/api" });
      workflowEventBus.emit("githubx.pull_request.opened", { repo: "acme/api" });
      workflowEventBus.emit("github.pull_request.opened", { number: 7 });
      workflowEventBus.emit("task.created", { repo: "acme/api" });
      // A valid event after them proves they were skipped, not still in flight.
      workflowEventBus.emit("gitlab.note.created", { repo: "acme/api", number: 4 });
      await waitForEvents(1);
      await settle();
      expect(received.map((entry) => entry.payload)).toEqual([
        { provider: "gitlab", kind: "note", action: "created", repo: "acme/api", number: 4 },
      ]);
    });

    test("teardown detaches every new subscription", async () => {
      await registerCapture("capture");
      teardownExtensionPostBridge();
      try {
        workflowEventBus.emit("github.issue.opened", { repo: "acme/api", number: 1 });
        workflowEventBus.emit("kapso.message.received", {
          phoneNumberId: "pn-1",
          messageId: "wamid-1",
          text: "hola",
        });
        await settle();
        expect(received).toEqual([]);
      } finally {
        initExtensionPostBridge();
      }
    });
  });
});

describe("workflow event bus prefix subscription", () => {
  test("delivers the full name and payload for every event under the prefix", () => {
    const bus = new InProcessEventBus(new InProcessBus());
    const seen: [string, unknown][] = [];
    bus.onPrefix("github.", (event, data) => seen.push([event, data]));
    bus.emit("github.pull_request.opened", { n: 1 });
    bus.emit("github.issue.closed", { n: 2 });
    bus.emit("gitlab.issue.closed", { n: 3 });
    bus.emit("githubx.issue.closed", { n: 4 });
    bus.emit("task.created", { n: 5 });
    expect(seen).toEqual([
      ["github.pull_request.opened", { n: 1 }],
      ["github.issue.closed", { n: 2 }],
    ]);
  });

  test("an exact subscription still fires alongside a prefix one", () => {
    const bus = new InProcessEventBus(new InProcessBus());
    const exact: unknown[] = [];
    const prefixed: string[] = [];
    bus.on("github.issue.closed", (data) => exact.push(data));
    bus.onPrefix("github.", (event) => prefixed.push(event));
    bus.emit("github.issue.closed", { n: 1 });
    expect(exact).toEqual([{ n: 1 }]);
    expect(prefixed).toEqual(["github.issue.closed"]);
  });

  test("offPrefix removes only the handler it is given", () => {
    const bus = new InProcessEventBus(new InProcessBus());
    const first: string[] = [];
    const second: string[] = [];
    const onFirst = (event: string) => first.push(event);
    const onSecond = (event: string) => second.push(event);
    bus.onPrefix("github.", onFirst);
    bus.onPrefix("github.", onSecond);
    bus.offPrefix("github.", onFirst);
    bus.offPrefix("github.", onFirst);
    bus.emit("github.issue.closed", {});
    expect(first).toEqual([]);
    expect(second).toEqual(["github.issue.closed"]);
  });
});
