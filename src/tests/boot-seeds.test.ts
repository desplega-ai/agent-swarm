import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePricingSeeded, ensureRbacSeeded } from "../be/boot-seeds";
import { closeDb, getDbClient, initDb } from "../be/db";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import { BUILTIN_ROLES } from "../be/rbac-roles";
import { createServer } from "../server";

const TEST_DB_PATH = "./test-boot-seeds.sqlite";
const BUILTIN_ROLE_ID = "rbac-role-requester";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

async function countPricingSeedRows(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pricing WHERE effective_from = 0",
  );
  return row?.n ?? 0;
}

async function countBuiltinPermissions(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM role_permissions WHERE roleId = ?",
    [BUILTIN_ROLE_ID],
  );
  return row?.n ?? 0;
}

// Fresh DB handle per test: the guards are keyed on the live handle.
beforeEach(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(() => {
  closeDb();
});

afterAll(async () => {
  await removeDbFiles();
});

describe("ensurePricingSeeded", () => {
  test("seeds once per database handle, and again for a new handle", async () => {
    ensurePricingSeeded();
    const seeded = await countPricingSeedRows();
    expect(seeded).toBeGreaterThan(0);

    // A second call must not touch the table: wipe it and confirm it stays empty.
    await getDbClient().run("DELETE FROM pricing WHERE effective_from = 0");
    ensurePricingSeeded();
    expect(await countPricingSeedRows()).toBe(0);

    // Reopening the same file gives a new handle, which is seeded again.
    closeDb();
    initDb(TEST_DB_PATH);
    ensurePricingSeeded();
    expect(await countPricingSeedRows()).toBe(seeded);
  });
});

describe("ensureRbacSeeded", () => {
  test("syncs once per database handle, and again for a new handle", async () => {
    ensureRbacSeeded();
    const seeded = await countBuiltinPermissions();
    expect(seeded).toBeGreaterThan(0);

    await getDbClient().run("DELETE FROM role_permissions WHERE roleId = ?", [BUILTIN_ROLE_ID]);
    ensureRbacSeeded();
    expect(await countBuiltinPermissions()).toBe(0);

    closeDb();
    initDb(TEST_DB_PATH);
    ensureRbacSeeded();
    expect(await countBuiltinPermissions()).toBe(seeded);
  });

  test("a failed sync does not mark the handle done", async () => {
    // Make the built-in role unrecoverable: its name is taken by another role id.
    const builtin = BUILTIN_ROLES.find((role) => role.id === BUILTIN_ROLE_ID);
    if (!builtin) throw new Error("test fixture: built-in role missing");
    const client = getDbClient();
    await client.run("PRAGMA foreign_keys = OFF");
    await client.run("DELETE FROM roles WHERE id = ?", [BUILTIN_ROLE_ID]);
    await client.run("PRAGMA foreign_keys = ON");
    await client.run(
      "INSERT INTO roles (id, name, description, isBuiltin, grantsAll) VALUES ('rbac-role-collision', ?, 'x', 0, 0)",
      [builtin.name],
    );

    expect(() => ensureRbacSeeded()).toThrow(/already uses that name/);
    // Not cached as done: the next caller retries and sees the same error.
    expect(() => ensureRbacSeeded()).toThrow(/already uses that name/);

    await client.run("DELETE FROM roles WHERE id = 'rbac-role-collision'");
    ensureRbacSeeded();
    expect(await countBuiltinPermissions()).toBeGreaterThan(0);
  });
});

describe("createServer (one call per MCP session)", () => {
  let savedDatabasePath: string | undefined;

  beforeEach(() => {
    savedDatabasePath = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = TEST_DB_PATH;
  });

  afterEach(() => {
    if (savedDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = savedDatabasePath;
  });

  test("seeds pricing and RBAC on the first session only", async () => {
    await createServer();
    expect(await countPricingSeedRows()).toBeGreaterThan(0);
    expect(await countBuiltinPermissions()).toBeGreaterThan(0);

    await getDbClient().run("DELETE FROM pricing WHERE effective_from = 0");
    await getDbClient().run("DELETE FROM role_permissions WHERE roleId = ?", [BUILTIN_ROLE_ID]);

    // A later session re-registers tools but must not re-run the seeds.
    const second = await createServer();
    expect(second).toBeDefined();
    expect(await countPricingSeedRows()).toBe(0);
    expect(await countBuiltinPermissions()).toBe(0);
  });
});

describe("loadModelsDevCache", () => {
  const saved = process.env.MODELSDEV_CACHE_PATH;
  let dir: string | undefined;

  afterEach(async () => {
    if (saved === undefined) delete process.env.MODELSDEV_CACHE_PATH;
    else process.env.MODELSDEV_CACHE_PATH = saved;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("returns the same parsed object while it is alive", () => {
    const first = loadModelsDevCache();
    expect(first).not.toBeNull();
    expect(loadModelsDevCache()).toBe(first);
  });

  test("keys the memo on the resolved path", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "modelsdev-cache-"));
    const alt = path.join(dir, "cache.json");
    await writeFile(alt, JSON.stringify({ anthropic: { id: "anthropic-alt", models: {} } }));

    const bundled = loadModelsDevCache();
    process.env.MODELSDEV_CACHE_PATH = alt;
    const overridden = loadModelsDevCache();

    expect(overridden?.anthropic?.id).toBe("anthropic-alt");
    expect(overridden).not.toBe(bundled);
  });
});
