import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { closeDb, getDb, initDb } from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { getScript, insertScript, upsertScriptByName } from "../be/scripts/db";
import { purgeExpiredScratchScripts } from "../be/scripts/retention";
import { runSavedScriptAsAgent } from "../be/scripts/run-saved";

const TEST_DB_PATH = "./test-scripts-retention.sqlite";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const signatureJson = JSON.stringify({ args: null, result: null });
const savedApiKey = process.env.AGENT_SWARM_API_KEY;

async function clearDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(TEST_DB_PATH + suffix).delete();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function addScript(name: string, isScratch: boolean) {
  return insertScript({
    name,
    scope: "agent",
    scopeId: "agent-1",
    source: `export default () => "${name}"`,
    description: name,
    intent: name,
    signatureJson,
    isScratch,
  });
}

describe("scratch script retention", () => {
  beforeAll(async () => {
    process.env.AGENT_SWARM_API_KEY = "scripts-retention-test-key";
    await clearDb();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await clearDb();
    if (savedApiKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
    else process.env.AGENT_SWARM_API_KEY = savedApiKey;
  });

  beforeEach(() => {
    getDb().run("DELETE FROM scripts");
  });

  test("purges only scratch-prefixed rows inactive for more than 14 days", () => {
    const staleScratch = addScript("scratch-stale-a1b2c3d4", true);
    const freshScratch = addScript("scratch-fresh-a1b2c3d4", true);
    const namedWithPrefix = addScript("scratch-named-a1b2c3d4", false);
    const flaggedWithoutPrefix = addScript("temporary-script", true);
    const globalScratch = insertScript({
      name: "scratch-global-a1b2c3d4",
      scope: "global",
      source: "export default () => 'global'",
      description: "global",
      intent: "global",
      signatureJson,
      isScratch: true,
    });

    getDb()
      .prepare("UPDATE scripts SET updatedAt = ? WHERE id IN (?, ?, ?, ?)")
      .run(
        "2026-07-01T00:00:00.000Z",
        staleScratch.id,
        namedWithPrefix.id,
        flaggedWithoutPrefix.id,
        globalScratch.id,
      );
    getDb()
      .prepare("UPDATE scripts SET updatedAt = ? WHERE id = ?")
      .run("2026-08-10T00:00:00.000Z", freshScratch.id);

    expect(purgeExpiredScratchScripts(NOW)).toBe(1);
    expect(getScript({ name: staleScratch.name, scope: "agent", scopeId: "agent-1" })).toBeNull();
    expect(
      getScript({ name: freshScratch.name, scope: "agent", scopeId: "agent-1" }),
    ).not.toBeNull();
    expect(
      getScript({ name: namedWithPrefix.name, scope: "agent", scopeId: "agent-1" }),
    ).not.toBeNull();
    expect(
      getScript({ name: flaggedWithoutPrefix.name, scope: "agent", scopeId: "agent-1" }),
    ).not.toBeNull();
    expect(getScript({ name: globalScratch.name, scope: "global" })).not.toBeNull();
  });

  test("a repeated successful scratch auto-save refreshes last-used time without a version bump", async () => {
    const args = {
      name: "scratch-reused-a1b2c3d4",
      scope: "agent" as const,
      scopeId: "agent-1",
      source: "export default () => 1",
      description: "scratch",
      intent: "scratch",
      signatureJson,
      isScratch: true,
    };
    const created = await upsertScriptByName(args);
    getDb()
      .prepare("UPDATE scripts SET updatedAt = ? WHERE id = ?")
      .run("2026-07-01T00:00:00.000Z", created.script.id);

    const reused = await upsertScriptByName(args);

    expect(reused.contentDeduped).toBe(true);
    expect(reused.script.version).toBe(1);
    expect(reused.script.updatedAt).not.toBe("2026-07-01T00:00:00.000Z");
  });

  test("a successful shared saved-script execution refreshes scratch last-used time", async () => {
    const script = addScript("scratch-app-action-a1b2c3d4", true);
    const old = "2026-07-01T00:00:00.000Z";
    getDb().prepare("UPDATE scripts SET updatedAt = ? WHERE id = ?").run(old, script.id);

    const output = await runSavedScriptAsAgent({ script, input: null, agentId: "agent-1" });

    expect(output.exitCode).toBe(0);
    expect(
      getScript({ name: script.name, scope: "agent", scopeId: "agent-1" })?.updatedAt,
    ).not.toBe(old);
  });

  test("a stale scratch script survives a GC tick that fires while its run is still in flight", async () => {
    const script = addScript("scratch-inflight-a1b2c3d4", true);
    const old = "2026-07-01T00:00:00.000Z";
    getDb().prepare("UPDATE scripts SET updatedAt = ? WHERE id = ?").run(old, script.id);

    // Don't await yet: runSavedScriptAsAgent touches last-used synchronously
    // before its first `await`, so by the time this line returns the row is
    // already fresh — mirroring a run that's still executing when the daily
    // GC tick fires.
    const runPromise = runSavedScriptAsAgent({ script, input: null, agentId: "agent-1" });

    expect(purgeExpiredScratchScripts(NOW)).toBe(0);
    expect(getScript({ name: script.name, scope: "agent", scopeId: "agent-1" })).not.toBeNull();

    const output = await runPromise;
    expect(output.exitCode).toBe(0);
  });

  test("migration grants existing agent scratch rows a fresh retention window only", () => {
    const agentScratch = addScript("scratch-existing-a1b2c3d4", true);
    const namedWithPrefix = addScript("scratch-existing-named-a1b2c3d4", false);
    const globalScratch = insertScript({
      name: "scratch-existing-global-a1b2c3d4",
      scope: "global",
      source: "export default () => 'global'",
      description: "global",
      intent: "global",
      signatureJson,
      isScratch: true,
    });
    const old = "2026-07-01T00:00:00.000Z";
    getDb()
      .prepare("UPDATE scripts SET updatedAt = ? WHERE id IN (?, ?, ?)")
      .run(old, agentScratch.id, namedWithPrefix.id, globalScratch.id);
    getDb().run("DELETE FROM _migrations WHERE version = 130");

    runMigrations(getDb());

    expect(
      getScript({ name: agentScratch.name, scope: "agent", scopeId: "agent-1" })?.updatedAt,
    ).not.toBe(old);
    expect(
      getScript({ name: namedWithPrefix.name, scope: "agent", scopeId: "agent-1" })?.updatedAt,
    ).toBe(old);
    expect(getScript({ name: globalScratch.name, scope: "global" })?.updatedAt).toBe(old);
  });
});
