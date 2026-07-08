import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { handleMessageReceived } from "../agentmail/handlers";
import type { AgentMailWebhookPayload } from "../agentmail/types";
import {
  closeDb,
  createAgent,
  createUser,
  getAllUsers,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";
import { findUserByEmail } from "../be/users";

const TEST_DB_PATH = "./test-agentmail-handlers.sqlite";

function eventsFor(userId: string): Array<{
  eventType: string;
  actor: string;
  beforeJson: string | null;
  afterJson: string | null;
}> {
  return getDb()
    .prepare<
      { eventType: string; actor: string; beforeJson: string | null; afterJson: string | null },
      string
    >(
      "SELECT eventType, actor, beforeJson, afterJson FROM user_identity_events WHERE userId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(userId);
}

function makePayload(opts: {
  from: string;
  eventId?: string;
  threadId?: string;
  messageId?: string;
  inboxId?: string;
  subject?: string;
  text?: string;
}): AgentMailWebhookPayload {
  return {
    type: "event",
    event_type: "message.received",
    event_id: opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
    message: {
      message_id: opts.messageId ?? `msg_${Math.random().toString(36).slice(2)}`,
      thread_id: opts.threadId ?? `thr_${Math.random().toString(36).slice(2)}`,
      inbox_id: opts.inboxId ?? "bot@swarm.dev",
      organization_id: "org_test",
      from_: opts.from,
      to: ["bot@swarm.dev"],
      cc: [],
      bcc: [],
      reply_to: [],
      subject: opts.subject ?? "Test",
      preview: "",
      text: opts.text ?? "Hello",
      html: null,
      labels: [],
      attachments: [],
      in_reply_to: null,
      references: [],
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

// Per-test (not per-file) DB reset: bun's default `retry` (bunfig.toml) retries
// a failing test in place, re-invoking beforeEach/afterEach around each
// attempt. With a file-level beforeAll/afterAll instead, a transient failure
// on attempt 1 (of any cause) leaves its side effects (the just-created user)
// in place for the retry, which then finds that user already resolved and
// silently no-ops the create — turning one flaky attempt into a deterministic
// "before+1 != after" mismatch on every subsequent attempt. Resetting to a
// fresh DB (and re-registering the lead) before every test/retry makes each
// attempt idempotent regardless of how many times it's retried, and also
// re-runs initDb's global resolver registration right before this file's own
// resolveTemplate() calls, minimizing the window for another concurrently
// executing test file's own initDb() to have repointed it in between.
beforeEach(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  initDb(TEST_DB_PATH);
  // Ensure a lead exists so handler's findLeadAgent() returns truthy and a
  // task gets created on the "no inbox mapping" path.
  createAgent({ name: "LeadAgent", isLead: true, status: "idle" });
  // Re-register agentmail templates — prompt-template-resolver.test.ts and
  // prompt-template-session.test.ts call clearTemplateDefinitions() and never
  // restore the shared (process-wide) registry, so if either runs first in
  // the same bun worker, resolveTemplate("agentmail.email.*", ...) silently
  // returns { text: "", skipped: true } here instead of throwing — producing
  // a task with an empty body rather than a visible failure. Same defensive
  // pattern as heartbeat-checklist.test.ts's beforeEach.
  await import(`../agentmail/templates?t=${Date.now()}`);
});

afterEach(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

describe("handleMessageReceived — identity auto-link via findOrCreateUserByEmail", () => {
  test("UNKNOWN sender → users row auto-created, identity_added event emitted, task requestedByUserId populated", async () => {
    const before = getAllUsers().length;
    const result = await handleMessageReceived(
      makePayload({ from: "Alice Newcomer <alice.newcomer@example.com>" }),
    );
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();

    const user = findUserByEmail("alice.newcomer@example.com");
    expect(user).not.toBeNull();
    expect(user!.name).toBe("Alice Newcomer");
    expect(getAllUsers().length).toBe(before + 1);

    const events = eventsFor(user!.id);
    expect(events.map((e) => e.eventType)).toEqual(["identity_added"]);
    expect(events[0]!.actor).toBe("system:webhook:agentmail");

    const task = getTaskById(result.taskId!);
    expect(task).not.toBeNull();
    expect(task!.requestedByUserId).toBe(user!.id);
    // The resolved canonical name renders in the task text — never the raw
    // From header (Alice's display name + email as typed by the sender).
    expect(task!.task).toContain("Alice Newcomer (email:alice.newcomer@example.com)");
    expect(task!.task).not.toContain("Alice Newcomer <alice.newcomer@example.com>");
  });

  test("KNOWN sender (existing users.email) → no duplicate row, auto_merge event, task requestedByUserId populated", async () => {
    const existing = createUser({ name: "Bob Existing", email: "bob.existing@example.com" });
    const beforeCount = getAllUsers().length;

    const result = await handleMessageReceived(makePayload({ from: "bob.existing@example.com" }));
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(getAllUsers().length).toBe(beforeCount);

    const events = eventsFor(existing.id);
    expect(events.map((e) => e.eventType)).toContain("auto_merge");

    const task = getTaskById(result.taskId!);
    expect(task!.requestedByUserId).toBe(existing.id);
  });

  test("sender matching emailAliases (not primary email) resolves via json_each-style alias path", async () => {
    const existing = createUser({
      name: "Carol Alias",
      email: "carol@example.com",
      emailAliases: ["carol.alt@example.com", "c.alias@example.com"],
    });
    const beforeCount = getAllUsers().length;

    const result = await handleMessageReceived(
      makePayload({ from: "Carol Alt <carol.alt@example.com>" }),
    );
    expect(result.created).toBe(true);
    expect(getAllUsers().length).toBe(beforeCount);

    const events = eventsFor(existing.id);
    expect(events.map((e) => e.eventType)).toContain("auto_merge");

    const task = getTaskById(result.taskId!);
    expect(task!.requestedByUserId).toBe(existing.id);
  });

  test("sender with no extractable email → task created, requestedByUserId remains undefined, no findOrCreateUserByEmail side-effect", async () => {
    const beforeCount = getAllUsers().length;

    const result = await handleMessageReceived(
      makePayload({ from: "Unknown Sender (no address)" }),
    );
    // Handler still creates a task (lead routing path), but with no user resolved.
    expect(result.created).toBe(true);
    expect(getAllUsers().length).toBe(beforeCount);

    const task = getTaskById(result.taskId!);
    expect(task!.requestedByUserId).toBeFalsy();
    // No display name is ever guessed — the raw header is kept as the
    // sentinel's identifier, suffixed with the explicit UNKNOWN marker.
    expect(task!.task).toContain("Unknown Sender (no address) (unknown user)");
  });
});
