import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeDb, createAgent, createUser, getDb, initDb } from "../be/db";
import { getUserIdentities, type IdentityActor, linkIdentity } from "../be/users";
import { registerManageUserTool } from "../tools/manage-user";
import { registerResolveUserTool, resolveUserInputSchema } from "../tools/resolve-user";

const TEST_DB_PATH = "./test-mcp-tools-user.sqlite";

const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_ID = "22222222-2222-4222-8222-222222222222";

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test" };

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
};

/**
 * Invoke a registered MCP tool's handler directly. Mirrors the test pattern
 * used by `src/tests/update-profile-auth.test.ts`.
 */
async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
  callerAgentId: string = LEAD_ID,
): Promise<CallToolResult> {
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  };
  return tool.handler(args, extra);
}

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  if (first && first.type === "text") return first.text;
  return "";
}

function eventsFor(userId: string): Array<{ eventType: string; afterJson: string | null }> {
  return getDb()
    .prepare<{ eventType: string; afterJson: string | null }, string>(
      "SELECT eventType, afterJson FROM user_identity_events WHERE userId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(userId);
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
  closeDb();
  initDb(TEST_DB_PATH);
  createAgent({ id: LEAD_ID, name: "Test Lead", isLead: true, status: "idle" });
  createAgent({ id: WORKER_ID, name: "Test Worker", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
});

describe("resolve-user MCP tool (new {kind, externalId, email} shape)", () => {
  const server = new McpServer({ name: "test-resolve-user", version: "1.0.0" });
  registerResolveUserTool(server);

  test("matches by (kind, externalId) → findUserByExternalId hit", async () => {
    const user = createUser({ name: "Slack User One", email: "one@example.com" });
    linkIdentity(user.id, "slack", "U_SLACK_ONE", SYSTEM_ACTOR);

    const result = await callTool(server, "resolve-user", {
      kind: "slack",
      externalId: "U_SLACK_ONE",
    });

    const text = textOf(result);
    expect(text).toContain(user.id);
    expect(text).toContain("Slack User One");
  });

  test("matches by email → findUserByEmail hit (primary + alias)", async () => {
    const user = createUser({
      name: "Email User",
      email: "primary@example.com",
      emailAliases: ["alias@example.com"],
    });

    const byPrimary = await callTool(server, "resolve-user", { email: "primary@example.com" });
    expect(textOf(byPrimary)).toContain(user.id);

    const byAlias = await callTool(server, "resolve-user", { email: "alias@example.com" });
    expect(textOf(byAlias)).toContain(user.id);
  });

  test("returns a structured {status: 'unknown', ...} payload when nothing matches — never prose", async () => {
    const result = await callTool(server, "resolve-user", {
      kind: "slack",
      externalId: "U_DOES_NOT_EXIST",
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({
      status: "unknown",
      kind: "slack",
      externalId: "U_DOES_NOT_EXIST",
    });
  });

  // Schema-level validation tests. The MCP SDK runs Zod at the transport
  // layer; calling the registered handler directly bypasses it. We test the
  // schema directly to confirm the contract MCP clients see at the wire.

  test("old shape {slackUserId: ...} fails Zod validation (unrecognized keys via .strict)", () => {
    const parsed = resolveUserInputSchema.safeParse({ slackUserId: "U_X" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = JSON.stringify(parsed.error.issues);
      expect(msg.toLowerCase()).toMatch(/unrecognized|extra|invalid/);
    }
  });

  test("empty input {} fails the refine constraint", () => {
    const parsed = resolveUserInputSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = JSON.stringify(parsed.error.issues);
      expect(msg).toMatch(/Provide either \(kind \+ externalId\), email, userId, or name/);
    }
  });

  test("valid {name} input passes the schema", () => {
    const parsed = resolveUserInputSchema.safeParse({ name: "Whoever" });
    expect(parsed.success).toBe(true);
  });

  test("name shorter than 2 chars fails the min-length constraint", () => {
    const parsed = resolveUserInputSchema.safeParse({ name: "A" });
    expect(parsed.success).toBe(false);
  });

  test("partial input (kind only, no externalId) fails the refine constraint", () => {
    const parsed = resolveUserInputSchema.safeParse({ kind: "slack" });
    expect(parsed.success).toBe(false);
  });

  test("valid {kind, externalId} input passes the schema", () => {
    const parsed = resolveUserInputSchema.safeParse({
      kind: "slack",
      externalId: "U_X",
    });
    expect(parsed.success).toBe(true);
  });

  test("valid {email} input passes the schema", () => {
    const parsed = resolveUserInputSchema.safeParse({ email: "x@example.com" });
    expect(parsed.success).toBe(true);
  });

  test("valid {userId} input passes the schema", () => {
    const parsed = resolveUserInputSchema.safeParse({ userId: "some-user-id" });
    expect(parsed.success).toBe(true);
  });

  test("response includes externalIds populated from user_external_ids rows", async () => {
    const user = createUser({ name: "External ID User", email: "extid@example.com" });
    linkIdentity(user.id, "github", "extid-gh-handle", SYSTEM_ACTOR);
    linkIdentity(user.id, "slack", "U_EXTID", SYSTEM_ACTOR);

    const result = await callTool(server, "resolve-user", {
      kind: "github",
      externalId: "extid-gh-handle",
    });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.id).toBe(user.id);
    expect(Array.isArray(parsed.externalIds)).toBe(true);
    const kinds = parsed.externalIds.map((e: { kind: string }) => e.kind).sort();
    expect(kinds).toEqual(["github", "slack"]);
  });

  test("externalIds is empty array when user has no identities", async () => {
    const user = createUser({ name: "No Identities User", email: "noid@example.com" });

    const result = await callTool(server, "resolve-user", { email: "noid@example.com" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.id).toBe(user.id);
    expect(parsed.externalIds).toEqual([]);
  });

  test("userId lookup returns user profile with externalIds", async () => {
    const user = createUser({ name: "User ID Lookup", email: "uidlookup@example.com" });
    linkIdentity(user.id, "linear", "L_UIDLOOKUP", SYSTEM_ACTOR);

    const result = await callTool(server, "resolve-user", { userId: user.id });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.id).toBe(user.id);
    expect(parsed.name).toBe("User ID Lookup");
    expect(parsed.externalIds).toHaveLength(1);
    expect(parsed.externalIds[0]).toMatchObject({ kind: "linear", externalId: "L_UIDLOOKUP" });
  });

  test("userId lookup returns a structured {status: 'unknown', ...} payload for an unknown ID", async () => {
    const result = await callTool(server, "resolve-user", { userId: "nonexistent-user-id-xyz" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({
      status: "unknown",
      kind: "userId",
      externalId: "nonexistent-user-id-xyz",
    });
  });

  test("name lookup: single exact match resolves to the user profile", async () => {
    const user = createUser({ name: "Zbigniew Solo", email: "zbigniew@example.com" });

    const result = await callTool(server, "resolve-user", { name: "Zbigniew Solo" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.id).toBe(user.id);
    expect(parsed.name).toBe("Zbigniew Solo");
  });

  test("name lookup: single first-token prefix match resolves to the user profile", async () => {
    const user = createUser({ name: "Priyanka Unique Prefix", email: "priyanka@example.com" });

    const result = await callTool(server, "resolve-user", { name: "Priyanka" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.id).toBe(user.id);
  });

  test("name lookup: multiple matches return {status: 'ambiguous', candidates: [...]} — never a guess", async () => {
    const a = createUser({ name: "Alberto Maurel", email: "alberto.maurel@example.com" });
    const b = createUser({ name: "Alberto Dubois", email: "alberto.dubois@example.com" });

    const result = await callTool(server, "resolve-user", { name: "Alberto" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed.status).toBe("ambiguous");
    expect(parsed.message).toMatch(/AMBIGUOUS/);
    const candidateIds = parsed.candidates.map((c: { userId: string }) => c.userId).sort();
    expect(candidateIds).toEqual([a.id, b.id].sort());
  });

  test("name lookup: zero matches return a structured {status: 'unknown', kind: 'name', ...} payload", async () => {
    const result = await callTool(server, "resolve-user", { name: "Nobody Registered Xyz" });
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({
      status: "unknown",
      kind: "name",
      externalId: "Nobody Registered Xyz",
    });
  });
});

describe("manage-user MCP tool (identities array)", () => {
  const server = new McpServer({ name: "test-manage-user", version: "1.0.0" });
  registerManageUserTool(server);

  test("create with identities[] → user created + linkIdentity per entry + identity_added events", async () => {
    const result = await callTool(server, "manage-user", {
      action: "create",
      name: "Identities Create",
      email: "ic@example.com",
      identities: [
        { kind: "slack", externalId: "U_IC" },
        { kind: "linear", externalId: "L_IC" },
      ],
    });

    const text = textOf(result);
    expect(text).toContain("User created:");
    const match = text.match(/"id":\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const userId = match![1];

    // Verify identities are linked.
    const idents = getUserIdentities(userId);
    expect(idents).toHaveLength(2);
    const kinds = idents.map((i) => `${i.kind}:${i.externalId}`).sort();
    expect(kinds).toEqual(["linear:L_IC", "slack:U_IC"]);

    // Two `identity_added` events were emitted via linkIdentity().
    const events = eventsFor(userId);
    const added = events.filter((e) => e.eventType === "identity_added");
    expect(added).toHaveLength(2);
  });

  test("update with identities diff → add one + remove one emits correct events", async () => {
    const created = await callTool(server, "manage-user", {
      action: "create",
      name: "Identities Diff",
      identities: [{ kind: "slack", externalId: "U_DIFF" }],
    });
    const userId = textOf(created).match(/"id":\s*"([^"]+)"/)![1];
    const baselineEventCount = eventsFor(userId).length;

    // Now update: keep slack, drop nothing yet — desired set has slack + add github.
    await callTool(server, "manage-user", {
      action: "update",
      userId,
      identities: [
        { kind: "slack", externalId: "U_DIFF" },
        { kind: "github", externalId: "gh_diff" },
      ],
    });
    let idents = getUserIdentities(userId);
    expect(idents.map((i) => `${i.kind}:${i.externalId}`).sort()).toEqual([
      "github:gh_diff",
      "slack:U_DIFF",
    ]);

    // Next update: drop slack, keep github. Diff = remove slack.
    await callTool(server, "manage-user", {
      action: "update",
      userId,
      identities: [{ kind: "github", externalId: "gh_diff" }],
    });
    idents = getUserIdentities(userId);
    expect(idents.map((i) => `${i.kind}:${i.externalId}`)).toEqual(["github:gh_diff"]);

    const events = eventsFor(userId).slice(baselineEventCount);
    const added = events.filter((e) => e.eventType === "identity_added");
    const removed = events.filter((e) => e.eventType === "identity_removed");
    // First update: added github. Second update: removed slack.
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(added[0]!.afterJson).toContain("github");
    expect(removed[0]!.afterJson).toBeNull();
  });

  test("update with emailAliases diff emits email_added / email_removed", async () => {
    const created = await callTool(server, "manage-user", {
      action: "create",
      name: "Alias Diff",
      email: "ad@example.com",
      emailAliases: ["a@example.com"],
    });
    const userId = textOf(created).match(/"id":\s*"([^"]+)"/)![1];
    const baselineEventCount = eventsFor(userId).length;

    // Update aliases: remove a@, add b@.
    await callTool(server, "manage-user", {
      action: "update",
      userId,
      emailAliases: ["b@example.com"],
    });

    const events = eventsFor(userId).slice(baselineEventCount);
    const added = events.filter((e) => e.eventType === "email_added");
    const removed = events.filter((e) => e.eventType === "email_removed");
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(added[0]!.afterJson).toContain("b@example.com");
  });

  test("non-lead caller is rejected", async () => {
    const result = await callTool(server, "manage-user", { action: "list" }, WORKER_ID);
    expect(textOf(result)).toContain("Only the lead agent");
  });

  test("create no longer accepts old top-level slackUserId / linearUserId / githubUsername / gitlabUsername", async () => {
    // The schema is `z.object({...})` without `.strict()` on manage-user
    // (preserving forward-compat headroom for future fields). But the dropped
    // identity fields are explicitly not in the schema — they are silently
    // ignored, NOT routed to the dropped DB columns. Verify behaviour:
    // passing them as extra keys does not affect the created user.
    const result = await callTool(server, "manage-user", {
      action: "create",
      name: "Legacy Shape User",
      slackUserId: "U_LEGACY",
      linearUserId: "L_LEGACY",
      githubUsername: "gh_legacy",
      gitlabUsername: "gl_legacy",
    });
    const text = textOf(result);
    expect(text).toContain("User created:");
    const userId = text.match(/"id":\s*"([^"]+)"/)![1];

    // None of the legacy fields should have been turned into linked identities
    // — the new shape REQUIRES `identities` array to link.
    const idents = getUserIdentities(userId);
    expect(idents).toHaveLength(0);
  });
});
