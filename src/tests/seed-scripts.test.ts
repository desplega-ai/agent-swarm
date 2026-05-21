import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { listScripts } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { typecheckScript } from "../be/scripts/typecheck";
import { SEED_SCRIPTS, seedGlobalScripts } from "../be/seed-scripts";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import { validateScriptImports } from "../scripts-runtime/import-allowlist";

const TEST_DB_PATH = "./test-seed-scripts.sqlite";

// Deterministic offline embedding so the seed never reaches out to OpenAI.
const fakeEmbeddingProvider = {
  name: "test/fake-seed-embedding",
  dimensions: 4,
  async embed(text: string) {
    return new Float32Array([text.length % 7, text.length % 5, text.length % 3, 1]);
  },
  async embedBatch(texts: string[]) {
    return Promise.all(texts.map((t) => this.embed(t)));
  },
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  setScriptEmbeddingProviderForTests(fakeEmbeddingProvider);
});

afterAll(async () => {
  closeDb();
  setScriptEmbeddingProviderForTests(null);
  await removeDbFiles(TEST_DB_PATH);
});

describe("seed-scripts catalog", () => {
  test("manifest holds 10 unique, well-described scripts", () => {
    expect(SEED_SCRIPTS.length).toBe(10);
    const names = SEED_SCRIPTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SEED_SCRIPTS) {
      expect(s.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(s.description.length).toBeGreaterThanOrEqual(40);
      expect(s.intent.length).toBeGreaterThanOrEqual(20);
      expect(s.source).toContain("export default");
      expect(s.source).toContain("argsSchema");
    }
  });

  test("every catalog script passes the import allowlist and the script typecheck", () => {
    const failures: string[] = [];
    for (const s of SEED_SCRIPTS) {
      const imports = validateScriptImports(s.source);
      if (!imports.ok) failures.push(`${s.name}: import — ${imports.diagnostic}`);
      const tc = typecheckScript(s.source);
      if (!tc.ok) failures.push(`${s.name}: typecheck — ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("every catalog script exposes a documented default export", () => {
    for (const s of SEED_SCRIPTS) {
      const sig = extractScriptSignature(s.source);
      expect(sig.description.length, `${s.name} is missing a JSDoc summary`).toBeGreaterThan(0);
    }
  });

  test("seedGlobalScripts seeds the whole catalog at global scope", async () => {
    const result = await seedGlobalScripts({ quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.seeded).toBe(SEED_SCRIPTS.length);

    const globals = listScripts({ scope: "global" });
    for (const s of SEED_SCRIPTS) {
      const row = globals.find((g) => g.name === s.name);
      expect(row, `${s.name} was not seeded`).toBeDefined();
      expect(row?.scope).toBe("global");
      expect(row?.scopeId).toBeNull();
      expect(row?.isScratch).toBe(false);
      expect(row?.typeChecked).toBe(true);
    }
  });

  test("re-seeding is idempotent — unchanged scripts are skipped", async () => {
    const result = await seedGlobalScripts({ quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.seeded).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(SEED_SCRIPTS.length);
  });
});
