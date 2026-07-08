/**
 * Step-2 verification: the Slack identity resolution cascade.
 *
 * Covers — without spinning up Bolt — the three behavioural slices that
 * matter for the kv-backed enrichment + unmapped tracker rewire:
 *
 *   1. Cascade for a NEW Slack user with an email — creates a `users` row,
 *      writes a `user_external_ids` row, emits `identity_added` events.
 *   2. Cascade for the SAME user a second time — fast-path through
 *      `findUserByExternalId`; no duplicate row, no extra `client.users.info`.
 *   3. Cascade for a Slack user without an email — writes two kv rows under
 *      `integration:unmapped:slack` (`<U>:meta` JSON + `<U>:count` integer).
 *      Second sighting bumps count to 2 and refreshes the meta TTL.
 *   4. `enrichSlackUserEmail` does NOT cache failures (null email → next
 *      call hits the API again).
 *   5. `enrichSlackUserEmail` DOES cache successes for 24h (next call is a
 *      kv hit; `client.users.info` is not called).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createUser, getDb, getKv, initDb } from "../be/db";
import {
  findUserByExternalId,
  getUserIdentities,
  type IdentityActor,
  linkIdentity,
} from "../be/users";
import { enrichSlackUserEmail, resolveSlackUserId, rewriteSlackMentions } from "../slack/enrich";

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test" };

const TEST_DB_PATH = "./test-slack-identity-resolution.sqlite";

// ---------------------------------------------------------------------------
// Mock Slack WebClient
// ---------------------------------------------------------------------------

interface MockUsersInfoResponse {
  user?: {
    real_name?: string;
    profile?: {
      email?: string;
      real_name?: string;
    };
  };
}

/**
 * Minimal WebClient stub — only the `users.info` method is exercised by the
 * code under test. Counts calls per user so cache-hit assertions can be
 * unambiguous.
 */
function makeMockClient(byUserId: Record<string, MockUsersInfoResponse | "throw">) {
  const callCounts: Record<string, number> = {};
  const client = {
    users: {
      info: async ({ user }: { user: string }) => {
        callCounts[user] = (callCounts[user] ?? 0) + 1;
        const fixture = byUserId[user];
        if (fixture === "throw") {
          throw new Error(`Mock client.users.info(${user}) threw`);
        }
        if (!fixture) {
          throw new Error(`No fixture for user ${user}`);
        }
        return fixture;
      },
    },
  };
  return {
    client: client as any,
    callCounts,
  };
}

// ---------------------------------------------------------------------------
// DB lifecycle
// ---------------------------------------------------------------------------

function cleanupDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

beforeAll(() => {
  cleanupDb();
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  cleanupDb();
});

beforeEach(() => {
  // Wipe state between tests — full isolation. Identity-related tables only;
  // leave the schema and seeded singletons untouched.
  const db = getDb();
  db.exec("DELETE FROM user_identity_events");
  db.exec("DELETE FROM user_external_ids");
  db.exec("DELETE FROM users");
  db.exec("DELETE FROM kv_entries WHERE namespace LIKE 'integration:%'");
});

function countUsers(): number {
  return getDb().prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0;
}

function externalIdRows(): Array<{ kind: string; externalId: string; userId: string }> {
  return getDb()
    .prepare<{ kind: string; externalId: string; userId: string }, []>(
      "SELECT kind, externalId, userId FROM user_external_ids ORDER BY kind, externalId",
    )
    .all();
}

function identityEventTypes(userId: string): string[] {
  return getDb()
    .prepare<{ eventType: string }, string>(
      "SELECT eventType FROM user_identity_events WHERE userId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(userId)
    .map((r) => r.eventType);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveSlackUserId — three-step cascade", () => {
  test("NEW user with email → creates users + external_ids + emits identity_added", async () => {
    const { client } = makeMockClient({
      U_HUMAN: {
        user: {
          real_name: "Real Human",
          profile: { email: "real@example.com", real_name: "Real Human" },
        },
      },
    });

    const userId = await resolveSlackUserId(client, "U_HUMAN", {
      sampleEventType: "message",
      sampleContext: "hello swarm",
    });

    expect(userId).toBeDefined();
    expect(countUsers()).toBe(1);

    const ext = externalIdRows();
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatchObject({ kind: "slack", externalId: "U_HUMAN", userId });

    const events = identityEventTypes(userId!);
    // Brand-new email triggers two `identity_added` events:
    //   * `findOrCreateUserByEmail` creates the user → `identity_added`
    //   * `linkIdentity('slack', ...)` adds the alias → `identity_added`
    expect(events).toEqual(["identity_added", "identity_added"]);
  });

  test("SAME user again → fast path, no duplicate users / external_ids / API call", async () => {
    const { client, callCounts } = makeMockClient({
      U_HUMAN: {
        user: {
          real_name: "Real Human",
          profile: { email: "real@example.com", real_name: "Real Human" },
        },
      },
    });

    const first = await resolveSlackUserId(client, "U_HUMAN", {
      sampleEventType: "message",
      sampleContext: "hello swarm",
    });
    const second = await resolveSlackUserId(client, "U_HUMAN", {
      sampleEventType: "message",
      sampleContext: "again",
    });

    expect(second).toBe(first);
    expect(countUsers()).toBe(1);
    expect(externalIdRows()).toHaveLength(1);
    // The second call must hit the alias fast path — `client.users.info` was
    // called exactly once (on the first lookup).
    expect(callCounts.U_HUMAN).toBe(1);
  });

  test("NEW user with NO email → writes :meta + :count kv rows under integration:unmapped:slack", async () => {
    const { client } = makeMockClient({
      U_BOT: {
        user: {
          real_name: "Bot Account",
          profile: {}, // no email
        },
      },
    });

    const userId = await resolveSlackUserId(client, "U_BOT", {
      sampleEventType: "message",
      sampleContext: "noisy bot ping",
    });

    expect(userId).toBeUndefined();
    expect(countUsers()).toBe(0);
    expect(externalIdRows()).toHaveLength(0);

    const meta = getKv("integration:unmapped:slack", "U_BOT:meta");
    expect(meta).not.toBeNull();
    expect(meta!.valueType).toBe("json");
    const metaValue = meta!.value as {
      sampleEventType: string;
      sampleContext: string;
      lastSeenAt: string;
    };
    expect(metaValue.sampleEventType).toBe("message");
    expect(metaValue.sampleContext).toBe("noisy bot ping");
    expect(metaValue.lastSeenAt).toBeTruthy();
    expect(meta!.expiresAt).not.toBeNull();

    const count = getKv("integration:unmapped:slack", "U_BOT:count");
    expect(count).not.toBeNull();
    expect(count!.valueType).toBe("integer");
    expect(count!.value).toBe(1);
    expect(count!.expiresAt).not.toBeNull();
  });

  test("NO-email user seen twice → count goes to 2, meta upserted", async () => {
    const { client } = makeMockClient({
      U_BOT: { user: { profile: {} } },
    });

    await resolveSlackUserId(client, "U_BOT", {
      sampleEventType: "message",
      sampleContext: "first",
    });
    await resolveSlackUserId(client, "U_BOT", {
      sampleEventType: "message",
      sampleContext: "second",
    });

    const meta = getKv("integration:unmapped:slack", "U_BOT:meta");
    expect((meta!.value as { sampleContext: string }).sampleContext).toBe("second");

    const count = getKv("integration:unmapped:slack", "U_BOT:count");
    expect(count!.value).toBe(2);
  });

  test("auto-link merges into an existing user by email", async () => {
    const { client } = makeMockClient({
      U_HUMAN: {
        user: { profile: { email: "shared@example.com", real_name: "Shared Email Human" } },
      },
    });

    // Seed an existing user with the same email — no slack alias yet.
    const db = getDb();
    db.prepare(
      `INSERT INTO users (id, name, email, emailAliases, status, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      "existing-id",
      "Pre-existing",
      "shared@example.com",
      "[]",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const userId = await resolveSlackUserId(client, "U_HUMAN", {
      sampleEventType: "message",
      sampleContext: "hi",
    });

    // Auto-merge: cascade lands on the existing row, no new `users` insert.
    expect(userId).toBe("existing-id");
    expect(countUsers()).toBe(1);

    // One slack alias linked to the pre-existing user.
    const identities = getUserIdentities("existing-id");
    expect(identities).toEqual([{ kind: "slack", externalId: "U_HUMAN" }]);

    // Audit trail: auto_merge (by email) + identity_added (alias link).
    expect(identityEventTypes("existing-id")).toEqual(["auto_merge", "identity_added"]);
  });
});

describe("enrichSlackUserEmail — 24h success cache, no failure cache", () => {
  test("cache hit on second call (success)", async () => {
    const { client, callCounts } = makeMockClient({
      U_OK: { user: { profile: { email: "ok@example.com", real_name: "OK User" } } },
    });

    const first = await enrichSlackUserEmail(client, "U_OK");
    const second = await enrichSlackUserEmail(client, "U_OK");

    expect(first).toBe("ok@example.com");
    expect(second).toBe("ok@example.com");
    expect(callCounts.U_OK).toBe(1);

    // Cached row carries the 24h TTL anchor.
    const cached = getKv("integration:user-enrichment:slack", "U_OK");
    expect(cached).not.toBeNull();
    expect(cached!.expiresAt).not.toBeNull();
    expect(cached!.expiresAt! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(cached!.expiresAt! - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  test("API throw → no cache, second call still calls the API", async () => {
    const { client, callCounts } = makeMockClient({ U_ERR: "throw" });

    const first = await enrichSlackUserEmail(client, "U_ERR");
    const second = await enrichSlackUserEmail(client, "U_ERR");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(callCounts.U_ERR).toBe(2);

    // Nothing persisted.
    expect(getKv("integration:user-enrichment:slack", "U_ERR")).toBeNull();
  });

  test("no-email profile → no cache, second call still calls the API", async () => {
    const { client, callCounts } = makeMockClient({
      U_NOEMAIL: { user: { profile: {} } },
    });

    const first = await enrichSlackUserEmail(client, "U_NOEMAIL");
    const second = await enrichSlackUserEmail(client, "U_NOEMAIL");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(callCounts.U_NOEMAIL).toBe(2);

    expect(getKv("integration:user-enrichment:slack", "U_NOEMAIL")).toBeNull();
  });
});

describe("findUserByExternalId — sanity check after cascade", () => {
  test("post-cascade lookup matches the cascade's return id", async () => {
    const { client } = makeMockClient({
      U_HUMAN: { user: { profile: { email: "u@example.com", real_name: "U" } } },
    });

    const id = await resolveSlackUserId(client, "U_HUMAN", {
      sampleEventType: "message",
      sampleContext: "test",
    });
    const looked = findUserByExternalId("slack", "U_HUMAN");
    expect(looked).not.toBeNull();
    expect(looked!.id).toBe(id);
  });
});

describe("rewriteSlackMentions — pure DB, zero Slack API calls", () => {
  test("resolved mention renders '<@id|Name>' — the canonical pair", () => {
    const user = createUser({ name: "Manuel", email: "manuel-rw@example.com" });
    linkIdentity(user.id, "slack", "U3000RESOLVED", SYSTEM_ACTOR);

    const rewritten = rewriteSlackMentions("hey <@U3000RESOLVED> can you look at this");
    expect(rewritten).toBe("hey <@U3000RESOLVED|Manuel> can you look at this");
  });

  test("unresolved mention renders '<@id> (unknown user)' — never a guessed name", () => {
    const rewritten = rewriteSlackMentions("hey <@U4000UNKNOWN> can you look at this");
    expect(rewritten).toBe("hey <@U4000UNKNOWN> (unknown user) can you look at this");
  });

  test("multiple mentions in one string are each rewritten independently", () => {
    const user = createUser({ name: "Tainá", email: "taina-rw@example.com" });
    linkIdentity(user.id, "slack", "U5000RESOLVED", SYSTEM_ACTOR);

    const rewritten = rewriteSlackMentions("<@U5000RESOLVED> and <@U6000UNKNOWN> both here");
    expect(rewritten).toBe("<@U5000RESOLVED|Tainá> and <@U6000UNKNOWN> (unknown user) both here");
  });

  test("text with no mentions passes through unchanged", () => {
    expect(rewriteSlackMentions("no mentions here")).toBe("no mentions here");
  });
});
