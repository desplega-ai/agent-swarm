/**
 * Write-time scrub for memory, channel and inbox messages, approval requests,
 * schedules, task text and agent_log.oldValue. Each test writes a synthetic
 * secret through the real writer, reads the row back from SQLite, and checks
 * that the secret is gone while a redaction marker and the surrounding
 * non-secret text survive.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { recordSchedulePreflightFailure } from "../be/automation-preflight";
import {
  cancelApprovalRequestById,
  cancelPendingApprovalRequestsForRun,
  closeDb,
  createAgent,
  createApprovalRequest,
  createChannel,
  createInboxMessage,
  createLogEntry,
  createScheduledTask,
  createTask,
  createTaskExtended,
  createWorkflow,
  createWorkflowRun,
  getApprovalRequestById,
  getDbClient,
  initDb,
  markInboxMessageResponded,
  postMessage,
  recordApprovalVotes,
  resolveApprovalRequest,
  updateScheduledTask,
} from "../be/db";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";
import { isSealedJson } from "../be/sealed-json";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { type SyntheticSecret, syntheticSecret } from "./synthetic-secret-helpers";

const TEST_DB_PATH = "./test-scrubbed-text-12e.sqlite";
const agentId = "aaaaaaaa-0000-4000-8000-000000000e12";

let secret: SyntheticSecret;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

/** Secret absent, a redaction marker present, and the context kept. */
function expectScrubbed(value: string | null | undefined, context: string): void {
  expect(value).toBeTruthy();
  expect(value).not.toContain(secret.value);
  expect(value).toContain("[REDACTED:");
  expect(value).toContain(context);
}

async function column(table: string, col: string, id: string): Promise<string | null> {
  const row = await getDbClient().get<Record<string, string | null>>(
    `SELECT "${col}" AS v FROM ${table} WHERE id = ?`,
    [id],
  );
  return row?.v ?? null;
}

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  await createAgent({ id: agentId, name: "Scrub 12e Agent", isLead: false, status: "idle" });
  secret = syntheticSecret("scrub12e");
});

// The test preload clears volatile secrets after every test, so register per test.
beforeEach(() => registerVolatileSecret(secret.value, secret.name));

afterAll(async () => {
  secret.cleanup();
  closeDb();
  await removeDbFiles();
});

describe("agent_memory", () => {
  test("store scrubs name, content, summary, version row and FTS row", async () => {
    const store = new SqliteMemoryStore();
    const memory = await store.store({
      agentId,
      scope: "agent",
      name: `deploy note ${secret.value}`,
      content: `the deploy token is ${secret.value} for staging`,
      summary: `summary ${secret.value}`,
      source: "manual",
    });
    // Callers embed the returned content, so it must be the scrubbed text.
    expectScrubbed(memory.content, "for staging");
    expectScrubbed(await column("agent_memory", "name", memory.id), "deploy note");
    expectScrubbed(await column("agent_memory", "content", memory.id), "for staging");
    expectScrubbed(await column("agent_memory", "summary", memory.id), "summary");
    const version = await getDbClient().get<{ content: string }>(
      "SELECT content FROM agent_memory_version WHERE memory_id = ?",
      [memory.id],
    );
    expectScrubbed(version?.content, "for staging");
    const fts = await getDbClient().get<{ content: string }>(
      "SELECT content FROM memory_fts WHERE memory_id = ?",
      [memory.id],
    );
    if (fts) expectScrubbed(fts.content, "for staging");
  });

  test("edit scrubs the new content", async () => {
    const store = new SqliteMemoryStore();
    const memory = await store.store({
      agentId,
      scope: "agent",
      name: "editable",
      content: "clean body",
      source: "manual",
    });
    const result = await store.edit({
      id: memory.id,
      mode: "replace",
      content: `edited body ${secret.value} end`,
      intent: "edit with secret",
      changedByAgentId: agentId,
    });
    expect(result.changed).toBe(true);
    expectScrubbed(result.memory.content, "edited body");
    expectScrubbed(await column("agent_memory", "content", memory.id), "edited body");
  });
});

describe("agent_tasks.task and agent_log.oldValue", () => {
  test("createTaskExtended scrubs the task text", async () => {
    const task = await createTaskExtended(`run the job with ${secret.value} please`, { agentId });
    expectScrubbed(await column("agent_tasks", "task", task.id), "run the job");
  });

  test("createTask scrubs the task text", async () => {
    const task = await createTask(agentId, `legacy create ${secret.value} please`);
    expectScrubbed(await column("agent_tasks", "task", task.id), "legacy create");
  });

  test("createLogEntry scrubs oldValue", async () => {
    const log = await createLogEntry({
      eventType: "task_status_change",
      agentId,
      oldValue: `previous ${secret.value}`,
      newValue: "next",
    });
    expectScrubbed(await column("agent_log", "oldValue", log.id), "previous");
  });
});

describe("channel and inbox messages", () => {
  test("postMessage scrubs content", async () => {
    const channel = await createChannel(`scrub-12e-${crypto.randomUUID().slice(0, 8)}`);
    const message = await postMessage(channel.id, agentId, `hello ${secret.value} channel`);
    expectScrubbed(await column("channel_messages", "content", message.id), "channel");
  });

  test("createInboxMessage and markInboxMessageResponded scrub free text", async () => {
    const inbox = await createInboxMessage(agentId, `inbox body ${secret.value}`, {
      matchedText: `matched ${secret.value}`,
    });
    expectScrubbed(await column("inbox_messages", "content", inbox.id), "inbox body");
    expectScrubbed(await column("inbox_messages", "matchedText", inbox.id), "matched");
    await markInboxMessageResponded(inbox.id, `reply ${secret.value}`);
    expectScrubbed(await column("inbox_messages", "responseText", inbox.id), "reply");
  });
});

describe("scheduled_tasks", () => {
  test("create and update scrub description, taskTemplate and lastErrorMessage", async () => {
    const schedule = await createScheduledTask({
      name: `scrub-12e-${crypto.randomUUID().slice(0, 8)}`,
      intervalMs: 60_000,
      description: `desc ${secret.value}`,
      taskTemplate: `call the api with ${secret.value}`,
    });
    expectScrubbed(await column("scheduled_tasks", "description", schedule.id), "desc");
    expectScrubbed(await column("scheduled_tasks", "taskTemplate", schedule.id), "call the api");

    await updateScheduledTask(schedule.id, {
      description: `new desc ${secret.value}`,
      taskTemplate: `new template ${secret.value}`,
      lastErrorMessage: `boom ${secret.value}`,
    });
    expectScrubbed(await column("scheduled_tasks", "description", schedule.id), "new desc");
    expectScrubbed(await column("scheduled_tasks", "taskTemplate", schedule.id), "new template");
    expectScrubbed(await column("scheduled_tasks", "lastErrorMessage", schedule.id), "boom");
  });

  test("preflight failure scrubs the message and still dedups the same day", async () => {
    const schedule = await createScheduledTask({
      name: `scrub-12e-${crypto.randomUUID().slice(0, 8)}`,
      intervalMs: 60_000,
      taskTemplate: "work",
    });
    const now = new Date();
    expect(await recordSchedulePreflightFailure(schedule.id, `missing ${secret.value}`, now)).toBe(
      true,
    );
    expectScrubbed(await column("scheduled_tasks", "lastErrorMessage", schedule.id), "missing");
    // Same raw reason the same day: the scrubbed compare still matches.
    expect(await recordSchedulePreflightFailure(schedule.id, `missing ${secret.value}`, now)).toBe(
      false,
    );
  });
});

describe("approval_requests", () => {
  test("create, vote and resolve scrub title, questions, approvals and resolutionReason, seal responses", async () => {
    const id = crypto.randomUUID();
    await createApprovalRequest({
      id,
      title: `approve ${secret.value} deploy`,
      questions: [{ id: "q1", type: "text", label: `paste ${secret.value} here` }],
      approvers: { users: [], policy: "any" },
    });
    expectScrubbed(await column("approval_requests", "title", id), "deploy");
    const questions = await column("approval_requests", "questions", id);
    expectScrubbed(questions, "paste");
    expect(() => JSON.parse(questions!)).not.toThrow();

    const vote = {
      responder: "operator",
      approved: true,
      responses: { q1: `note ${secret.value}` },
      respondedAt: new Date().toISOString(),
    };
    expect(await recordApprovalVotes(id, [vote])).toBe(true);
    const votes = await column("approval_requests", "approvals", id);
    expectScrubbed(votes, "note");
    expect(() => JSON.parse(votes!)).not.toThrow();

    const responses = { q1: `note ${secret.value}` };
    await resolveApprovalRequest(id, {
      status: "approved",
      responses,
      approvals: [vote],
      resolutionReason: `because ${secret.value}`,
    });
    expectScrubbed(await column("approval_requests", "resolutionReason", id), "because");
    expectScrubbed(await column("approval_requests", "approvals", id), "note");

    // Responses resume the workflow on recovery, so they stay byte-exact for
    // the reader and hold no plaintext at rest.
    const stored = await column("approval_requests", "responses", id);
    expect(isSealedJson(stored ?? "")).toBe(true);
    expect(stored).not.toContain(secret.value);
    expect(stored).not.toContain("note");
    expect((await getApprovalRequestById(id))?.responses).toEqual(responses);
  });

  test("cancel paths scrub the reason", async () => {
    const single = crypto.randomUUID();
    await createApprovalRequest({
      id: single,
      title: "single",
      questions: [],
      approvers: { users: [], policy: "any" },
    });
    await cancelApprovalRequestById(single, { reason: `stop ${secret.value}`, resolvedBy: null });
    expectScrubbed(await column("approval_requests", "resolutionReason", single), "stop");

    const workflow = await createWorkflow({
      name: `scrub-12e-${crypto.randomUUID().slice(0, 8)}`,
      definition: { nodes: [] },
    });
    const runId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: workflow.id });
    const inRun = crypto.randomUUID();
    await createApprovalRequest({
      id: inRun,
      title: "in run",
      questions: [],
      approvers: { users: [], policy: "any" },
      workflowRunId: runId,
    });
    await cancelPendingApprovalRequestsForRun(runId, `run cancelled ${secret.value}`);
    expectScrubbed(await column("approval_requests", "resolutionReason", inRun), "run cancelled");
  });
});
