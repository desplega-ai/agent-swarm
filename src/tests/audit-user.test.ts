/**
 * Dedicated unit tests for `src/be/audit-user.ts`.
 *
 * Covers the two exported helpers:
 * - `resolveTaskAuditUserId` — ownership-validated task-header resolution.
 * - `resolveHttpAuditUserId` — HTTP variant (prefers authenticated user, then
 *   falls back to the ownership-validated header).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { resolveHttpAuditUserId, resolveTaskAuditUserId } from "../be/audit-user";
import { closeDb, createAgent, createTaskExtended, createUser, initDb, startTask } from "../be/db";
import { type IdentityActor, linkIdentity } from "../be/users";
import { setRequestAuth } from "../utils/request-auth-context";

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test" };

const TEST_DB_PATH = "./test-audit-user.sqlite";

let agentId: string;
let otherAgentId: string;
let humanUserId: string;
let ownedTaskId: string;
let foreignTaskId: string;
let noRequesterTaskId: string;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  initDb(TEST_DB_PATH);

  const agent = await createAgent({ name: "audit-user-test-agent", isLead: false, status: "idle" });
  agentId = agent.id;

  const other = await createAgent({
    name: "audit-user-other-agent",
    isLead: false,
    status: "idle",
  });
  otherAgentId = other.id;

  const user = await createUser({ name: "Audit User Test", email: "audit-user-test@example.com" });
  humanUserId = user.id;

  const ownedTask = await createTaskExtended("owned task", {
    agentId,
    requestedByUserId: humanUserId,
  });
  ownedTaskId = ownedTask.id;

  const foreignTask = await createTaskExtended("foreign task", {
    agentId: otherAgentId,
    requestedByUserId: humanUserId,
  });
  foreignTaskId = foreignTask.id;

  const noRequesterTask = await createTaskExtended("automation task", { agentId });
  noRequesterTaskId = noRequesterTask.id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

// ─── resolveTaskAuditUserId ──────────────────────────────────────────────────

describe("resolveTaskAuditUserId", () => {
  test("returns requester when source task is owned by the caller", async () => {
    expect(await resolveTaskAuditUserId(ownedTaskId, agentId)).toBe(humanUserId);
  });

  test("returns null when source task belongs to a different agent", async () => {
    expect(await resolveTaskAuditUserId(foreignTaskId, agentId)).toBeNull();
  });

  test("returns null when source task id is undefined", async () => {
    expect(await resolveTaskAuditUserId(undefined, agentId)).toBeNull();
  });

  test("returns null when caller agent id is undefined", async () => {
    expect(await resolveTaskAuditUserId(ownedTaskId, undefined)).toBeNull();
  });

  test("returns null when both arguments are undefined", async () => {
    expect(await resolveTaskAuditUserId(undefined, undefined)).toBeNull();
  });

  test("returns null when source task does not exist", async () => {
    expect(await resolveTaskAuditUserId("nonexistent-task-id", agentId)).toBeNull();
  });

  test("returns null when owned task has no human requester", async () => {
    expect(await resolveTaskAuditUserId(noRequesterTaskId, agentId)).toBeNull();
  });

  test("ambient-task fallback: no sourceTaskId resolves via the caller's current in-progress task", async () => {
    const ambientAgent = await createAgent({
      name: "ambient-agent",
      isLead: false,
      status: "idle",
    });
    const ambientTask = await createTaskExtended("ambient task", {
      agentId: ambientAgent.id,
      requestedByUserId: humanUserId,
    });
    await startTask(ambientTask.id);

    expect(await resolveTaskAuditUserId(undefined, ambientAgent.id)).toBe(humanUserId);
  });

  test("ambient-task fallback: no in-progress task for the caller still returns null", async () => {
    const idleAgent = await createAgent({ name: "idle-agent", isLead: false, status: "idle" });
    expect(await resolveTaskAuditUserId(undefined, idleAgent.id)).toBeNull();
  });

  test("machine-carried external-ID fallback: no requestedByUserId but a linked Slack id resolves the user", async () => {
    const slackLinkedUser = await createUser({ name: "Slack Fallback User" });
    await linkIdentity(slackLinkedUser.id, "slack", "U_AUDIT_FALLBACK", SYSTEM_ACTOR);

    const fallbackAgent = await createAgent({
      name: "fallback-agent",
      isLead: false,
      status: "idle",
    });
    const fallbackTask = await createTaskExtended(
      "slack-originated task, requester never stamped",
      {
        agentId: fallbackAgent.id,
        slackUserId: "U_AUDIT_FALLBACK",
      },
    );

    expect(await resolveTaskAuditUserId(fallbackTask.id, fallbackAgent.id)).toBe(
      slackLinkedUser.id,
    );
  });

  test("machine-carried external-ID fallback: unlinked Slack id still returns null (no guess)", async () => {
    const fallbackAgent = await createAgent({
      name: "fallback-agent-unlinked",
      isLead: false,
      status: "idle",
    });
    const fallbackTask = await createTaskExtended("slack-originated task, unlinked sender", {
      agentId: fallbackAgent.id,
      slackUserId: "U_NEVER_LINKED_AUDIT",
    });

    expect(await resolveTaskAuditUserId(fallbackTask.id, fallbackAgent.id)).toBeNull();
  });
});

// ─── resolveHttpAuditUserId ──────────────────────────────────────────────────

describe("resolveHttpAuditUserId", () => {
  function makeReq(headers: Record<string, string | string[]> = {}): IncomingMessage {
    const req = Readable.from([]) as IncomingMessage;
    req.method = "POST";
    req.url = "/api/test";
    req.headers = headers;
    return req;
  }

  test("prefers authenticated user over source-task header", async () => {
    const authUser = await createUser({
      name: "Auth User",
      email: `auth-pref-${Date.now()}@example.com`,
    });
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, { kind: "user", userId: authUser.id, user: authUser });
    expect(await resolveHttpAuditUserId(req, agentId)).toBe(authUser.id);
  });

  test("falls back to owned source task when no user auth", async () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, null);
    expect(await resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("ignores operator auth (not a user)", async () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, { kind: "operator", fingerprint: "op-123" });
    expect(await resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("returns null for a foreign source task without user auth", async () => {
    const req = makeReq({ "x-source-task-id": foreignTaskId });
    setRequestAuth(req, null);
    expect(await resolveHttpAuditUserId(req, agentId)).toBeNull();
  });

  test("returns null when no source-task header and no user auth", async () => {
    const req = makeReq();
    setRequestAuth(req, null);
    expect(await resolveHttpAuditUserId(req, agentId)).toBeNull();
  });

  test("handles array-valued x-source-task-id header (uses first element)", async () => {
    const req = makeReq({ "x-source-task-id": [ownedTaskId, "other-id"] });
    setRequestAuth(req, null);
    expect(await resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("returns null when caller agent id is undefined", async () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, null);
    expect(await resolveHttpAuditUserId(req, undefined)).toBeNull();
  });
});
