import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDb, initDb } from "../be/db";
import {
  deleteScript,
  getScript,
  getScriptVersion,
  insertScript,
  listScripts,
  ScriptBaseConflictError,
  upsertScriptByName,
} from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";

const TEST_DB_PATH = "./test-scripts-db.sqlite";

const noOpEmbeddingProvider = {
  name: "test/noop-script-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

const signatureJson = JSON.stringify({
  args: { type: "object", properties: { value: { type: "number" } } },
  result: { type: "object", properties: { doubled: { type: "number" } } },
});

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

function source(multiplier: number) {
  return `export default function run(args: { value: number }) { return { doubled: args.value * ${multiplier} }; }`;
}

describe("scripts DB helpers", () => {
  beforeAll(async () => {
    await clearDb();
    initDb(TEST_DB_PATH);
    setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  });

  afterAll(async () => {
    setScriptEmbeddingProviderForTests(null);
    closeDb();
    await clearDb();
  });

  beforeEach(() => {
    getDb().run("DELETE FROM scripts");
  });

  test("insertScript stores a live row and initial version", () => {
    const script = insertScript({
      name: "double",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "Double a value",
      intent: "Reusable arithmetic transform",
      signatureJson,
      agentId: "agent-1",
      typeChecked: true,
    });

    expect(script.name).toBe("double");
    expect(script.scope).toBe("agent");
    expect(script.scopeId).toBe("agent-1");
    expect(script.version).toBe(1);
    expect(script.isScratch).toBe(false);
    expect(script.typeChecked).toBe(true);
    expect(script.fsMode).toBe("none");

    const version = getScriptVersion({ scriptId: script.id, version: 1 });
    expect(version?.source).toBe(source(2));
    expect(version?.changedByAgentId).toBe("agent-1");
    expect(version?.changeReason).toBe("Initial creation");
  });

  test("upsertScriptByName deduplicates matching content without bumping version", async () => {
    const first = await upsertScriptByName({
      name: "same",
      scope: "global",
      source: source(2),
      description: "First description",
      intent: "First intent",
      signatureJson,
      agentId: "lead-1",
    });

    const second = await upsertScriptByName({
      name: "same",
      scope: "global",
      source: source(2),
      description: "Changed metadata should update without version bump",
      intent: "Changed intent",
      signatureJson,
      agentId: "lead-1",
    });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.contentDeduped).toBe(true);
    expect(second.script.id).toBe(first.script.id);
    expect(second.script.version).toBe(1);
    expect(second.script.description).toBe("Changed metadata should update without version bump");
    expect(
      getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM script_versions WHERE scriptId = ?",
        )
        .get(first.script.id)?.count,
    ).toBe(1);
  });

  test("upsertScriptByName bumps version and writes history on source change", async () => {
    const first = await upsertScriptByName({
      name: "mutating",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "v1",
      intent: "Initial version",
      signatureJson,
      agentId: "agent-1",
    });

    const second = await upsertScriptByName({
      name: "mutating",
      scope: "agent",
      scopeId: "agent-1",
      source: source(3),
      description: "v2",
      intent: "Updated multiplier",
      signatureJson,
      agentId: "agent-2",
      changeReason: "Use triple",
      typeChecked: true,
    });

    expect(second.isNew).toBe(false);
    expect(second.contentDeduped).toBe(false);
    expect(second.script.id).toBe(first.script.id);
    expect(second.script.version).toBe(2);
    expect(second.script.typeChecked).toBe(true);

    const v1 = getScriptVersion({ scriptId: first.script.id, version: 1 });
    const v2 = getScriptVersion({ scriptId: first.script.id, version: 2 });
    expect(v1?.source).toBe(source(2));
    expect(v2?.source).toBe(source(3));
    expect(v2?.changeReason).toBe("Use triple");
    expect(
      getScriptVersion({ scriptId: first.script.id, contentHash: second.script.contentHash })
        ?.version,
    ).toBe(2);
  });

  test("upsertScriptByName updates source when expected base hash matches", async () => {
    const first = await upsertScriptByName({
      name: "guarded-update",
      scope: "global",
      source: source(2),
      description: "v1",
      intent: "CAS success",
      signatureJson,
    });

    const updated = await upsertScriptByName({
      name: "guarded-update",
      scope: "global",
      source: source(3),
      description: "v2",
      intent: "CAS success",
      signatureJson,
      expectedBaseHash: first.script.contentHash,
    });

    expect(updated.script.version).toBe(2);
    expect(updated.script.source).toBe(source(3));
  });

  test("upsertScriptByName rejects a stale base hash without overwriting source", async () => {
    const first = await upsertScriptByName({
      name: "guarded-conflict",
      scope: "global",
      source: source(2),
      description: "v1",
      intent: "CAS conflict",
      signatureJson,
    });
    const current = await upsertScriptByName({
      name: "guarded-conflict",
      scope: "global",
      source: source(3),
      description: "v2",
      intent: "CAS conflict",
      signatureJson,
      expectedBaseHash: first.script.contentHash,
    });

    try {
      await upsertScriptByName({
        name: "guarded-conflict",
        scope: "global",
        source: source(4),
        description: "stale v3",
        intent: "CAS conflict",
        signatureJson,
        expectedBaseHash: first.script.contentHash,
      });
      throw new Error("expected stale upsert to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ScriptBaseConflictError);
      expect(error).toMatchObject({
        code: "script_base_conflict",
        expectedBaseHash: first.script.contentHash,
        currentHash: current.script.contentHash,
      });
    }

    expect(getScript({ name: "guarded-conflict", scope: "global" })).toMatchObject({
      source: source(3),
      description: "v2",
      version: 2,
      contentHash: current.script.contentHash,
    });
  });

  test("upsertScriptByName lets only one writer advance the same base hash", async () => {
    const base = await upsertScriptByName({
      name: "competing-writers",
      scope: "global",
      source: source(2),
      description: "base",
      intent: "CAS race",
      signatureJson,
    });

    const writes = await Promise.allSettled([
      upsertScriptByName({
        name: "competing-writers",
        scope: "global",
        source: source(3),
        description: "writer one",
        intent: "CAS race",
        signatureJson,
        expectedBaseHash: base.script.contentHash,
      }),
      upsertScriptByName({
        name: "competing-writers",
        scope: "global",
        source: source(4),
        description: "writer two",
        intent: "CAS race",
        signatureJson,
        expectedBaseHash: base.script.contentHash,
      }),
    ]);

    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        code: "script_base_conflict",
      },
    });
    expect(getScript({ name: "competing-writers", scope: "global" })).toMatchObject({
      version: 2,
    });
  });

  test("upsertScriptByName applies the base guard before metadata dedupe", async () => {
    const first = await upsertScriptByName({
      name: "guarded-metadata",
      scope: "global",
      source: source(2),
      description: "current metadata",
      intent: "CAS metadata",
      signatureJson,
    });

    await expect(
      upsertScriptByName({
        name: "guarded-metadata",
        scope: "global",
        source: source(2),
        description: "stale metadata",
        intent: "CAS metadata",
        signatureJson,
        expectedBaseHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "script_base_conflict",
      currentHash: first.script.contentHash,
    });

    expect(getScript({ name: "guarded-metadata", scope: "global" })).toMatchObject({
      description: "current metadata",
      version: 1,
      contentHash: first.script.contentHash,
    });
  });

  test("upsertScriptByName preserves last-write-wins behavior when base hash is omitted", async () => {
    const first = await upsertScriptByName({
      name: "unguarded-update",
      scope: "global",
      source: source(2),
      description: "v1",
      intent: "Legacy behavior",
      signatureJson,
    });
    const intervening = await upsertScriptByName({
      name: "unguarded-update",
      scope: "global",
      source: source(3),
      description: "v2",
      intent: "Legacy behavior",
      signatureJson,
      expectedBaseHash: first.script.contentHash,
    });

    const legacy = await upsertScriptByName({
      name: "unguarded-update",
      scope: "global",
      source: source(4),
      description: "v3",
      intent: "Legacy behavior",
      signatureJson,
    });

    expect(intervening.script.version).toBe(2);
    expect(legacy.script.version).toBe(3);
    expect(legacy.script.source).toBe(source(4));
  });

  test("scope uniqueness treats global null scopeId as one scope and isolates agent scopes", () => {
    insertScript({
      name: "shared-name",
      scope: "global",
      source: source(2),
      description: "Global",
      intent: "Global script",
      signatureJson,
    });

    expect(() =>
      insertScript({
        name: "shared-name",
        scope: "global",
        source: source(3),
        description: "Duplicate global",
        intent: "Should fail",
        signatureJson,
      }),
    ).toThrow();

    const agentOne = insertScript({
      name: "shared-name",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "Agent one",
      intent: "Agent script",
      signatureJson,
    });
    const agentTwo = insertScript({
      name: "shared-name",
      scope: "agent",
      scopeId: "agent-2",
      source: source(2),
      description: "Agent two",
      intent: "Agent script",
      signatureJson,
    });

    expect(agentOne.id).not.toBe(agentTwo.id);
    expect(() =>
      insertScript({
        name: "missing-scope",
        scope: "agent",
        source: source(2),
        description: "No scopeId",
        intent: "Should fail",
        signatureJson,
      }),
    ).toThrow("scopeId is required");
  });

  test("listScripts filters scratch scripts by default", () => {
    insertScript({
      name: "explicit",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "Explicit",
      intent: "Explicit script",
      signatureJson,
    });
    insertScript({
      name: "scratch",
      scope: "agent",
      scopeId: "agent-1",
      source: source(3),
      description: "Scratch",
      intent: "Scratch script",
      signatureJson,
      isScratch: true,
    });

    expect(
      listScripts({ scope: "agent", scopeId: "agent-1" }).map((script) => script.name),
    ).toEqual(["explicit"]);
    expect(
      listScripts({ scope: "agent", scopeId: "agent-1", includeScratch: true }).map(
        (script) => script.name,
      ),
    ).toEqual(["explicit", "scratch"]);
  });

  test("deleteScript cascades script_versions", async () => {
    const result = await upsertScriptByName({
      name: "delete-me",
      scope: "global",
      source: source(2),
      description: "Delete me",
      intent: "Cascade check",
      signatureJson,
    });
    await upsertScriptByName({
      name: "delete-me",
      scope: "global",
      source: source(4),
      description: "Delete me v2",
      intent: "Cascade check",
      signatureJson,
    });

    expect(deleteScript({ name: "delete-me", scope: "global" })).toBe(true);
    expect(deleteScript({ name: "delete-me", scope: "global" })).toBe(false);
    expect(getScript({ name: "delete-me", scope: "global" })).toBeNull();
    expect(
      getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM script_versions WHERE scriptId = ?",
        )
        .get(result.script.id)?.count,
    ).toBe(0);
  });

  test("full lifecycle: upsert, dedup, version bump, history, delete", async () => {
    const created = await upsertScriptByName({
      name: "lifecycle",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "Lifecycle",
      intent: "Exercise full lifecycle",
      signatureJson,
      agentId: "agent-1",
    });
    const deduped = await upsertScriptByName({
      name: "lifecycle",
      scope: "agent",
      scopeId: "agent-1",
      source: source(2),
      description: "Lifecycle changed",
      intent: "No version bump",
      signatureJson,
      agentId: "agent-1",
    });
    const updated = await upsertScriptByName({
      name: "lifecycle",
      scope: "agent",
      scopeId: "agent-1",
      source: source(5),
      description: "Lifecycle updated",
      intent: "Version bump",
      signatureJson,
      agentId: "agent-1",
    });

    expect(created.isNew).toBe(true);
    expect(deduped.contentDeduped).toBe(true);
    expect(deduped.script.version).toBe(1);
    expect(updated.script.version).toBe(2);
    expect(getScriptVersion({ scriptId: created.script.id, version: 1 })?.source).toBe(source(2));
    expect(getScriptVersion({ scriptId: created.script.id, version: 2 })?.source).toBe(source(5));

    expect(deleteScript({ name: "lifecycle", scope: "agent", scopeId: "agent-1" })).toBe(true);
    expect(getScript({ name: "lifecycle", scope: "agent", scopeId: "agent-1" })).toBeNull();
    expect(
      getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) as count FROM script_versions WHERE scriptId = ?",
        )
        .get(created.script.id)?.count,
    ).toBe(0);
  });
});
