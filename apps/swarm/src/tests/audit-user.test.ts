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
import { closeDb, createAgent, createTaskExtended, createUser, initDb } from "../be/db";
import { setRequestAuth } from "../utils/request-auth-context";

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

  const agent = createAgent({ name: "audit-user-test-agent", isLead: false, status: "idle" });
  agentId = agent.id;

  const other = createAgent({ name: "audit-user-other-agent", isLead: false, status: "idle" });
  otherAgentId = other.id;

  const user = createUser({ name: "Audit User Test", email: "audit-user-test@example.com" });
  humanUserId = user.id;

  const ownedTask = createTaskExtended("owned task", {
    agentId,
    requestedByUserId: humanUserId,
  });
  ownedTaskId = ownedTask.id;

  const foreignTask = createTaskExtended("foreign task", {
    agentId: otherAgentId,
    requestedByUserId: humanUserId,
  });
  foreignTaskId = foreignTask.id;

  const noRequesterTask = createTaskExtended("automation task", { agentId });
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
  test("returns requester when source task is owned by the caller", () => {
    expect(resolveTaskAuditUserId(ownedTaskId, agentId)).toBe(humanUserId);
  });

  test("returns null when source task belongs to a different agent", () => {
    expect(resolveTaskAuditUserId(foreignTaskId, agentId)).toBeNull();
  });

  test("returns null when source task id is undefined", () => {
    expect(resolveTaskAuditUserId(undefined, agentId)).toBeNull();
  });

  test("returns null when caller agent id is undefined", () => {
    expect(resolveTaskAuditUserId(ownedTaskId, undefined)).toBeNull();
  });

  test("returns null when both arguments are undefined", () => {
    expect(resolveTaskAuditUserId(undefined, undefined)).toBeNull();
  });

  test("returns null when source task does not exist", () => {
    expect(resolveTaskAuditUserId("nonexistent-task-id", agentId)).toBeNull();
  });

  test("returns null when owned task has no human requester", () => {
    expect(resolveTaskAuditUserId(noRequesterTaskId, agentId)).toBeNull();
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

  test("prefers authenticated user over source-task header", () => {
    const authUser = createUser({
      name: "Auth User",
      email: `auth-pref-${Date.now()}@example.com`,
    });
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, { kind: "user", userId: authUser.id, user: authUser });
    expect(resolveHttpAuditUserId(req, agentId)).toBe(authUser.id);
  });

  test("falls back to owned source task when no user auth", () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("ignores operator auth (not a user)", () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, { kind: "operator", fingerprint: "op-123" });
    expect(resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("returns null for a foreign source task without user auth", () => {
    const req = makeReq({ "x-source-task-id": foreignTaskId });
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBeNull();
  });

  test("returns null when no source-task header and no user auth", () => {
    const req = makeReq();
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBeNull();
  });

  test("handles array-valued x-source-task-id header (uses first element)", () => {
    const req = makeReq({ "x-source-task-id": [ownedTaskId, "other-id"] });
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, agentId)).toBe(humanUserId);
  });

  test("returns null when caller agent id is undefined", () => {
    const req = makeReq({ "x-source-task-id": ownedTaskId });
    setRequestAuth(req, null);
    expect(resolveHttpAuditUserId(req, undefined)).toBeNull();
  });
});
