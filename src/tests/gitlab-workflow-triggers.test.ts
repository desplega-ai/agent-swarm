import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createWorkflow, getAllTasks, initDb } from "../be/db";
import { workflowEventBus } from "../workflows/event-bus";
import { evaluateWorkflowTriggers } from "../workflows/triggers";

const TEST_DB_PATH = "./test-gitlab-triggers.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  createAgent({
    id: "trigger-lead-001",
    name: "TriggerTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════
// trigger-gitlab-event matching
// ═══════════════════════════════════════════════════════

describe("trigger-gitlab-event workflow triggers", () => {
  test("fires on matching gitlab.merge_request.open event", async () => {
    const taskTemplate = `gl-trigger-mr-open-${Date.now()}`;
    createWorkflow({
      name: `wf-gl-mr-open-${Date.now()}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-gitlab-event",
            config: { matchEventType: "merge_request.open" },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    const idsBefore = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("gitlab.merge_request.open", {
      repo: "group/project",
      action: "open",
    });
    await new Promise((r) => setTimeout(r, 150));

    const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    const matched = newTasks.find((t) => t.task === taskTemplate && t.source === "workflow");
    expect(matched).toBeDefined();
  });

  test("does NOT fire on github event for gitlab trigger", async () => {
    const taskTemplate = `gl-trigger-no-gh-${Date.now()}`;
    createWorkflow({
      name: `wf-gl-no-gh-${Date.now()}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-gitlab-event",
            config: { matchEventType: "merge_request.open" },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    const idsBefore = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("github.pull_request.opened", {
      repo: "org/repo",
      action: "opened",
    });
    await new Promise((r) => setTimeout(r, 150));

    const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    const matched = newTasks.find((t) => t.task === taskTemplate);
    expect(matched).toBeUndefined();
  });

  test("filters by repo when matchRepo is set", async () => {
    const taskTemplate = `gl-trigger-repo-filter-${Date.now()}`;
    createWorkflow({
      name: `wf-gl-repo-${Date.now()}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-gitlab-event",
            config: { matchEventType: "issue.open", matchRepo: "group/specific-project" },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    const idsBefore = new Set(getAllTasks().map((t) => t.id));

    // Wrong repo — should NOT fire
    evaluateWorkflowTriggers("gitlab.issue.open", {
      repo: "group/other-project",
      action: "open",
    });
    await new Promise((r) => setTimeout(r, 150));

    let newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    expect(newTasks.find((t) => t.task === taskTemplate)).toBeUndefined();

    // Correct repo — should fire
    const idsBefore2 = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("gitlab.issue.open", {
      repo: "group/specific-project",
      action: "open",
    });
    await new Promise((r) => setTimeout(r, 150));

    newTasks = getAllTasks().filter((t) => !idsBefore2.has(t.id));
    expect(newTasks.find((t) => t.task === taskTemplate)).toBeDefined();
  });

  test("filters by actions array", async () => {
    const taskTemplate = `gl-trigger-actions-${Date.now()}`;
    createWorkflow({
      name: `wf-gl-actions-${Date.now()}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-gitlab-event",
            config: {
              matchEventType: "merge_request.open",
              actions: ["open", "merge"],
            },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    // "open" is in the list — should fire
    const idsBefore = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("gitlab.merge_request.open", {
      repo: "group/project",
      action: "open",
    });
    await new Promise((r) => setTimeout(r, 150));

    let newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    expect(newTasks.find((t) => t.task === taskTemplate)).toBeDefined();

    // "close" is NOT in the list — should NOT fire
    const taskTemplate2 = `gl-trigger-actions-no-${Date.now()}`;
    createWorkflow({
      name: `wf-gl-actions-no-${Date.now()}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-gitlab-event",
            config: {
              matchEventType: "merge_request.close",
              actions: ["open", "merge"],
            },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate2 } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    const idsBefore2 = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("gitlab.merge_request.close", {
      repo: "group/project",
      action: "close",
    });
    await new Promise((r) => setTimeout(r, 150));

    newTasks = getAllTasks().filter((t) => !idsBefore2.has(t.id));
    expect(newTasks.find((t) => t.task === taskTemplate2)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// GitLab webhook event bus emissions
// ═══════════════════════════════════════════════════════

describe("GitLab workflow event bus emissions", () => {
  test("gitlab.merge_request.open event carries expected data", () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => captured.push(data as Record<string, unknown>);

    workflowEventBus.on("gitlab.merge_request.open", handler);
    try {
      workflowEventBus.emit("gitlab.merge_request.open", {
        repo: "group/project",
        number: 5,
        title: "Test MR",
        body: "MR description",
        action: "open",
        merged: false,
        html_url: "https://gitlab.com/group/project/-/merge_requests/5",
        user_login: "alice",
      });

      expect(captured.length).toBe(1);
      expect(captured[0].repo).toBe("group/project");
      expect(captured[0].number).toBe(5);
      expect(captured[0].merged).toBe(false);
      expect(captured[0].user_login).toBe("alice");
    } finally {
      workflowEventBus.off("gitlab.merge_request.open", handler);
    }
  });

  test("gitlab.issue.open event carries expected data", () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => captured.push(data as Record<string, unknown>);

    workflowEventBus.on("gitlab.issue.open", handler);
    try {
      workflowEventBus.emit("gitlab.issue.open", {
        repo: "group/project",
        number: 15,
        title: "Test Issue",
        action: "open",
      });

      expect(captured.length).toBe(1);
      expect(captured[0].repo).toBe("group/project");
      expect(captured[0].number).toBe(15);
    } finally {
      workflowEventBus.off("gitlab.issue.open", handler);
    }
  });

  test("gitlab.pipeline.failed event carries expected data", () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => captured.push(data as Record<string, unknown>);

    workflowEventBus.on("gitlab.pipeline.failed", handler);
    try {
      workflowEventBus.emit("gitlab.pipeline.failed", {
        repo: "group/project",
        number: 5,
        status: "failed",
        action: "failed",
      });

      expect(captured.length).toBe(1);
      expect(captured[0].status).toBe("failed");
    } finally {
      workflowEventBus.off("gitlab.pipeline.failed", handler);
    }
  });
});
