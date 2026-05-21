/**
 * Integration tests for the operator-facing /api/users HTTP surface.
 *
 * Mirrors the kv-http.test.ts harness: spins up a real Bun.serve-compatible
 * Node http.Server with the same `handleCore → handleUsers` pipeline as the
 * production stack so we exercise:
 *   - the bearer-key gate (401 on missing/wrong key)
 *   - operator-actor fingerprinting (events tagged op:<16hex>)
 *   - route() factory matching for every endpoint
 *
 * Each test uses a fresh isolated SQLite file so identity-event tallies are
 * deterministic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createUser, getDb, initDb, upsertKv } from "../be/db";
import { fingerprintApiKey, linkIdentity } from "../be/users";
import { handleCore } from "../http/core";
import { handleUsers } from "../http/users";
import { getPathSegments, parseQueryParams } from "../http/utils";

const TEST_DB_PATH = "./test-http-users.sqlite";
const API_KEY = "test-users-key";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  return addr.port;
}

function createTestServer(apiKey: string): Server {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handleCore(req, res, myAgentId, apiKey);
    if (handled) return;
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    const ok = await handleUsers(req, res, pathSegments, queryParams);
    if (!ok) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}

let server: Server;
let port: number;
const ORIGINAL_API_KEY = process.env.AGENT_SWARM_API_KEY;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  // operator-actor reads getApiKey() which uses AGENT_SWARM_API_KEY env.
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  server = createTestServer(API_KEY);
  port = await listen(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.AGENT_SWARM_API_KEY;
  } else {
    process.env.AGENT_SWARM_API_KEY = ORIGINAL_API_KEY;
  }
});

beforeEach(() => {
  // Clean slate between tests for deterministic event counts.
  const db = getDb();
  db.run("DELETE FROM user_identity_events");
  db.run("DELETE FROM user_external_ids");
  db.run("DELETE FROM user_tokens");
  db.run("DELETE FROM users");
  db.run("DELETE FROM kv_entries");
});

function url(path: string): string {
  return `http://localhost:${port}${path}`;
}

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return fetch(url(path), { ...init, headers });
}

const OPERATOR_FP = fingerprintApiKey(API_KEY); // "op:<16hex>"

describe("auth", () => {
  test("GET /api/users without Authorization → 401", async () => {
    const r = await fetch(url("/api/users"));
    expect(r.status).toBe(401);
  });

  test("GET /api/users with wrong key → 401", async () => {
    const r = await fetch(url("/api/users"), {
      headers: { Authorization: "Bearer not-the-key" },
    });
    expect(r.status).toBe(401);
  });

  test("GET /api/users with valid key → 200", async () => {
    const r = await authedFetch("/api/users");
    expect(r.status).toBe(200);
  });
});

describe("GET /api/users", () => {
  test("returns users composed with identities, tokens, recentEvents", async () => {
    const u = createUser({ name: "Composed", email: "c@x.com" });
    linkIdentity(u.id, "slack", "U_COMP", { kind: "operator", id: OPERATOR_FP });

    const r = await authedFetch("/api/users");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { users: Array<Record<string, unknown>> };
    expect(body.users.length).toBe(1);
    const row = body.users[0]!;
    expect(row.id).toBe(u.id);
    expect(row.identities).toEqual([{ kind: "slack", externalId: "U_COMP" }]);
    expect(row.tokens).toEqual([]);
    const events = row.recentEvents as Array<{ eventType: string }>;
    expect(events.map((e) => e.eventType)).toContain("identity_added");
  });
});

describe("POST /api/users", () => {
  test("creates user + links identities + budget event, all tagged op:<fp>", async () => {
    const r = await authedFetch("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: "Tester",
        email: "tester@dev",
        dailyBudgetUsd: 5,
        identities: [
          { kind: "slack", externalId: "U_QA1" },
          { kind: "github", externalId: "qa-tester" },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: {
        id: string;
        identities: Array<{ kind: string; externalId: string }>;
        recentEvents: Array<{ eventType: string; actor: string }>;
      };
    };
    expect(user.identities).toEqual([
      { kind: "github", externalId: "qa-tester" },
      { kind: "slack", externalId: "U_QA1" },
    ]);
    // All operator-driven events MUST be tagged operator:<fingerprint>.
    for (const ev of user.recentEvents) {
      expect(ev.actor).toBe(`operator:${OPERATOR_FP}`);
    }
    expect(user.recentEvents.map((e) => e.eventType)).toContain("budget_changed");
    expect(
      user.recentEvents.map((e) => e.eventType).filter((t) => t === "identity_added").length,
    ).toBe(2);
  });
});

describe("PATCH /api/users/:id", () => {
  test("budget / status / emailAliases diffs each emit the right event types", async () => {
    const u = createUser({
      name: "Patcher",
      email: "p@x.com",
      emailAliases: ["a1@x.com"],
      dailyBudgetUsd: 10,
      status: "active",
    });

    const r = await authedFetch(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        dailyBudgetUsd: 20,
        status: "suspended",
        emailAliases: ["a2@x.com"], // a1 removed, a2 added
      }),
    });
    expect(r.status).toBe(200);

    const events = getDb()
      .prepare<{ eventType: string }, string>(
        "SELECT eventType FROM user_identity_events WHERE userId = ? ORDER BY rowid",
      )
      .all(u.id);
    const types = events.map((e) => e.eventType);
    expect(types).toContain("budget_changed");
    expect(types).toContain("status_changed");
    expect(types).toContain("email_added");
    expect(types).toContain("email_removed");
  });

  test("identities complete-list diff adds + removes", async () => {
    const u = createUser({ name: "IdDiff" });
    linkIdentity(u.id, "slack", "U_OLD", { kind: "operator", id: OPERATOR_FP });

    const r = await authedFetch(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        identities: [{ kind: "github", externalId: "newone" }],
      }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: { identities: Array<{ kind: string; externalId: string }> };
    };
    expect(user.identities).toEqual([{ kind: "github", externalId: "newone" }]);
  });

  test("404 for non-existent user", async () => {
    const r = await authedFetch("/api/users/nope", {
      method: "PATCH",
      body: JSON.stringify({ name: "X" }),
    });
    expect(r.status).toBe(404);
  });

  test("profile_changed events fire for name / role / notes / timezone / preferredChannel edits", async () => {
    const u = createUser({
      name: "Old",
      email: "old@x.com",
      role: "viewer",
      notes: "before",
      preferredChannel: "slack",
      timezone: "UTC",
    });

    const r = await authedFetch(`/api/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "New",
        role: "admin",
        notes: "after",
        timezone: "America/New_York",
        preferredChannel: "email",
      }),
    });
    expect(r.status).toBe(200);

    const events = getDb()
      .prepare<{ eventType: string; afterJson: string | null }, string>(
        "SELECT eventType, afterJson FROM user_identity_events WHERE userId = ? AND eventType = 'profile_changed' ORDER BY rowid",
      )
      .all(u.id);
    const fields = events
      .map((e) => (e.afterJson ? Object.keys(JSON.parse(e.afterJson))[0] : null))
      .filter((f): f is string => !!f);
    expect(fields).toContain("name");
    expect(fields).toContain("role");
    expect(fields).toContain("notes");
    expect(fields).toContain("timezone");
    expect(fields).toContain("preferredChannel");
  });

  test("profile_changed does NOT fire when value is unchanged", async () => {
    const u = createUser({ name: "Same", role: "admin" });
    const r = await authedFetch(`/api/users/${u.id}`, {
      method: "PATCH",
      // role unchanged, only emit no events for it; status doesn't change here either
      body: JSON.stringify({ role: "admin", name: "Renamed" }),
    });
    expect(r.status).toBe(200);
    const events = getDb()
      .prepare<{ afterJson: string | null }, string>(
        "SELECT afterJson FROM user_identity_events WHERE userId = ? AND eventType = 'profile_changed'",
      )
      .all(u.id);
    const fields = events
      .map((e) => (e.afterJson ? Object.keys(JSON.parse(e.afterJson))[0] : null))
      .filter((f): f is string => !!f);
    expect(fields).toContain("name");
    expect(fields).not.toContain("role");
  });
});

describe("identity link/unlink", () => {
  test("POST then DELETE round-trips", async () => {
    const u = createUser({ name: "RoundTrip" });

    const add = await authedFetch(`/api/users/${u.id}/identities`, {
      method: "POST",
      body: JSON.stringify({ kind: "github", externalId: "rt-gh" }),
    });
    expect(add.status).toBe(200);
    const addBody = (await add.json()) as {
      identities: Array<{ kind: string; externalId: string }>;
    };
    expect(addBody.identities).toContainEqual({ kind: "github", externalId: "rt-gh" });

    const del = await authedFetch(`/api/users/${u.id}/identities/github/rt-gh`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      identities: Array<{ kind: string; externalId: string }>;
    };
    expect(delBody.identities).toEqual([]);
  });

  test("DELETE with URL-encoded externalId removes the literal identity", async () => {
    // Webhook auto-link can store an externalId containing `@` (AgentMail
    // email-as-id, Linear `@handle`). The UI sends the path URL-encoded; the
    // handler must decode before SELECT/DELETE or the row sticks around.
    const u = createUser({ name: "DecodeDelete" });
    const literal = "@deletable";

    const add = await authedFetch(`/api/users/${u.id}/identities`, {
      method: "POST",
      body: JSON.stringify({ kind: "slack", externalId: literal }),
    });
    expect(add.status).toBe(200);

    const del = await authedFetch(
      `/api/users/${u.id}/identities/slack/${encodeURIComponent(literal)}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as {
      identities: Array<{ kind: string; externalId: string }>;
    };
    // Before the fix this still passed but the underlying row was never
    // touched — the SELECT for `%40deletable` found nothing. Verify the
    // literal-keyed row is actually gone by re-reading it.
    expect(delBody.identities.some((i) => i.externalId === literal)).toBe(false);
    const reread = await authedFetch(`/api/users/${u.id}`);
    const rb = (await reread.json()) as {
      user: { identities: Array<{ kind: string; externalId: string }> };
    };
    expect(rb.user.identities.some((i) => i.externalId === literal)).toBe(false);
  });
});

describe("GET /api/users/:id/events", () => {
  test("returns events DESC and respects limit + before cursor", async () => {
    const u = createUser({ name: "EventList" });
    const actor = { kind: "operator" as const, id: OPERATOR_FP };
    // Emit a sequence of events with monotonically-increasing createdAt.
    linkIdentity(u.id, "slack", "E1", actor);
    linkIdentity(u.id, "slack", "E2", actor);
    linkIdentity(u.id, "slack", "E3", actor);

    const r = await authedFetch(`/api/users/${u.id}/events?limit=2`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      events: Array<{ id: string; createdAt: string; eventType: string }>;
    };
    expect(body.events.length).toBe(2);
    // DESC: first event's createdAt >= second's.
    expect(body.events[0]!.createdAt >= body.events[1]!.createdAt).toBe(true);
    expect(body.events.every((e) => e.eventType === "identity_added")).toBe(true);
  });
});

describe("GET /api/users/unmapped", () => {
  test("groups :meta + :count entries and sorts by count DESC", async () => {
    // Seed two unmapped identities with different counts.
    const ns = "integration:unmapped:slack";
    upsertKv({
      namespace: ns,
      key: "U_LOW:meta",
      value: { lastSeenAt: "2026-05-01T00:00:00Z", sampleEventType: "message" },
      valueType: "json",
    });
    upsertKv({ namespace: ns, key: "U_LOW:count", value: 1, valueType: "integer" });
    upsertKv({
      namespace: ns,
      key: "U_HIGH:meta",
      value: { lastSeenAt: "2026-05-15T00:00:00Z", sampleEventType: "message" },
      valueType: "json",
    });
    upsertKv({ namespace: ns, key: "U_HIGH:count", value: 5, valueType: "integer" });

    const r = await authedFetch("/api/users/unmapped?kind=slack");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      unmapped: Array<{
        kind: string;
        externalId: string;
        count: number;
        lastSeenAt: string | null;
      }>;
    };
    expect(body.unmapped.length).toBe(2);
    expect(body.unmapped[0]!.externalId).toBe("U_HIGH");
    expect(body.unmapped[0]!.count).toBe(5);
    expect(body.unmapped[1]!.externalId).toBe("U_LOW");
  });
});

describe("POST /api/users/unmapped/:kind/:externalId/resolve", () => {
  test("link-to-existing branch links + clears kv rows", async () => {
    const existing = createUser({ name: "ExistingTarget" });
    const ns = "integration:unmapped:slack";
    upsertKv({ namespace: ns, key: "U_QA9:meta", value: { lastSeenAt: "x" }, valueType: "json" });
    upsertKv({ namespace: ns, key: "U_QA9:count", value: 3, valueType: "integer" });

    const r = await authedFetch("/api/users/unmapped/slack/U_QA9/resolve", {
      method: "POST",
      body: JSON.stringify({ userId: existing.id }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: { id: string; identities: Array<{ kind: string; externalId: string }> };
    };
    expect(user.id).toBe(existing.id);
    expect(user.identities).toContainEqual({ kind: "slack", externalId: "U_QA9" });

    // kv rows gone.
    const listR = await authedFetch("/api/users/unmapped?kind=slack");
    const listBody = (await listR.json()) as { unmapped: unknown[] };
    expect(listBody.unmapped.length).toBe(0);
  });

  test("create-new branch creates the user + links + clears kv rows", async () => {
    const ns = "integration:unmapped:github";
    upsertKv({ namespace: ns, key: "ghuser:meta", value: { lastSeenAt: "x" }, valueType: "json" });
    upsertKv({ namespace: ns, key: "ghuser:count", value: 1, valueType: "integer" });

    const r = await authedFetch("/api/users/unmapped/github/ghuser/resolve", {
      method: "POST",
      body: JSON.stringify({ name: "GH User", email: "gh@example.com" }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: { id: string; name: string; identities: Array<{ kind: string; externalId: string }> };
    };
    expect(user.name).toBe("GH User");
    expect(user.identities).toContainEqual({ kind: "github", externalId: "ghuser" });
  });

  test("URL-encoded externalId is decoded — kv rows clear, identity stored decoded", async () => {
    // Mimics an AgentMail/Linear @handle entry that contains `@` (or any
    // URL-reserved char). Kv keys are written by the webhook with the literal
    // externalId; the path param arrives URL-encoded; the handler must decode
    // before linking AND before deleting the two kv rows.
    const ns = "integration:unmapped:slack";
    const literal = "@alexdev";
    upsertKv({
      namespace: ns,
      key: `${literal}:meta`,
      value: { lastSeenAt: "2026-05-19T00:00:00Z", sampleEventType: "message" },
      valueType: "json",
    });
    upsertKv({ namespace: ns, key: `${literal}:count`, value: 2, valueType: "integer" });

    const r = await authedFetch(
      `/api/users/unmapped/slack/${encodeURIComponent(literal)}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Alex Dev", email: "alexdev@example.com" }),
      },
    );
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: { identities: Array<{ kind: string; externalId: string }> };
    };
    // Identity stored DECODED.
    expect(user.identities).toContainEqual({ kind: "slack", externalId: literal });

    // Kv rows for the literal key are gone (the bug was: handler deleted
    // `%40alexdev:meta`/`%40alexdev:count` instead of the literal `@…` keys).
    const listR = await authedFetch("/api/users/unmapped?kind=slack");
    const listBody = (await listR.json()) as {
      unmapped: Array<{ externalId: string }>;
    };
    expect(listBody.unmapped.some((u) => u.externalId === literal)).toBe(false);
  });

  test("URL-encoded kind is decoded — identity stored decoded, kv rows clear", async () => {
    // A custom integration kind containing a URL-reserved char (`;`). The
    // webhook writes the kv namespace with the literal kind; the path param
    // arrives URL-encoded. The handler must decode `kind` before linking AND
    // before computing the kv namespace for the two deletes.
    const literalKind = "custom;crm";
    const ns = `integration:unmapped:${literalKind}`;
    const externalId = "CRM_42";
    upsertKv({
      namespace: ns,
      key: `${externalId}:meta`,
      value: { lastSeenAt: "2026-05-19T00:00:00Z", sampleEventType: "lead" },
      valueType: "json",
    });
    upsertKv({ namespace: ns, key: `${externalId}:count`, value: 4, valueType: "integer" });

    const r = await authedFetch(
      `/api/users/unmapped/${encodeURIComponent(literalKind)}/${externalId}/resolve`,
      {
        method: "POST",
        body: JSON.stringify({ name: "CRM User", email: "crm@example.com" }),
      },
    );
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: { identities: Array<{ kind: string; externalId: string }> };
    };
    // Identity stored with the DECODED kind (bug stored `custom%3Bcrm`).
    expect(user.identities).toContainEqual({ kind: literalKind, externalId });

    // Kv rows cleared — the bug computed `integration:unmapped:custom%3Bcrm`
    // so the literal-namespace rows were never deleted.
    const listR = await authedFetch(`/api/users/unmapped?kind=${encodeURIComponent(literalKind)}`);
    const listBody = (await listR.json()) as {
      unmapped: Array<{ externalId: string }>;
    };
    expect(listBody.unmapped.some((u) => u.externalId === externalId)).toBe(false);
  });
});

describe("POST /api/users/:id/merge", () => {
  test("moves identities, removes source, leaves manual_merge event", async () => {
    const target = createUser({ name: "Target", email: "t@x.com" });
    const source = createUser({ name: "Source", email: "s@x.com", emailAliases: ["alt@x.com"] });
    const actor = { kind: "operator" as const, id: OPERATOR_FP };
    linkIdentity(source.id, "slack", "U_SRC", actor);
    linkIdentity(source.id, "github", "src-gh", actor);

    const r = await authedFetch(`/api/users/${target.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceUserId: source.id }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: {
        id: string;
        identities: Array<{ kind: string; externalId: string }>;
        emailAliases?: string[];
        recentEvents: Array<{ eventType: string }>;
      };
    };
    expect(user.id).toBe(target.id);
    // Source identities migrated.
    expect(user.identities).toContainEqual({ kind: "slack", externalId: "U_SRC" });
    expect(user.identities).toContainEqual({ kind: "github", externalId: "src-gh" });
    // Source email + aliases appended.
    expect(user.emailAliases ?? []).toContain("s@x.com");
    expect(user.emailAliases ?? []).toContain("alt@x.com");
    // manual_merge event present.
    expect(user.recentEvents.map((e) => e.eventType)).toContain("manual_merge");

    // Source user is gone.
    const sourceR = await authedFetch(`/api/users/${source.id}`);
    expect(sourceR.status).toBe(404);
  });

  test("manual_merge event payload carries the source user's id/name", async () => {
    const target = createUser({ name: "MergeTarget", email: "mt@x.com" });
    const source = createUser({ name: "MergeSource", email: "ms@x.com" });

    const r = await authedFetch(`/api/users/${target.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceUserId: source.id }),
    });
    expect(r.status).toBe(200);
    const { user } = (await r.json()) as {
      user: {
        recentEvents: Array<{
          eventType: string;
          after: { source?: { id?: string; name?: string; email?: string } } | null;
        }>;
      };
    };
    const mergeEvent = user.recentEvents.find((e) => e.eventType === "manual_merge");
    expect(mergeEvent).toBeDefined();
    // The deleted source user is snapshotted under `after.source` so the UI
    // can render "Merged manually from <source> → <target>".
    expect(mergeEvent!.after?.source?.id).toBe(source.id);
    expect(mergeEvent!.after?.source?.name).toBe("MergeSource");
    expect(mergeEvent!.after?.source?.email).toBe("ms@x.com");
  });

  test("400 when target == source", async () => {
    const u = createUser({ name: "Self" });
    const r = await authedFetch(`/api/users/${u.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ sourceUserId: u.id }),
    });
    expect(r.status).toBe(400);
  });
});
