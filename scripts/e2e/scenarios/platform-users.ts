import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { type ComposedUser, createUser, userOf } from "./platform-helpers";

// Users, identities, the unmapped-identity queue, merge and the identity-event timeline.
// Existing scenarios (invites, connector-handoff) cover POST /api/users, invites and the
// connector exchange. This one covers everything else under /api/users.

async function getUser(ctx: ScenarioContext, id: string, query = ""): Promise<ComposedUser> {
  const response = await ctx.api("GET", `/api/users/${id}${query}`);
  expectStatus(response, [200], `get user ${id}`);
  return userOf(response.json);
}

function eventTypes(user: ComposedUser): string[] {
  return user.recentEvents.map((event) => event.eventType);
}

/** Seeds the two kv rows a channel integration writes when it meets an unknown sender. */
async function seedUnmapped(
  ctx: ScenarioContext,
  kind: string,
  externalId: string,
  count: number,
  lastSeenAt: string,
) {
  const namespace = `integration:unmapped:${kind}`;
  const key = encodeURIComponent(externalId);
  const meta = await ctx.api("PUT", `/api/kv/_/${namespace}/${key}:meta`, {
    body: {
      value: { lastSeenAt, sampleEventType: "message", sampleContext: { from: externalId } },
    },
  });
  expectStatus(meta, [200], `seed ${kind} ${externalId} meta`);
  const counter = await ctx.api("PUT", `/api/kv/_/${namespace}/${key}:count`, {
    body: { value: count, valueType: "integer" },
  });
  expectStatus(counter, [200], `seed ${kind} ${externalId} count`);
}

async function unmappedFor(ctx: ScenarioContext, kind: string) {
  const response = await ctx.api("GET", `/api/users/unmapped?kind=${kind}&limit=1000`);
  expectStatus(response, [200], `list unmapped ${kind}`);
  return asRecords(response.json, "unmapped");
}

export const platformUsersLifecycle: Scenario = {
  name: "platform-users-lifecycle",
  order: 600,
  async run(ctx) {
    expectStatus(await ctx.api("GET", "/api/users", { apiKey: null }), [401], "list users unauth");
    expectStatus(
      await ctx.api("GET", "/api/users/unmapped", { apiKey: null }),
      [401],
      "list unmapped unauth",
    );

    // ── create ───────────────────────────────────────────────────────────────
    const slackId = `UPLAT${ctx.nonce}A`;
    const githubId = `plat-gh-${ctx.nonce}`;
    const alice = await createUser(ctx, "alice", {
      email: `alice-${ctx.nonce}@example.com`,
      dailyBudgetUsd: 5,
      identities: [{ kind: "slack", externalId: slackId }],
    });
    expect(alice.status === "active", `a new user is active, got ${alice.status}`);
    expect(alice.email === `alice-${ctx.nonce}@example.com`, "create keeps the email");
    expect(alice.dailyBudgetUsd === 5, "create keeps the daily budget");
    expect(
      alice.identities.some((i) => i.kind === "slack" && i.externalId === slackId),
      "create links the initial identity",
    );
    expect(
      eventTypes(alice).includes("identity_added") && eventTypes(alice).includes("budget_changed"),
      `create records identity_added and budget_changed, got ${eventTypes(alice)}`,
    );
    const budget = ctx.db.get<{ daily_budget_usd: number }>(
      "SELECT daily_budget_usd FROM budgets WHERE scope = 'user' AND scope_id = ?",
      [alice.id],
    );
    expect(budget?.daily_budget_usd === 5, "the user budget is mirrored into the budgets table");

    const bob = await createUser(ctx, "bob", {
      email: `bob-${ctx.nonce}@example.com`,
      emailAliases: [`bob-alias-${ctx.nonce}@example.com`],
      identities: [{ kind: "github", externalId: githubId }],
    });
    expect(bob.emailAliases.length === 1, "create keeps the email aliases");

    expectStatus(
      await ctx.api("POST", "/api/users", { body: { name: "" } }),
      [400],
      "create with empty name",
    );
    expectStatus(
      await ctx.api("POST", "/api/users", { body: { name: "Bad Email", email: "not-an-email" } }),
      [400],
      "create with invalid email",
    );
    // FINDING: the route documents 400/401 only, but a duplicate email surfaces the raw
    // SQLite UNIQUE violation as a 500 instead of a 400/409.
    const duplicate = await ctx.api("POST", "/api/users", {
      body: { name: "Duplicate Email", email: `alice-${ctx.nonce}@example.com` },
    });
    expectStatus(duplicate, [500], "create with a duplicate email");

    // ── list and get ─────────────────────────────────────────────────────────
    const listed = await ctx.api("GET", "/api/users");
    expectStatus(listed, [200], "list users");
    const users = asRecords(listed.json, "users");
    expect(
      users.some((u) => u.id === alice.id) && users.some((u) => u.id === bob.id),
      "list contains the new users",
    );
    const quiet = await ctx.api("GET", "/api/users?recentEvents=0");
    expectStatus(quiet, [200], "list users with recentEvents=0");
    const quietAlice = asRecords(quiet.json, "users").find((u) => u.id === alice.id);
    // FINDING: the query schema accepts recentEvents=0 (min 0), but the event reader clamps
    // the limit to at least 1, so the list still carries one event per user instead of none.
    expect(
      quietAlice && Array.isArray(quietAlice.recentEvents) && quietAlice.recentEvents.length === 1,
      "recentEvents=0 still returns one event (clamped to a minimum of 1)",
    );
    expectStatus(
      await ctx.api("GET", "/api/users?recentEvents=51"),
      [400],
      "list users recentEvents above the cap",
    );

    const fetched = await getUser(ctx, alice.id, "?recentEvents=1");
    expect(
      fetched.id === alice.id && fetched.recentEvents.length === 1,
      "get honours recentEvents",
    );
    expectStatus(await ctx.api("GET", "/api/users/no-such-user"), [404], "get unknown user");
    expectStatus(
      await ctx.api("GET", `/api/users/${alice.id}`, { apiKey: null }),
      [401],
      "get user unauth",
    );

    // ── update ───────────────────────────────────────────────────────────────
    expectStatus(
      await ctx.api("PATCH", `/api/users/${alice.id}`, { body: {} }),
      [400],
      "patch with no field",
    );
    expectStatus(
      await ctx.api("PATCH", `/api/users/${alice.id}`, { body: { email: "nope" } }),
      [400],
      "patch with invalid email",
    );
    expectStatus(
      await ctx.api("PATCH", "/api/users/no-such-user", { body: { name: "x" } }),
      [404],
      "patch unknown user",
    );

    const renamed = `Alice Renamed ${ctx.nonce}`;
    const patched = await ctx.api("PATCH", `/api/users/${alice.id}`, {
      body: {
        name: renamed,
        timezone: "Europe/Madrid",
        notes: "e2e notes",
        emailAliases: [`alice-alias-${ctx.nonce}@example.com`],
        dailyBudgetUsd: null,
        metadata: { team: "platform" },
      },
    });
    expectStatus(patched, [200], "patch profile");
    const afterPatch = userOf(patched.json);
    expect(
      afterPatch.name === renamed && afterPatch.timezone === "Europe/Madrid",
      "patch applies fields",
    );
    expect(afterPatch.dailyBudgetUsd === null, "patch clears the budget with null");
    const types = (await getUser(ctx, alice.id, "?recentEvents=50")).recentEvents.map(
      (event) => event.eventType,
    );
    for (const expected of ["profile_changed", "budget_changed", "email_added"]) {
      expect(types.includes(expected), `patch records ${expected}, got ${types}`);
    }
    expect(
      ctx.db.get("SELECT 1 AS one FROM budgets WHERE scope = 'user' AND scope_id = ?", [
        alice.id,
      ]) === null,
      "clearing the budget removes the budgets row",
    );
    expect(
      ctx.db.get<{ name: string }>("SELECT name FROM users WHERE id = ?", [alice.id])?.name ===
        renamed,
      "the rename is persisted",
    );

    // comms merges into metadata.comms without touching sibling keys; null removes it.
    const withComms = userOf(
      (await ctx.api("PATCH", `/api/users/${alice.id}`, { body: { comms: { tone: "formal" } } }))
        .json,
    );
    expect(
      JSON.stringify(withComms.metadata) ===
        JSON.stringify({ team: "platform", comms: { tone: "formal" } }),
      `comms merges into metadata, got ${JSON.stringify(withComms.metadata)}`,
    );
    const withoutComms = userOf(
      (await ctx.api("PATCH", `/api/users/${alice.id}`, { body: { comms: null } })).json,
    );
    expect(
      JSON.stringify(withoutComms.metadata) === JSON.stringify({ team: "platform" }),
      `comms null removes only comms, got ${JSON.stringify(withoutComms.metadata)}`,
    );

    // ── identities ───────────────────────────────────────────────────────────
    const extraId = `plat-extra-${ctx.nonce}`;
    const linked = await ctx.api("POST", `/api/users/${alice.id}/identities`, {
      body: { kind: "linear", externalId: extraId },
    });
    expectStatus(linked, [200], "link identity");
    const linkedList = asRecords(linked.json, "identities");
    expect(
      linkedList.some((i) => i.kind === "linear" && i.externalId === extraId),
      "link returns the updated identity list",
    );
    // Linking is not idempotent: the (kind, externalId) primary key collides even for the owner.
    expectStatus(
      await ctx.api("POST", `/api/users/${alice.id}/identities`, {
        body: { kind: "linear", externalId: extraId },
      }),
      [400],
      "re-linking an identity the user already holds",
    );
    // An identity belongs to one user: linking it to another user is a PK collision.
    expectStatus(
      await ctx.api("POST", `/api/users/${bob.id}/identities`, {
        body: { kind: "linear", externalId: extraId },
      }),
      [400],
      "link an identity owned by another user",
    );
    expectStatus(
      await ctx.api("POST", `/api/users/${alice.id}/identities`, {
        body: { kind: "", externalId: "x" },
      }),
      [400],
      "link with empty kind",
    );
    expectStatus(
      await ctx.api("POST", "/api/users/no-such-user/identities", {
        body: { kind: "linear", externalId: "x" },
      }),
      [404],
      "link identity for unknown user",
    );

    // An externalId with reserved URL characters must round-trip through the path.
    const odd = `plat+odd:${ctx.nonce}@example.com`;
    expectStatus(
      await ctx.api("POST", `/api/users/${alice.id}/identities`, {
        body: { kind: "agentmail", externalId: odd },
      }),
      [200],
      "link an identity with reserved characters",
    );
    const removed = await ctx.api(
      "DELETE",
      `/api/users/${alice.id}/identities/agentmail/${encodeURIComponent(odd)}`,
    );
    expectStatus(removed, [200], "unlink an identity with reserved characters");
    expect(
      !asRecords(removed.json, "identities").some((i) => i.externalId === odd),
      "unlink removes the identity",
    );
    const unlinked = await ctx.api("DELETE", `/api/users/${alice.id}/identities/linear/${extraId}`);
    expectStatus(unlinked, [200], "unlink identity");
    expect(
      !asRecords(unlinked.json, "identities").some((i) => i.externalId === extraId),
      "unlink returns the remaining identities",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/users/${alice.id}/identities/linear/${extraId}`),
      [200],
      "unlinking an absent identity is a no-op",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/users/no-such-user/identities/linear/${extraId}`),
      [404],
      "unlink for unknown user",
    );
    const identityRows = ctx.db.query<{ externalId: string }>(
      "SELECT externalId FROM user_external_ids WHERE userId = ?",
      [alice.id],
    );
    expect(
      identityRows.length === 1 && identityRows[0]?.externalId === slackId,
      "only the initial identity remains in user_external_ids",
    );

    // ── unmapped identities ──────────────────────────────────────────────────
    const unmappedA = `UPLATUNM${ctx.nonce}A`;
    const unmappedB = `UPLATUNM${ctx.nonce}B`;
    // The kv key alphabet has no "@" or "+", so use ":" and "." to exercise path decoding.
    const unmappedC = `plat:unm.${ctx.nonce}`;
    await seedUnmapped(ctx, "slack", unmappedA, 7, "2026-10-30T10:00:00.000Z");
    await seedUnmapped(ctx, "slack", unmappedB, 2, "2026-10-30T11:00:00.000Z");
    await seedUnmapped(ctx, "linear", unmappedC, 1, "2026-10-30T12:00:00.000Z");

    const slackRows = await unmappedFor(ctx, "slack");
    const rowA = slackRows.find((r) => r.externalId === unmappedA);
    const rowB = slackRows.find((r) => r.externalId === unmappedB);
    expect(rowA && rowB, "the seeded unmapped identities are listed");
    expect(
      rowA.count === 7 &&
        rowA.kind === "slack" &&
        rowA.lastSeenAt === "2026-10-30T10:00:00.000Z" &&
        rowA.sampleEventType === "message",
      `unmapped row carries count, lastSeenAt and sampleEventType: ${JSON.stringify(rowA)}`,
    );
    expect(
      slackRows.indexOf(rowA) < slackRows.indexOf(rowB),
      "unmapped rows sort by count descending",
    );
    expect(
      (await unmappedFor(ctx, "linear")).every((r) => r.kind === "linear"),
      "the kind filter narrows the queue",
    );
    const limited = await ctx.api("GET", "/api/users/unmapped?limit=1");
    expect(asRecords(limited.json, "unmapped").length === 1, "limit caps the queue");
    expectStatus(
      await ctx.api("GET", "/api/users/unmapped?limit=0"),
      [400],
      "unmapped limit below 1",
    );

    // Resolve by linking to an existing user.
    const resolved = await ctx.api(
      "POST",
      `/api/users/unmapped/slack/${encodeURIComponent(unmappedA)}/resolve`,
      { body: { userId: bob.id } },
    );
    expectStatus(resolved, [200], "resolve unmapped to an existing user");
    const resolvedUser = userOf(resolved.json);
    expect(
      resolvedUser.id === bob.id &&
        resolvedUser.identities.some((i) => i.kind === "slack" && i.externalId === unmappedA),
      "resolve links the identity to the chosen user",
    );
    expect(
      !(await unmappedFor(ctx, "slack")).some((r) => r.externalId === unmappedA),
      "a resolved identity leaves the queue",
    );
    expectStatus(
      await ctx.api("GET", `/api/kv/_/integration:unmapped:slack/${unmappedA}:meta`),
      [404],
      "resolve deletes the meta kv row",
    );

    // Resolve by creating a new user; the externalId needs URL encoding.
    const created = await ctx.api(
      "POST",
      `/api/users/unmapped/linear/${encodeURIComponent(unmappedC)}/resolve`,
      {
        body: { name: `Resolved Linear ${ctx.nonce}`, email: `resolved-${ctx.nonce}@example.com` },
      },
    );
    expectStatus(created, [200], "resolve unmapped into a new user");
    const createdUser = userOf(created.json);
    expect(
      createdUser.id !== bob.id &&
        createdUser.identities.some((i) => i.kind === "linear" && i.externalId === unmappedC),
      "resolve can create a user for the identity",
    );
    expectStatus(
      await ctx.api("POST", `/api/users/unmapped/slack/${unmappedB}/resolve`, {
        body: { userId: "no-such-user" },
      }),
      [404],
      "resolve to an unknown user",
    );
    expectStatus(
      await ctx.api("POST", `/api/users/unmapped/slack/${unmappedB}/resolve`, { body: {} }),
      [400],
      "resolve without a target",
    );
    expect(
      (await unmappedFor(ctx, "slack")).some((r) => r.externalId === unmappedB),
      "a failed resolve leaves the identity in the queue",
    );
    // Leave nothing behind for the next scenario that reads the queue.
    expectStatus(
      await ctx.api("POST", `/api/users/unmapped/slack/${unmappedB}/resolve`, {
        body: { userId: alice.id },
      }),
      [200],
      "resolve the second unmapped identity",
    );

    // ── merge ────────────────────────────────────────────────────────────────
    expectStatus(
      await ctx.api("POST", `/api/users/${alice.id}/merge`, { body: { sourceUserId: alice.id } }),
      [400],
      "merge a user into itself",
    );
    expectStatus(
      await ctx.api("POST", `/api/users/${alice.id}/merge`, {
        body: { sourceUserId: "no-such-user" },
      }),
      [404],
      "merge from an unknown source",
    );
    expectStatus(
      await ctx.api("POST", "/api/users/no-such-user/merge", { body: { sourceUserId: bob.id } }),
      [404],
      "merge into an unknown target",
    );
    // A suspended source is never "the last active admin", so the merge is deterministic.
    expectStatus(
      await ctx.api("PATCH", `/api/users/${bob.id}`, { body: { status: "suspended" } }),
      [200],
      "suspend the merge source",
    );
    const bobBefore = await getUser(ctx, bob.id);
    const merged = await ctx.api("POST", `/api/users/${alice.id}/merge`, {
      body: { sourceUserId: bob.id },
    });
    expectStatus(merged, [200], "merge users");
    const mergedUser = userOf(merged.json);
    expect(mergedUser.id === alice.id, "merge returns the target user");
    for (const identity of bobBefore.identities) {
      expect(
        mergedUser.identities.some(
          (i) => i.kind === identity.kind && i.externalId === identity.externalId,
        ),
        `merge moves identity ${identity.kind}:${identity.externalId}`,
      );
    }
    const aliasList = (mergedUser.emailAliases ?? []).map((a) => a.toLowerCase());
    for (const moved of [bob.email, ...bob.emailAliases]) {
      expect(aliasList.includes(String(moved).toLowerCase()), `merge keeps ${moved} as an alias`);
    }
    expect(eventTypes(mergedUser).includes("manual_merge"), "merge records manual_merge");
    expectStatus(await ctx.api("GET", `/api/users/${bob.id}`), [404], "the merge source is gone");
    expect(
      ctx.db.get("SELECT 1 AS one FROM users WHERE id = ?", [bob.id]) === null,
      "the merge source row is deleted",
    );

    // ── events ───────────────────────────────────────────────────────────────
    const events = await ctx.api("GET", `/api/users/${alice.id}/events`);
    expectStatus(events, [200], "list events");
    const all = asRecords(events.json, "events");
    expect(all.length >= 6, `alice has an event history, got ${all.length}`);
    const stamps = all.map((e) => String(e.createdAt));
    expect([...stamps].sort().reverse().join() === stamps.join(), "events are newest first");
    expect(
      all.every((e) => String(e.actor).startsWith("operator:")),
      "operator calls are attributed to an operator actor",
    );
    const page = await ctx.api("GET", `/api/users/${alice.id}/events?limit=2`);
    expect(asRecords(page.json, "events").length === 2, "limit caps the events");
    const second = asRecords(page.json, "events")[1];
    const older = await ctx.api(
      "GET",
      `/api/users/${alice.id}/events?before=${encodeURIComponent(String(second?.createdAt))}`,
    );
    expectStatus(older, [200], "events before a cursor");
    expect(
      asRecords(older.json, "events").every((e) => String(e.createdAt) < String(second?.createdAt)),
      "before returns only older events",
    );
    expectStatus(
      await ctx.api("GET", "/api/users/no-such-user/events"),
      [404],
      "events unknown user",
    );
    expectStatus(
      await ctx.api("GET", `/api/users/${alice.id}/events?limit=0`),
      [400],
      "events limit below 1",
    );
    expectStatus(
      await ctx.api("GET", `/api/users/${alice.id}/events`, { apiKey: null }),
      [401],
      "events unauth",
    );
  },
};

export const platformUsersAccess: Scenario = {
  name: "platform-users-access",
  order: 605,
  async run(ctx) {
    // ── whoami: operator key ─────────────────────────────────────────────────
    const operator = await ctx.api("GET", "/api/whoami");
    expectStatus(operator, [200], "whoami with the operator key");
    const operatorBody = asRecord(operator.json);
    expect(
      operatorBody.kind === "operator" && operatorBody.user === null,
      "operator key is kind operator",
    );
    expect(asRecord(operatorBody.grants).grantsAll === true, "operator grants everything");
    expectStatus(await ctx.api("GET", "/api/whoami", { apiKey: null }), [401], "whoami unauth");
    expectStatus(
      await ctx.api("GET", "/api/whoami", { apiKey: "aswt_not-a-real-token" }),
      [401],
      "whoami with an unknown token",
    );

    // ── mint, use, revoke an MCP token ───────────────────────────────────────
    const user = await createUser(ctx, "token-user");
    expectStatus(
      await ctx.api("POST", `/api/users/${user.id}/mcp-tokens`, { apiKey: null, body: {} }),
      [401],
      "mint unauth",
    );
    expectStatus(
      await ctx.api("POST", "/api/users/no-such-user/mcp-tokens", { body: {} }),
      [404],
      "mint for unknown user",
    );
    const minted = await ctx.api("POST", `/api/users/${user.id}/mcp-tokens`, {
      body: { label: `e2e ${ctx.nonce}` },
    });
    expectStatus(minted, [200], "mint token");
    const mintedBody = asRecord(minted.json);
    const plaintext = String(mintedBody.plaintext);
    expect(plaintext.startsWith("aswt_"), "the plaintext token starts with aswt_");
    const summary = asRecord(mintedBody.token);
    expect(
      summary.label === `e2e ${ctx.nonce}` &&
        summary.tokenPreview === plaintext.slice(-4) &&
        summary.revokedAt === null,
      "the token summary carries label, a 4-char preview and no revocation",
    );
    expect(
      !JSON.stringify(await getUser(ctx, user.id)).includes(plaintext),
      "reads never expose the plaintext",
    );
    const stored = ctx.db.get<{ tokenHash: string }>(
      "SELECT tokenHash FROM user_tokens WHERE id = ?",
      [String(summary.id)],
    );
    expect(stored && stored.tokenHash !== plaintext, "only a hash of the token is stored");

    const whoami = await ctx.api("GET", "/api/whoami", { apiKey: plaintext });
    expectStatus(whoami, [200], "whoami with the user token");
    const principal = asRecord(whoami.json);
    expect(
      principal.kind === "user" && asRecord(principal.user).id === user.id,
      "the user token resolves to its user",
    );
    expect(
      asRecord(principal.grants).grantsAll === true,
      "RBAC is off, so a user token grants everything",
    );
    expect(
      (await getUser(ctx, user.id)).tokens.find((t) => t.id === String(summary.id))?.lastUsedAt,
      "using the token stamps lastUsedAt",
    );

    const client = new Client({ name: "agent-swarm-e2e-platform", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp-user`), {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      }),
    );
    try {
      expect((await client.listTools()).tools.length > 0, "/mcp-user lists tools for the token");
    } finally {
      await client.close();
    }

    // Revoke: wrong user and unknown token are 404, the right call flips revokedAt.
    const other = await createUser(ctx, "token-other");
    expectStatus(
      await ctx.api("DELETE", `/api/users/${other.id}/mcp-tokens/${String(summary.id)}`),
      [404],
      "revoke a token through another user",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/users/${user.id}/mcp-tokens/no-such-token`),
      [404],
      "revoke an unknown token",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/users/no-such-user/mcp-tokens/${String(summary.id)}`),
      [404],
      "revoke for an unknown user",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/users/${user.id}/mcp-tokens/${String(summary.id)}`, {
        apiKey: null,
      }),
      [401],
      "revoke unauth",
    );
    const revoked = await ctx.api(
      "DELETE",
      `/api/users/${user.id}/mcp-tokens/${String(summary.id)}`,
    );
    expectStatus(revoked, [200], "revoke token");
    expect(
      userOf(revoked.json).tokens.find((t) => t.id === String(summary.id))?.revokedAt,
      "revoke stamps revokedAt",
    );
    expectStatus(
      await ctx.api("GET", "/api/whoami", { apiKey: plaintext }),
      [401],
      "a revoked token no longer authenticates",
    );
    const rejected = new Client({ name: "agent-swarm-e2e-platform-revoked", version: "1.0.0" });
    let connectError: unknown;
    try {
      await rejected.connect(
        new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp-user`), {
          requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
        }),
      );
    } catch (error) {
      connectError = error;
    } finally {
      await rejected.close().catch(() => {});
    }
    expect(connectError, "/mcp-user rejects a revoked token");
    const finalTypes = eventTypes(await getUser(ctx, user.id));
    expect(
      finalTypes.includes("token_minted") && finalTypes.includes("token_revoked"),
      `the timeline records mint and revoke, got ${finalTypes}`,
    );

    // ── RBAC roles ───────────────────────────────────────────────────────────
    expectStatus(await ctx.api("GET", "/api/rbac/roles", { apiKey: null }), [401], "roles unauth");
    const catalog = await ctx.api("GET", "/api/rbac/roles");
    expectStatus(catalog, [200], "list roles");
    const roles = asRecords(catalog.json, "roles");
    for (const name of ["admin", "requester", "viewer"]) {
      const role = roles.find((r) => r.name === name);
      expect(
        role && role.isBuiltin === true && role.primary === true,
        `built-in role ${name} exists`,
      );
    }
    const admin = roles.find((r) => r.name === "admin");
    const viewer = roles.find((r) => r.name === "viewer");
    const requester = roles.find((r) => r.name === "requester");
    expect(
      admin?.grantsAll === true && viewer?.grantsAll === false,
      "only admin grants everything",
    );
    expect(
      Array.isArray(requester?.verbs) && (requester.verbs as string[]).includes("task.create.own"),
      "requester lists its verbs",
    );

    const held = await ctx.api("GET", `/api/users/${other.id}/roles`);
    expectStatus(held, [200], "get roles");
    expect(
      asRecords(held.json, "roles")
        .map((r) => r.name)
        .join() === "admin",
      "a new user holds the admin role",
    );
    expectStatus(
      await ctx.api("GET", "/api/users/no-such-user/roles"),
      [404],
      "roles unknown user",
    );
    expectStatus(
      await ctx.api("GET", `/api/users/${other.id}/roles`, { apiKey: null }),
      [401],
      "roles unauth for a user",
    );

    const demoted = await ctx.api("PUT", `/api/users/${other.id}/roles`, {
      body: { roles: ["viewer"] },
    });
    expectStatus(demoted, [200], "set roles to viewer");
    expect(
      asRecords(demoted.json, "roles")
        .map((r) => r.name)
        .join() === "viewer",
      "set roles replaces the role set",
    );
    const roleRows = ctx.db.query<{ name: string }>(
      `SELECT r.name FROM principal_roles pr JOIN roles r ON r.id = pr.roleId
       WHERE pr.principalType = 'user' AND pr.principalId = ?`,
      [other.id],
    );
    expect(roleRows.map((r) => r.name).join() === "viewer", "the role change is persisted");
    expect(
      (await getUser(ctx, other.id)).recentEvents.some(
        (e) =>
          e.eventType === "profile_changed" &&
          JSON.stringify(e.before) === JSON.stringify({ rbacRoles: ["admin"] }) &&
          JSON.stringify(e.after) === JSON.stringify({ rbacRoles: ["viewer"] }),
      ),
      "the role change is on the identity timeline",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, { body: { roles: [] } }),
      [400],
      "set an empty role list",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, {
        body: { roles: ["admin", "viewer"] },
      }),
      [400],
      "set two primary roles",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, {
        body: { roles: ["viewer", "no-such-role"] },
      }),
      [400],
      "set an unknown role",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, {
        body: { roles: ["viewer"], extra: 1 },
      }),
      [400],
      "set roles with an unknown body key",
    );
    expectStatus(
      await ctx.api("PUT", "/api/users/no-such-user/roles", { body: { roles: ["viewer"] } }),
      [404],
      "set roles for an unknown user",
    );
    // Agents never change human roles, even with the shared key.
    const agentRes = await ctx.api("POST", "/api/agents", {
      body: { name: `platform-roles-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(agentRes, [201], "register role-probe agent");
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, {
        agentId: String(asRecord(agentRes.json).id),
        body: { roles: ["requester"] },
      }),
      [403],
      "an agent cannot set human roles",
    );
    expectStatus(
      await ctx.api("PUT", `/api/users/${other.id}/roles`, { body: { roles: ["admin"] } }),
      [200],
      "restore the admin role",
    );

    // ── invite leftovers: GET /invite/{code} and re-invite ───────────────────
    const email = `platform-invite-${ctx.nonce}@example.com`;
    expectStatus(
      await ctx.api("POST", "/api/invites", { body: { email: "not-an-email" } }),
      [400],
      "invite with an invalid email",
    );
    const invited = await ctx.api("POST", "/api/invites", { body: { email, role: "viewer" } });
    expectStatus(invited, [201], "invite as viewer");
    const invite = asRecord(invited.json);
    const invitedUser = userOf(invited.json);
    expect(invitedUser.status === "invited", "an invited user is in status invited");
    expect(
      ctx.db
        .query<{ name: string }>(
          `SELECT r.name FROM principal_roles pr JOIN roles r ON r.id = pr.roleId
           WHERE pr.principalType = 'user' AND pr.principalId = ?`,
          [invitedUser.id],
        )
        .map((r) => r.name)
        .join() === "viewer",
      "the invite assigns the requested role",
    );
    const code = new URL(String(invite.inviteUrl)).pathname.split("/").pop() ?? "";

    const opened = await ctx.api("GET", `/invite/${code}`, { apiKey: null, redirect: "manual" });
    expectStatus(opened, [302], "open the invite link");
    const location = new URL(opened.headers.get("location") ?? "http://invalid");
    expect(
      location.pathname === "/join" && location.hash === `#code=${code}`,
      "the link redirects to /join with the code",
    );
    expect(opened.headers.get("cache-control") === "no-store", "the redirect is not cacheable");
    expect(
      opened.headers.get("referrer-policy") === "no-referrer",
      "the redirect hides the referrer",
    );
    expectStatus(
      await ctx.api("GET", "/invite/short", { apiKey: null, redirect: "manual" }),
      [404],
      "open a malformed invite code",
    );

    // Re-inviting an invited user replaces the link and the role; the old code dies.
    const reinvited = await ctx.api("POST", "/api/invites", { body: { email, role: "requester" } });
    expectStatus(reinvited, [201], "re-invite");
    expect(userOf(reinvited.json).id === invitedUser.id, "a re-invite reuses the invited user");
    const newCode =
      new URL(String(asRecord(reinvited.json).inviteUrl)).pathname.split("/").pop() ?? "";
    expect(newCode !== code, "a re-invite mints a new code");
    expectStatus(
      await ctx.api("POST", "/api/invites/exchange", { apiKey: null, body: { code } }),
      [404],
      "the replaced code no longer exchanges",
    );
    const exchanged = await ctx.api("POST", "/api/invites/exchange", {
      apiKey: null,
      body: { code: newCode },
    });
    expectStatus(exchanged, [200], "the new code exchanges");
    expect(
      asRecord(exchanged.json).userId === invitedUser.id,
      "the exchange returns the invited user",
    );
  },
};
