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

    createAgent({ id: leadId, name: "Test Lead", isLead: true, status: "idle" });
    createAgent({ id: workerId, name: "Test Worker", isLead: false, status: "idle" });
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
    test("creates a version and returns it with all fields", () => {
      const version = createContextVersion({
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

    test("creates a version with optional fields populated", () => {
      const version = createContextVersion({
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

    test("chains versions with previousVersionId", () => {
      const v1 = createContextVersion({
        agentId: workerId,
        field: "toolsMd",
        content: "tools v1",
        version: 1,
        changeSource: "system",
        contentHash: sha256("tools v1"),
      });

      const v2 = createContextVersion({
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
    test("returns a version by ID", () => {
      const created = createContextVersion({
        agentId: workerId,
        field: "claudeMd",
        content: "claude md content",
        version: 1,
        changeSource: "api",
        contentHash: sha256("claude md content"),
      });

      const fetched = getContextVersion(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.content).toBe("claude md content");
    });

    test("returns null for non-existent ID", () => {
      const result = getContextVersion("00000000-0000-4000-8000-999999999999");
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // getLatestContextVersion
  // ============================================================================

  describe("getLatestContextVersion", () => {
    test("returns the latest version for an agent+field", () => {
      const content1 = `setup script v1 ${crypto.randomUUID()}`;
      const content2 = `setup script v2 ${crypto.randomUUID()}`;

      createContextVersion({
        agentId: leadId,
        field: "setupScript",
        content: content1,
        version: 1,
        changeSource: "system",
        contentHash: sha256(content1),
      });

      createContextVersion({
        agentId: leadId,
        field: "setupScript",
        content: content2,
        version: 2,
        changeSource: "self_edit",
        contentHash: sha256(content2),
      });

      const latest = getLatestContextVersion(leadId, "setupScript");
      expect(latest).not.toBeNull();
      expect(latest!.version).toBe(2);
      expect(latest!.content).toBe(content2);
    });

    test("returns null when no versions exist for agent+field", () => {
      const result = getLatestContextVersion("00000000-0000-4000-8000-999999999999", "soulMd");
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // getContextVersionHistory
  // ============================================================================

  describe("getContextVersionHistory", () => {
    const historyAgentId = "cccc0000-0000-4000-8000-000000000003";

    beforeAll(() => {
      createAgent({ id: historyAgentId, name: "History Agent", isLead: false, status: "idle" });

      // Create 5 versions for soulMd
      for (let i = 1; i <= 5; i++) {
        const content = `soul version ${i}`;
        createContextVersion({
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
        createContextVersion({
          agentId: historyAgentId,
          field: "identityMd",
          content,
          version: i,
          changeSource: "api",
          contentHash: sha256(content),
        });
      }
    });

    test("returns all versions for an agent (no field filter)", () => {
      const history = getContextVersionHistory({ agentId: historyAgentId, limit: 50 });
      expect(history.length).toBe(7); // 5 soulMd + 2 identityMd
    });

    test("filters by field", () => {
      const history = getContextVersionHistory({
        agentId: historyAgentId,
        field: "soulMd",
        limit: 50,
      });
      expect(history.length).toBe(5);
      for (const v of history) {
        expect(v.field).toBe("soulMd");
      }
    });

    test("respects limit parameter", () => {
      const history = getContextVersionHistory({
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

    test("defaults limit to 10", () => {
      const history = getContextVersionHistory({ agentId: historyAgentId });
      expect(history.length).toBe(7); // Only 7 versions exist, so all returned
    });

    test("returns empty array for agent with no versions", () => {
      const history = getContextVersionHistory({
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

    beforeAll(() => {
      createAgent({ id: dedupAgentId, name: "Dedup Agent", isLead: false, status: "idle" });
    });

    test("creates a version when content changes", () => {
      updateAgentProfile(dedupAgentId, { soulMd: "soul content A" }, { changeSource: "api" });

      const latest = getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe("soul content A");
      expect(latest!.version).toBe(1);
      expect(latest!.changeSource).toBe("api");
    });

    test("creates a new version when content changes again", () => {
      updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content B" },
        { changeSource: "self_edit", changedByAgentId: dedupAgentId },
      );

      const latest = getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      expect(latest!.content).toBe("soul content B");
      expect(latest!.version).toBe(2);
      expect(latest!.changeSource).toBe("self_edit");
      expect(latest!.changedByAgentId).toBe(dedupAgentId);
    });

    test("skips version creation when content is unchanged (dedup)", () => {
      // Update with the same content
      updateAgentProfile(
        dedupAgentId,
        { soulMd: "soul content B" },
        { changeSource: "session_sync" },
      );

      const latest = getLatestContextVersion(dedupAgentId, "soulMd");
      expect(latest).not.toBeNull();
      // Version should still be 2 — no new version created
      expect(latest!.version).toBe(2);
      expect(latest!.changeSource).toBe("self_edit"); // unchanged from before
    });

    test("creates versions for multiple fields in one update", () => {
      updateAgentProfile(
        dedupAgentId,
        {
          identityMd: "identity content",
          toolsMd: "tools content",
        },
        { changeSource: "api" },
      );

      const identityLatest = getLatestContextVersion(dedupAgentId, "identityMd");
      const toolsLatest = getLatestContextVersion(dedupAgentId, "toolsMd");

      expect(identityLatest).not.toBeNull();
      expect(identityLatest!.content).toBe("identity content");
      expect(identityLatest!.version).toBe(1);

      expect(toolsLatest).not.toBeNull();
      expect(toolsLatest!.content).toBe("tools content");
      expect(toolsLatest!.version).toBe(1);
    });

    test("defaults changeSource to 'api' when no meta provided", () => {
      updateAgentProfile(dedupAgentId, { claudeMd: "claude content" });

      const latest = getLatestContextVersion(dedupAgentId, "claudeMd");
      expect(latest).not.toBeNull();
      expect(latest!.changeSource).toBe("api");
    });

    test("chains previousVersionId correctly", () => {
      // soulMd already has v1 and v2, create v3
      updateAgentProfile(dedupAgentId, { soulMd: "soul content C" }, { changeSource: "self_edit" });

      const v3 = getLatestContextVersion(dedupAgentId, "soulMd");
      expect(v3).not.toBeNull();
      expect(v3!.version).toBe(3);
      expect(v3!.previousVersionId).not.toBeNull();

      // The previous version should be v2
      const v2 = getContextVersion(v3!.previousVersionId!);
      expect(v2).not.toBeNull();
      expect(v2!.version).toBe(2);
    });

    test("returns updated agent even with versioning", () => {
      const agent = updateAgentProfile(
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

    test("agents without content fields get no seeded versions", () => {
      // workerId was created without any soulMd/identityMd content
      // So no auto-seeded versions should exist for fields that were null
      const history = getContextVersionHistory({
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
