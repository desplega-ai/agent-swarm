import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetEncryptionKeyForTests, resolveEncryptionKey } from "../be/crypto";
import {
  closeDb,
  createScriptRun,
  getDbClient,
  getScriptRunExecutionArgs,
  initDb,
  upsertScriptRunJournalStep,
} from "../be/db";
import { SEALED_REPLAY_COLUMNS } from "../be/sealed-json";

/**
 * A real close/reopen with the key gone: a DB whose only encrypted data is
 * sealed replay state must refuse to boot rather than write a replacement
 * key that can never open it.
 */

const templateGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};

let savedTemplate: Uint8Array | undefined;
let savedKey: string | undefined;
let savedKeyFile: string | undefined;
let dir: string;
let dbPath: string;
let keyFile: string;

beforeEach(() => {
  closeDb();
  savedTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
  savedKey = process.env.SECRETS_ENCRYPTION_KEY;
  savedKeyFile = process.env.SECRETS_ENCRYPTION_KEY_FILE;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.SECRETS_ENCRYPTION_KEY_FILE;
  __resetEncryptionKeyForTests();
  dir = mkdtempSync(join(tmpdir(), "sealed-key-guard-"));
  dbPath = join(dir, "swarm.sqlite");
  keyFile = join(dir, ".encryption-key");
});

afterEach(() => {
  closeDb();
  templateGlobals.__testMigrationTemplate = savedTemplate;
  if (savedKey !== undefined) process.env.SECRETS_ENCRYPTION_KEY = savedKey;
  if (savedKeyFile !== undefined) process.env.SECRETS_ENCRYPTION_KEY_FILE = savedKeyFile;
  __resetEncryptionKeyForTests();
  resolveEncryptionKey(":memory:");
  rmSync(dir, { recursive: true, force: true });
});

/** Close, forget the cached key, and delete the generated key file. */
function restartWithoutKey(): void {
  closeDb();
  __resetEncryptionKeyForTests();
  rmSync(keyFile, { force: true });
}

describe("boot key guard counts sealed replay values as encrypted data", () => {
  test("every sealed column is listed", () => {
    expect(SEALED_REPLAY_COLUMNS).toEqual(
      expect.arrayContaining([
        { table: "script_runs", column: "args" },
        { table: "script_run_journal", column: "result" },
      ]),
    );
  });

  test("control: a DB with no encrypted data boots and generates a key", () => {
    initDb(dbPath);
    expect(existsSync(keyFile)).toBe(true);
    restartWithoutKey();
    initDb(dbPath);
    expect(existsSync(keyFile)).toBe(true);
  });

  test("sealed durable-run args: boot refuses and writes no key", async () => {
    initDb(dbPath);
    expect(existsSync(keyFile)).toBe(true);
    const id = crypto.randomUUID();
    await createScriptRun({
      id,
      agentId: crypto.randomUUID(),
      source: "export default () => 1",
      args: { n: 7 },
    });
    expect(await getScriptRunExecutionArgs(id)).toEqual({ n: 7 });

    restartWithoutKey();
    expect(() => initDb(dbPath)).toThrow(/sealed replay values/);
    expect(existsSync(keyFile)).toBe(false);
  });

  test("sealed journal result: boot refuses and writes no key", async () => {
    initDb(dbPath);
    const runId = crypto.randomUUID();
    await createScriptRun({
      id: runId,
      agentId: crypto.randomUUID(),
      source: "export default () => 1",
      args: null,
    });
    await upsertScriptRunJournalStep({
      runId,
      stepKey: "step-1",
      stepType: "swarm",
      config: {},
      status: "completed",
      result: { ok: true },
    });
    // Leave the journal result as the only sealed value (pre-sealing args shape).
    await getDbClient().run("UPDATE script_runs SET args = 'null' WHERE id = ?", [runId]);

    restartWithoutKey();
    expect(() => initDb(dbPath)).toThrow(/sealed replay values/);
    expect(existsSync(keyFile)).toBe(false);
  });
});
