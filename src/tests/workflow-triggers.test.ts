import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createWorkflow, getAllTasks, initDb } from "../be/db";
import { evaluateWorkflowTriggers } from "../workflows/triggers";

const TEST_DB_PATH = "./test-workflow-triggers.sqlite";

/**
 * Helper: create a workflow with a given trigger node → create-task action,
 * then fire `evaluateWorkflowTriggers` and check whether a downstream task was created.
 */
async function expectTriggerFires(
  triggerType: string,
  triggerConfig: Record<string, unknown>,
  eventType: string,
  eventData: Record<string, unknown>,
  shouldFire: boolean,
  label: string,
): Promise<void> {
  const taskTemplate = `trigger-test-${label}-${Date.now()}`;
  createWorkflow({
    name: `trigger-${label}`,
    definition: {
      nodes: [
        { id: "t1", type: triggerType, config: triggerConfig },
        { id: "a1", type: "create-task", config: { template: taskTemplate } },
      ],
      edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "a1" }],
    },
  });

  const idsBefore = new Set(getAllTasks().map((t) => t.id));
  evaluateWorkflowTriggers(eventType, eventData);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const newTasks = getAllTasks().filter((t) => !idsBefore.has(t.id));
  const matched = newTasks.find((t) => t.task === taskTemplate && t.source === "workflow");

  if (shouldFire) {
    expect(matched).toBeDefined();
  } else {
    expect(matched).toBeUndefined();
  }
}

describe("Workflow Triggers", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
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

  // ---------------------------------------------------------------------------
  // trigger-task-completed
  // ---------------------------------------------------------------------------
  describe("trigger-task-completed", () => {
    test("fires on task.completed event", async () => {
      await expectTriggerFires(
        "trigger-task-completed",
        {},
        "task.completed",
        { taskId: "t-1", output: "done" },
        true,
        "task-completed-basic",
      );
    });

    test("does NOT fire on task.created event", async () => {
      await expectTriggerFires(
        "trigger-task-completed",
        {},
        "task.created",
        { taskId: "t-2" },
        false,
        "task-completed-wrong-event",
      );
    });

    test("filters by matchTags", async () => {
      await expectTriggerFires(
        "trigger-task-completed",
        { matchTags: ["deploy"] },
        "task.completed",
        { tags: ["deploy", "prod"], taskId: "t-3" },
        true,
        "task-completed-tags-match",
      );
    });

    test("rejects when matchTags not present", async () => {
      await expectTriggerFires(
        "trigger-task-completed",
        { matchTags: ["deploy"] },
        "task.completed",
        { tags: ["review"], taskId: "t-4" },
        false,
        "task-completed-tags-nomatch",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // trigger-github-event
  // ---------------------------------------------------------------------------
  describe("trigger-github-event", () => {
    test("fires on matching github event type", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        { matchEventType: "push" },
        "github.push",
        { repo: "org/repo", ref: "refs/heads/main" },
        true,
        "github-push-match",
      );
    });

    test("does NOT fire on wrong github event type", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        { matchEventType: "push" },
        "github.pull_request.opened",
        { repo: "org/repo" },
        false,
        "github-wrong-type",
      );
    });

    test("does NOT fire on non-github event", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        {},
        "task.created",
        {},
        false,
        "github-not-github-event",
      );
    });

    test("filters by matchRepo", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        { matchRepo: "org/repo" },
        "github.push",
        { repo: "org/repo" },
        true,
        "github-repo-match",
      );
    });

    test("rejects when matchRepo does not match", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        { matchRepo: "org/repo" },
        "github.push",
        { repo: "other/repo" },
        false,
        "github-repo-nomatch",
      );
    });

    test("fires on any github event when no matchEventType specified", async () => {
      await expectTriggerFires(
        "trigger-github-event",
        {},
        "github.pull_request.opened",
        { repo: "any/repo" },
        true,
        "github-any-event",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // trigger-slack-message
  // ---------------------------------------------------------------------------
  describe("trigger-slack-message", () => {
    test("fires on slack.message event", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        {},
        "slack.message",
        { channel: "C123", text: "hello world", user: "U1" },
        true,
        "slack-basic",
      );
    });

    test("does NOT fire on non-slack event", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        {},
        "task.created",
        {},
        false,
        "slack-wrong-event",
      );
    });

    test("filters by matchChannel", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        { matchChannel: "C123" },
        "slack.message",
        { channel: "C123", text: "test" },
        true,
        "slack-channel-match",
      );
    });

    test("rejects when matchChannel does not match", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        { matchChannel: "C123" },
        "slack.message",
        { channel: "C999", text: "test" },
        false,
        "slack-channel-nomatch",
      );
    });

    test("filters by matchPattern (regex)", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        { matchPattern: "deploy" },
        "slack.message",
        { channel: "C1", text: "please deploy to prod" },
        true,
        "slack-pattern-match",
      );
    });

    test("rejects when matchPattern does not match", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        { matchPattern: "deploy" },
        "slack.message",
        { channel: "C1", text: "just a regular message" },
        false,
        "slack-pattern-nomatch",
      );
    });

    test("matchPattern is case-insensitive", async () => {
      await expectTriggerFires(
        "trigger-slack-message",
        { matchPattern: "DEPLOY" },
        "slack.message",
        { channel: "C1", text: "time to deploy" },
        true,
        "slack-pattern-case-insensitive",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // trigger-email (agentmail)
  // ---------------------------------------------------------------------------
  describe("trigger-email", () => {
    test("fires on agentmail.message.received event", async () => {
      await expectTriggerFires(
        "trigger-email",
        {},
        "agentmail.message.received",
        { inboxId: "inbox-1", from: "alice@example.com", subject: "Test" },
        true,
        "email-basic",
      );
    });

    test("does NOT fire on non-email event", async () => {
      await expectTriggerFires(
        "trigger-email",
        {},
        "slack.message",
        {},
        false,
        "email-wrong-event",
      );
    });

    test("filters by matchInbox", async () => {
      await expectTriggerFires(
        "trigger-email",
        { matchInbox: "inbox-1" },
        "agentmail.message.received",
        { inboxId: "inbox-1", from: "a@b.com" },
        true,
        "email-inbox-match",
      );
    });

    test("rejects when matchInbox does not match", async () => {
      await expectTriggerFires(
        "trigger-email",
        { matchInbox: "inbox-1" },
        "agentmail.message.received",
        { inboxId: "inbox-other", from: "a@b.com" },
        false,
        "email-inbox-nomatch",
      );
    });

    test("filters by matchSenderDomain", async () => {
      await expectTriggerFires(
        "trigger-email",
        { matchSenderDomain: "example.com" },
        "agentmail.message.received",
        { inboxId: "inbox-1", from: "alice@example.com" },
        true,
        "email-domain-match",
      );
    });

    test("rejects when matchSenderDomain does not match", async () => {
      await expectTriggerFires(
        "trigger-email",
        { matchSenderDomain: "example.com" },
        "agentmail.message.received",
        { inboxId: "inbox-1", from: "alice@other.org" },
        false,
        "email-domain-nomatch",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // trigger-webhook (always returns false via event bus)
  // ---------------------------------------------------------------------------
  describe("trigger-webhook", () => {
    test("does NOT fire via event bus (webhooks are triggered via HTTP only)", async () => {
      await expectTriggerFires(
        "trigger-webhook",
        {},
        "task.created",
        {},
        false,
        "webhook-no-eventbus-1",
      );
    });

    test("does NOT fire even on slack.message", async () => {
      await expectTriggerFires(
        "trigger-webhook",
        {},
        "slack.message",
        { text: "hi" },
        false,
        "webhook-no-eventbus-2",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // matchTaskFilters: matchSource, matchTaskType, matchAgentId
  // ---------------------------------------------------------------------------
  describe("matchTaskFilters extended", () => {
    test("matchSource filters correctly", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchSource: "api" },
        "task.created",
        { source: "api", tags: [] },
        true,
        "task-matchsource-match",
      );
    });

    test("matchSource rejects non-matching source", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchSource: "api" },
        "task.created",
        { source: "slack", tags: [] },
        false,
        "task-matchsource-nomatch",
      );
    });

    test("matchTaskType filters correctly", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchTaskType: "code-review" },
        "task.created",
        { taskType: "code-review", tags: [] },
        true,
        "task-matchtype-match",
      );
    });

    test("matchTaskType rejects non-matching type", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchTaskType: "code-review" },
        "task.created",
        { taskType: "bugfix", tags: [] },
        false,
        "task-matchtype-nomatch",
      );
    });

    test("matchAgentId filters correctly", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchAgentId: "agent-42" },
        "task.created",
        { agentId: "agent-42", tags: [] },
        true,
        "task-matchagent-match",
      );
    });

    test("matchAgentId rejects non-matching agent", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchAgentId: "agent-42" },
        "task.created",
        { agentId: "agent-99", tags: [] },
        false,
        "task-matchagent-nomatch",
      );
    });

    test("multiple filters combine with AND logic", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchSource: "api", matchTags: ["urgent"] },
        "task.created",
        { source: "api", tags: ["urgent"] },
        true,
        "task-multi-filter-match",
      );
    });

    test("multiple filters reject when any filter fails", async () => {
      await expectTriggerFires(
        "trigger-new-task",
        { matchSource: "api", matchTags: ["urgent"] },
        "task.created",
        { source: "slack", tags: ["urgent"] },
        false,
        "task-multi-filter-partial",
      );
    });
  });
});
