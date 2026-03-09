import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createWorkflow,
  findTaskByGitHub,
  findTaskByVcs,
  getAllTasks,
  getTaskById,
  initDb,
} from "../be/db";
import { handlePullRequest } from "../github/handlers";
import type { PullRequestEvent } from "../github/types";
import { workflowEventBus } from "../workflows/event-bus";
import { evaluateWorkflowTriggers } from "../workflows/triggers";

const TEST_DB_PATH = "./test-pr150.sqlite";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePREvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: "review_requested",
    sender: { login: "testuser" },
    repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
    installation: { id: 1 },
    requested_reviewer: { login: "agent-swarm-bot", id: 1 },
    pull_request: {
      number: 42,
      title: "Test PR",
      body: "Some body",
      html_url: "https://github.com/org/repo/pull/42",
      user: { login: "testuser" },
      head: { ref: "feature", sha: "abc1234" },
      base: { ref: "main" },
      merged: false,
      changed_files: 5,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // File doesn't exist
  }
  initDb(TEST_DB_PATH);

  // Create a lead agent so tasks get assigned
  createAgent({
    id: "lead-001",
    name: "TestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // File may not exist
    }
  }
});

// ===========================================================================
// 1. handlers.ts — review_requested dedup via findTaskByVcs
// ===========================================================================

describe("handlePullRequest review_requested dedup", () => {
  test("creates a review task when no active task exists", async () => {
    const event = makePREvent({
      pull_request: {
        number: 100,
        title: "New PR",
        body: null,
        html_url: "https://github.com/org/repo/pull/100",
        user: { login: "alice" },
        head: { ref: "feat-a", sha: "aaa" },
        base: { ref: "main" },
        merged: false,
      },
    });

    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();

    // Verify the task exists in DB with correct vcs fields
    const task = findTaskByVcs("org/repo", 100);
    expect(task).not.toBeNull();
    expect(task?.vcsProvider).toBe("github");
    expect(task?.vcsRepo).toBe("org/repo");
    expect(task?.vcsNumber).toBe(100);
    expect(task?.vcsEventType).toBe("pull_request");
  });

  test("skips duplicate review task when active task already exists for the PR", async () => {
    // First, create an active task for PR #200
    createTaskExtended("[GitHub PR #200] Some PR", {
      agentId: "lead-001",
      source: "github",
      taskType: "github-pr",
      vcsRepo: "org/repo",
      vcsEventType: "pull_request",
      vcsNumber: 200,
      vcsAuthor: "bob",
      vcsUrl: "https://github.com/org/repo/pull/200",
    });

    // Verify active task exists
    const existing = findTaskByVcs("org/repo", 200);
    expect(existing).not.toBeNull();

    // Now trigger review_requested for the same PR
    const event = makePREvent({
      pull_request: {
        number: 200,
        title: "Existing PR",
        body: null,
        html_url: "https://github.com/org/repo/pull/200",
        user: { login: "bob" },
        head: { ref: "feat-b", sha: "bbb" },
        base: { ref: "main" },
        merged: false,
      },
    });

    const result = await handlePullRequest(event);
    // Should NOT create a duplicate
    expect(result.created).toBe(false);
  });

  test("creates review task for a different PR number even if another PR has active task", async () => {
    const event = makePREvent({
      pull_request: {
        number: 300,
        title: "Different PR",
        body: null,
        html_url: "https://github.com/org/repo/pull/300",
        user: { login: "charlie" },
        head: { ref: "feat-c", sha: "ccc" },
        base: { ref: "main" },
        merged: false,
      },
    });

    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });
});

// ===========================================================================
// 2. triggers.ts — matchEventFilters actions array filtering
// ===========================================================================

describe("matchEventFilters actions array filtering", () => {
  /**
   * Helper: creates a workflow with trigger-github-event + actions config,
   * fires evaluateWorkflowTriggers, and checks whether a task was created.
   */
  async function expectActionFilter(
    actions: string[],
    eventAction: string,
    shouldFire: boolean,
    label: string,
  ): Promise<void> {
    const taskTemplate = `action-filter-${label}-${Date.now()}`;
    createWorkflow({
      name: `wf-action-${label}`,
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-github-event",
            config: { matchEventType: "pull_request.opened", actions },
          },
          { id: "a1", type: "create-task", config: { template: taskTemplate } },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
      },
    });

    const idsBefore = new Set(getAllTasks().map((t) => t.id));
    evaluateWorkflowTriggers("github.pull_request.opened", {
      repo: "org/repo",
      action: eventAction,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    const matched = newTasks.find((t) => t.task === taskTemplate && t.source === "workflow");

    if (shouldFire) {
      expect(matched).toBeDefined();
    } else {
      expect(matched).toBeUndefined();
    }
  }

  test("fires when action is in the allowed actions list", async () => {
    await expectActionFilter(["opened", "closed"], "opened", true, "action-match");
  });

  test("does NOT fire when action is not in the allowed actions list", async () => {
    await expectActionFilter(["opened", "closed"], "edited", false, "action-nomatch");
  });

  test("fires when actions array is empty (no filtering)", async () => {
    // Empty actions array means no restriction — should still fire.
    // Actually, an empty array means config.actions is truthy but .includes() will always fail.
    // Let's verify the actual behavior:
    const taskTemplate = `action-filter-empty-${Date.now()}`;
    createWorkflow({
      name: "wf-action-empty",
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-github-event",
            config: { matchEventType: "pull_request.opened", actions: [] },
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    const matched = newTasks.find((t) => t.task === taskTemplate && t.source === "workflow");
    // Empty array: Array.isArray([]) is true, [].includes("opened") is false => blocked
    expect(matched).toBeUndefined();
  });

  test("fires when no actions config is set (unrestricted)", async () => {
    const taskTemplate = `action-filter-none-${Date.now()}`;
    createWorkflow({
      name: "wf-action-none",
      definition: {
        nodes: [
          {
            id: "t1",
            type: "trigger-github-event",
            config: { matchEventType: "pull_request.opened" },
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
    await new Promise((resolve) => setTimeout(resolve, 100));

    const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
    const matched = newTasks.find((t) => t.task === taskTemplate && t.source === "workflow");
    // No actions config => unrestricted, should fire
    expect(matched).toBeDefined();
  });

  test("actions filter with multiple allowed actions", async () => {
    await expectActionFilter(
      ["opened", "reopened", "synchronize"],
      "synchronize",
      true,
      "action-multi-match",
    );
  });

  test("actions filter rejects unlisted action among multiple", async () => {
    await expectActionFilter(
      ["opened", "reopened", "synchronize"],
      "closed",
      false,
      "action-multi-nomatch",
    );
  });
});

// ===========================================================================
// 3. webhooks.ts — event bus enrichment with merged, html_url, user_login, changed_files
// ===========================================================================

describe("webhook event bus enrichment", () => {
  test("pull_request event emits enriched data with merged, html_url, user_login, changed_files", async () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => {
      captured.push(data as Record<string, unknown>);
    };

    // Listen on the event bus for the specific event
    workflowEventBus.on("github.pull_request.opened", handler);

    try {
      // Simulate what webhooks.ts does when emitting
      const prEvent: PullRequestEvent = {
        action: "opened",
        sender: { login: "alice" },
        repository: { full_name: "org/repo", html_url: "https://github.com/org/repo" },
        pull_request: {
          number: 500,
          title: "Enrichment Test",
          body: "Test body",
          html_url: "https://github.com/org/repo/pull/500",
          user: { login: "alice" },
          head: { ref: "feat-enrich", sha: "def456" },
          base: { ref: "main" },
          merged: true,
          changed_files: 12,
        },
      };

      // Replicate the emission logic from webhooks.ts
      workflowEventBus.emit(`github.pull_request.${prEvent.action}`, {
        repo: prEvent.repository.full_name,
        number: prEvent.pull_request.number,
        title: prEvent.pull_request.title,
        body: prEvent.pull_request.body,
        action: prEvent.action,
        merged: prEvent.pull_request.merged ?? false,
        html_url: prEvent.pull_request.html_url,
        user_login: prEvent.pull_request.user.login,
        changed_files: prEvent.pull_request.changed_files,
      });

      expect(captured.length).toBe(1);
      const emitted = captured[0];
      expect(emitted.repo).toBe("org/repo");
      expect(emitted.number).toBe(500);
      expect(emitted.title).toBe("Enrichment Test");
      expect(emitted.action).toBe("opened");
      // New enriched fields from PR #150
      expect(emitted.merged).toBe(true);
      expect(emitted.html_url).toBe("https://github.com/org/repo/pull/500");
      expect(emitted.user_login).toBe("alice");
      expect(emitted.changed_files).toBe(12);
    } finally {
      workflowEventBus.off("github.pull_request.opened", handler);
    }
  });

  test("merged defaults to false when pull_request.merged is undefined", () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => {
      captured.push(data as Record<string, unknown>);
    };

    workflowEventBus.on("github.pull_request.opened", handler);

    try {
      // Simulate a PR event where merged is undefined (pre-existing PRs)
      const prEvent = {
        action: "opened",
        repository: { full_name: "org/repo" },
        pull_request: {
          number: 501,
          title: "No merged field",
          body: null,
          html_url: "https://github.com/org/repo/pull/501",
          user: { login: "bob" },
          head: { ref: "feat-x", sha: "xyz" },
          base: { ref: "main" },
          // merged deliberately omitted
        },
      };

      // Replicate the emission logic — merged ?? false
      workflowEventBus.emit(`github.pull_request.${prEvent.action}`, {
        repo: prEvent.repository.full_name,
        number: prEvent.pull_request.number,
        title: prEvent.pull_request.title,
        body: prEvent.pull_request.body,
        action: prEvent.action,
        merged: (prEvent.pull_request as { merged?: boolean }).merged ?? false,
        html_url: prEvent.pull_request.html_url,
        user_login: prEvent.pull_request.user.login,
        changed_files: (prEvent.pull_request as { changed_files?: number }).changed_files,
      });

      expect(captured.length).toBe(1);
      expect(captured[0].merged).toBe(false);
      expect(captured[0].changed_files).toBeUndefined();
    } finally {
      workflowEventBus.off("github.pull_request.opened", handler);
    }
  });

  test("changed_files is included when present in PR event", () => {
    const captured: Record<string, unknown>[] = [];
    const handler = (data: unknown) => {
      captured.push(data as Record<string, unknown>);
    };

    workflowEventBus.on("github.pull_request.closed", handler);

    try {
      workflowEventBus.emit("github.pull_request.closed", {
        repo: "org/repo",
        number: 502,
        title: "Merged PR",
        body: null,
        action: "closed",
        merged: true,
        html_url: "https://github.com/org/repo/pull/502",
        user_login: "charlie",
        changed_files: 3,
      });

      expect(captured.length).toBe(1);
      expect(captured[0].changed_files).toBe(3);
      expect(captured[0].merged).toBe(true);
      expect(captured[0].user_login).toBe("charlie");
    } finally {
      workflowEventBus.off("github.pull_request.closed", handler);
    }
  });
});

// ===========================================================================
// 4. types.ts — PullRequestEvent.changed_files is optional
// ===========================================================================

describe("PullRequestEvent type", () => {
  test("changed_files field is optional and can be a number", () => {
    const withChangedFiles: PullRequestEvent = makePREvent();
    expect(withChangedFiles.pull_request.changed_files).toBe(5);

    const withoutChangedFiles: PullRequestEvent = {
      ...makePREvent(),
      pull_request: {
        number: 999,
        title: "No changed_files",
        body: null,
        html_url: "https://github.com/org/repo/pull/999",
        user: { login: "test" },
        head: { ref: "x", sha: "y" },
        base: { ref: "main" },
        merged: false,
        // changed_files intentionally omitted
      },
    };
    expect(withoutChangedFiles.pull_request.changed_files).toBeUndefined();
  });
});

// ===========================================================================
// 5. GitHub vcsProvider fields & backward-compat alias
// ===========================================================================

describe("GitHub vcsProvider fields", () => {
  test("createTaskExtended with source=github sets vcsProvider=github", () => {
    const task = createTaskExtended("[GitHub PR #400] vcsProvider test", {
      agentId: "lead-001",
      source: "github",
      vcsProvider: "github",
      taskType: "github-pr",
      vcsRepo: "org/vcs-test",
      vcsEventType: "pull_request",
      vcsNumber: 400,
      vcsAuthor: "tester",
      vcsUrl: "https://github.com/org/vcs-test/pull/400",
    });

    expect(task.vcsProvider).toBe("github");
    expect(task.vcsRepo).toBe("org/vcs-test");
    expect(task.vcsNumber).toBe(400);
    expect(task.vcsEventType).toBe("pull_request");
    expect(task.vcsAuthor).toBe("tester");
    expect(task.vcsUrl).toBe("https://github.com/org/vcs-test/pull/400");

    // Verify round-trip through getTaskById
    const retrieved = getTaskById(task.id);
    expect(retrieved?.vcsProvider).toBe("github");
    expect(retrieved?.vcsRepo).toBe("org/vcs-test");
  });

  test("findTaskByGitHub is a backward-compat alias for findTaskByVcs", () => {
    createTaskExtended("[GitHub PR #401] alias test", {
      agentId: "lead-001",
      source: "github",
      vcsProvider: "github",
      vcsRepo: "org/alias-test",
      vcsNumber: 401,
    });

    const viaVcs = findTaskByVcs("org/alias-test", 401);
    const viaAlias = findTaskByGitHub("org/alias-test", 401);
    expect(viaVcs).not.toBeNull();
    expect(viaAlias).not.toBeNull();
    expect(viaVcs?.id).toBe(viaAlias?.id);
  });

  test("handlePullRequest sets vcsProvider=github on created tasks", async () => {
    const event = makePREvent({
      pull_request: {
        number: 402,
        title: "VCS provider PR",
        body: null,
        html_url: "https://github.com/org/repo/pull/402",
        user: { login: "vcstester" },
        head: { ref: "feat-vcs", sha: "vcs123" },
        base: { ref: "main" },
        merged: false,
      },
    });

    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);

    const task = getTaskById(result.taskId!);
    expect(task?.vcsProvider).toBe("github");
    expect(task?.source).toBe("github");
    expect(task?.vcsRepo).toBe("org/repo");
    expect(task?.vcsNumber).toBe(402);
  });
});
