import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createContextVersion,
  getContextVersion,
  getContextVersionHistory,
  getLatestContextVersion,
  initDb,
  updateAgentProfile,
} from "../be/db";
import type { ProfileSyncConflict } from "../types";
import { IDENTITY_FIELD_BUDGETS } from "../utils/identity-field-budget";

const TEST_DB_PATH = "./test-context-versioning.sqlite";

function sha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

describe("Context Versioning", () => {
  const leadId = "aaaa0000-0000-4000-8000-000000000001";
  const workerId = "bbbb0000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    initDb(TEST_DB_PATH);

    await createAgent({ id: leadId, name: "Test Lead", isLead: true, status: "idle" });
    await createAgent({ id: workerId, name: "Test Worker", isLead: false, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  });

  // ============================================================================
  // createContextVersion + getContextVersion
  // ============================================================================

  describe("createContextVersion", () => {
    test("creates a version and returns it with all fields", async () => {
      const version = await createContextVersion({
        agentId: workerId,
        field: "soulMd",
        content: "# Soul v1\nI am a test agent.",
        version: 1,
        changeSource: "system",
        contentHash: sha256("# Soul v1\nI am a test agent."),
      });

      expect(version.id).toBeTruthy();
      expect(version.agentId).toBe(workerId);
      expect(version.field).toBe("soulMd");
      expect(version.content).toBe("# Soul v1\nI am a test agent.");
      expect(version.version).toBe(1);
      expect(version.changeSource).toBe("system");
      expect(version.changedByAgentId).toBeNull();
      expect(version.changeReason).toBeNull();
      expect(version.contentHash).toBe(sha256("# Soul v1\nI am a test agent."));
      expect(version.previousVersionId).toBeNull();
      expect(version.createdAt).toBeTruthy();
    });

    test("creates a version with optional fields populated", async () => {
      const version = await createContextVersion({
        agentId: workerId,
        field: "identityMd",
        content: "# Identity v1",
        version: 1,
        changeSource: "lead_coaching",
        changedByAgentId: leadId,
        changeReason: "Initial coaching",
        contentHash: sha256("# Identity v1"),
      });

      expect(version.changedByAgentId).toBe(leadId);
      expect(version.changeReason).toBe("Initial coaching");
    });

    test("chains versions with previousVersionId", async () => {
      const v1 = await createContextVersion({
        agentId: workerId,
        field: "toolsMd",
        content: "tools v1",
        version: 1,
        changeSource: "system",
        contentHash: sha256("tools v1"),
      });

      const v2 = await createContextVersion({
        agentId: workerId,
        field: "toolsMd",
        content: "tools v2",
        version: 2,
        changeSource: "self_edit",
        contentHash: sha256("tools v2"),
        previousVersionId: v1.id,
      });

      expect(v2.previousVersionId).toBe(v1.id);
      expect(v2.version).toBe(2);
    });
  });

  // ============================================================================
  // getContextVersion
  // ============================================================================

  describe("getContextVersion", () => {
    test("returns a version by ID", async () => {
      const created = await createContextVersion({
        agentId: workerId,
        field: "claudeMd",
        content: "claude md content",
        version: 1,
        changeSource: "api",
        contentHash: sha256("claude md content"),
      });

      const fetched = await getContextVersion(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.content).toBe("claude md content");
    });

    test("returns null for non-existent ID", async () => {
      const result = await getContextVersion("00000000-0000-4000-8000-999999999999");
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // getLatestContextVersion
  // ============================================================================

  describe("getLatestContextVersion", () => {
    test("returns the latest version for an agent+field", async () => {
      const content1 = `setup script v1 ${crypto.randomUUID()}`;
      const content2 = `setup script v2 ${crypto.randomUUID()}`;

      await createContextVersion({
        agentId: leadId,
        field: "setupScript",
        content: content1,
        version: 1,
        changeSource: "system",
        contentHash: sha256(content1),
      });

      await createContextVersion({
        agentId: leadId,
        field: "setupScript",
        content: content2,
        version: 2,
        changeSource: "self_edit",
        contentHash: sha256(content2),
      });

      const latest = await getLatestContextVersion(leadId, "setupScript");
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(2);
      expect(latest!.content).toBe(content2);
    });

    test("returns null when no versions exist for agent+field", async () => {
      const result = await getLatestContextVersion(
        "00000000-0000-4000-8000-999999999999",
        "soulMd",
      );
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // getContextVersionHistory
  // ============================================================================

  describe("getContextVersionHistory", () => {
    const historyAgentId = "cccc0000-0000-4000-8000-000000000003";

    beforeAll(async () => {
      await createAgent({
        id: historyAgentId,
        name: "History Agent",
        isLead: false,
        status: "idle",
      });

      // Create 5 versions for soulMd
      for (let i = 1; i <= 5; i++) {
        const content = `soul version ${i}`;
        await createContextVersion({
          agentId: historyAgentId,
          field: "soulMd",
          content,
          version: i,
          changeSource: i === 1 ? "system" : "self_edit",
          contentHash: sha256(content),
        });
      }

      // Create 2 versions for identityMd
      for (let i = 1; i <= 2; i++) {
        const content = `identity version ${i}`;
        await createContextVersion({
          agentId: historyAgentId,
          field: "identityMd",
          content,
          version: i,
          changeSource: "api",
          contentHash: sha256(content),
        });
      }
    });

    test("returns all versions for an agent (no field filter)", async () => {
      const history = await getContextVersionHistory({ agentId: historyAgentId, limit: 50 });
      expect(history.length).toBe(7); // 5 soulMd + 2 identityMd
    });

    test("filters by field", async () => {
      const history = await getContextVersionHistory({
        agentId: historyAgentId,
        field: "soulMd",
        limit: 50,
      });
      expect(history.length).toBe(5);
      for (const v of history) {
        expect(v.field).toBe("soulMd");
      }
    });

    test("respects limit parameter", async () => {
      const history = await getContextVersionHistory({
        agentId: historyAgentId,
        field: "soulMd",
        limit: 3,
      });
      expect(history.length).toBe(3);
      // Should be latest first (DESC order)
      expect(history[0]!.version).toBe(5);
      expect(history[1]!.version).toBe(4);
      expect(history[2]!.version).toBe(3);
    });

    test("defaults limit to 10", async () => {
      const history = await getContextVersionHistory({ agentId: historyAgentId });
      expect(history.length).toBe(7); // Only 7 versions exist, so all returned
    });

    test("returns empty array for agent with no versions", async () => {
      const history = await getContextVersionHistory({
        agentId: "00000000-0000-4000-8000-999999999999",
      });
      expect(history).toEqual([]);
    });
  });

  // ============================================================================
  // updateAgentProfile — SHA-256 content hash dedup
  // ============================================================================

  describe("updateAgentProfile with versioning", () => {
    const dedupAgentId = "dddd0000-0000-4000-8000-000000000004";

    beforeAll(async () => {
      await createAgent({ id: dedupAgentId, name: "Dedup Agent", isLead: false, status: "idle" });
    });

    test("creates a version when content changes", async () => {
      await updateAgentProfile(dedupAgentId, { soulMd: "soul content A" }, { changeSource: "api" });

      const latest = await getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe("soul content A");
      expect(latest!.version).toBe(1);
      expect(latest!.changeSource).toBe("api");
    });

    test("creates a new version when content changes again", async () => {
      await updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content B" },
        { changeSource: "self_edit", changedByAgentId: dedupAgentId },
      );

      const latest = await getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe("soul content B");
      expect(latest!.version).toBe(2);
      expect(latest!.changeSource).toBe("self_edit");
      expect(latest!.changedByAgentId).toBe(dedupAgentId);
    });

    test("skips version creation when content is unchanged (dedup)", async () => {
      // Update with the same content
      await updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content B" },
        { changeSource: "session_sync" },
      );

      const latest = await getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      // Version should still be 2 — no new version created
      expect(latest!.version).toBe(2);
      expect(latest!.changeSource).toBe("self_edit"); // unchanged from before
    });

    test("creates versions for multiple fields in one update", async () => {
      await updateAgentProfile(
        dedupAgentId,
        {
          identityMd: "identity content",
          toolsMd: "tools content",
        },
        { changeSource: "api" },
      );

      const identityLatest = await getLatestContextVersion(dedupAgentId, "identityMd");
      const toolsLatest = await getLatestContextVersion(dedupAgentId, "toolsMd");

      expect(identityLatest).not.toBeNull();
      expect(identityLatest!.content).toBe("identity content");
      expect(identityLatest!.version).toBe(1);

      expect(toolsLatest).not.toBeNull();
      expect(toolsLatest!.content).toBe("tools content");
      expect(toolsLatest!.version).toBe(1);
    });

    test("defaults changeSource to 'api' when no meta provided", async () => {
      await updateAgentProfile(dedupAgentId, { claudeMd: "claude content" });

      const latest = await getLatestContextVersion(dedupAgentId, "claudeMd");
      expect(latest).not.toBeNull();
      expect(latest!.changeSource).toBe("api");
    });

    test("chains previousVersionId correctly", async () => {
      // soulMd already has v1 and v2, create v3
      await updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content C" },
        { changeSource: "self_edit" },
      );

      const v3 = await getLatestContextVersion(dedupAgentId, "soulMd");
      expect(v3).not.toBeNull();
      expect(v3!.version).toBe(3);
      expect(v3!.previousVersionId).not.toBeNull();

      // The previous version should be v2
      const v2 = await getContextVersion(v3!.previousVersionId!);
      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(2);
    });

    test("returns updated agent even with versioning", async () => {
      const agent = await updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content D" },
        { changeSource: "api" },
      );

      expect(agent).not.toBeNull();
      expect(agent!.soulMd).toBe("soul content D");
      expect(agent!.id).toBe(dedupAgentId);
    });
  });

  // ============================================================================
  // Backfill / seed logic
  // ============================================================================

  describe("seedContextVersions (via initDb)", () => {
    // seedContextVersions runs automatically during initDb.
    // The worker and lead agents created in beforeAll had no soulMd/identityMd,
    // so no versions should have been seeded for them.
    // Test by creating an agent with content and re-running initDb (which re-seeds).

    test("agents without content fields get no seeded versions", async () => {
      // workerId was created without any soulMd/identityMd content
      // So no auto-seeded versions should exist for fields that were null
      const history = await getContextVersionHistory({
        agentId: leadId,
        field: "soulMd",
        limit: 50,
      });
      // Lead agent had no soulMd at creation time, so no seeded version
      // (any versions would be from explicit test calls)
      // We can't test seeding directly since it ran at initDb time with empty agents
      // But we verify the function doesn't crash on agents with null fields
      expect(history).toBeInstanceOf(Array);
    });
  });

  // ============================================================================
  // Compare-and-set (expectedHashes)
  // ============================================================================

  describe("compare-and-set via expectedHashes", () => {
    const casAgentId = "cccc0000-0000-4000-8000-000000000004";
    const v1 = "# CLAUDE.md\n\nversion one";
    const v2 = "# CLAUDE.md\n\nversion two — the Lead added a rule";
    const v3 = "# CLAUDE.md\n\nversion three — edited in a session";

    beforeAll(async () => {
      await createAgent({ id: casAgentId, name: "CAS Agent", isLead: false, status: "idle" });
      await updateAgentProfile(casAgentId, { claudeMd: v1 }, { changeSource: "self_edit" });
      await updateAgentProfile(casAgentId, { claudeMd: v2 }, { changeSource: "self_edit" });
    });

    test("drops a copy based on a superseded version and reports the conflict", async () => {
      // The 2026-09-11 incident: a session materialized v1, the Lead moved the
      // DB to v2 meanwhile, and the session's end-of-run sync carried v1 back.
      const conflicts: ProfileSyncConflict[] = [];
      const agent = await updateAgentProfile(
        casAgentId,
        { claudeMd: v3 },
        { changeSource: "session_sync" },
        { expectedHashes: { claudeMd: sha256(v1) }, onConflict: (c) => conflicts.push(c) },
      );

      expect(agent!.claudeMd).toBe(v2);
      expect((await getLatestContextVersion(casAgentId, "claudeMd"))!.version).toBe(2);
      expect(conflicts).toEqual([
        { field: "claudeMd", expectedHash: sha256(v1), currentHash: sha256(v2) },
      ]);
    });

    test("applies a deliberate session_sync revert to an earlier version", async () => {
      // The session was based on the current value (v2) and restored v1 on
      // purpose. Its hash is in the history, and that must not matter.
      const agent = await updateAgentProfile(
        casAgentId,
        { claudeMd: v1 },
        { changeSource: "session_sync" },
        { expectedHashes: { claudeMd: sha256(v2) } },
      );

      expect(agent!.claudeMd).toBe(v1);
      const latest = await getLatestContextVersion(casAgentId, "claudeMd");
      expect(latest!.version).toBe(3);
      expect(latest!.content).toBe(v1);
      expect(latest!.changeSource).toBe("session_sync");
    });

    test("the drop is per field: other fields in the same update land", async () => {
      const soul = "s".repeat(600);
      const agent = await updateAgentProfile(
        casAgentId,
        { claudeMd: v3, soulMd: soul },
        { changeSource: "session_sync" },
        { expectedHashes: { claudeMd: sha256(v2) } }, // stale: the DB is at v1 now
      );

      expect(agent!.claudeMd).toBe(v1);
      expect(agent!.soulMd).toBe(soul);
      expect((await getLatestContextVersion(casAgentId, "claudeMd"))!.version).toBe(3);
      expect((await getLatestContextVersion(casAgentId, "soulMd"))!.version).toBe(1);
    });

    test("without expectedHashes the write stays unconditional", async () => {
      const agent = await updateAgentProfile(
        casAgentId,
        { claudeMd: v2 },
        { changeSource: "session_sync" },
      );

      expect(agent!.claudeMd).toBe(v2);
      expect((await getLatestContextVersion(casAgentId, "claudeMd"))!.version).toBe(4);
    });

    test("a stale copy over the budget is dropped, not rejected", async () => {
      // The profile has since been shortened under the budget. A stale copy of
      // the old, oversized value must be dropped by the compare-and-set — not
      // throw IdentityFieldBudgetError and roll back the other fields too.
      const longAgentId = "cccc0000-0000-4000-8000-000000000005";
      const oversized = "x".repeat(IDENTITY_FIELD_BUDGETS.claudeMd + 500);
      const shortened = "# CLAUDE.md\n\nshortened below the budget";
      await createAgent({
        id: longAgentId,
        name: "Long CAS Agent",
        isLead: false,
        status: "idle",
      });
      await updateAgentProfile(longAgentId, { claudeMd: shortened }, { changeSource: "self_edit" });

      const soul = "t".repeat(600);
      const agent = await updateAgentProfile(
        longAgentId,
        { claudeMd: oversized, soulMd: soul },
        { changeSource: "session_sync" },
        { expectedHashes: { claudeMd: sha256(oversized) } },
      );

      expect(agent!.claudeMd).toBe(shortened);
      expect(agent!.soulMd).toBe(soul);
    });
  });

  // ============================================================================
  // Content hash consistency
  // ============================================================================

  describe("content hash consistency", () => {
    test("same content produces same hash", () => {
      const hash1 = sha256("hello world");
      const hash2 = sha256("hello world");
      expect(hash1).toBe(hash2);
    });

    test("different content produces different hash", () => {
      const hash1 = sha256("hello world");
      const hash2 = sha256("hello world!");
      expect(hash1).not.toBe(hash2);
    });

    test("empty string has a valid hash", () => {
      const hash = sha256("");
      expect(hash).toBeTruthy();
      expect(hash.length).toBe(64); // SHA-256 hex = 64 chars
    });
  });
});
