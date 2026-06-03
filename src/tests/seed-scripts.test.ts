import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { closeDb, initDb } from "../be/db";
import { getScript, listScripts, upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { typecheckScript } from "../be/scripts/typecheck";
import { runSeeder } from "../be/seed";
import { SEED_SCRIPTS, scriptsSeeder } from "../be/seed-scripts";
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
  test("manifest holds 14 unique, well-described scripts", () => {
    expect(SEED_SCRIPTS.length).toBe(14);
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

  test("scriptsSeeder declares the script kind and one item per catalog entry", async () => {
    expect(scriptsSeeder.kind).toBe("script");
    const items = await scriptsSeeder.items();
    expect(items.length).toBe(SEED_SCRIPTS.length);
    for (const item of items) {
      expect(typeof item.key).toBe("string");
      expect(item.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("scriptsSeeder seeds the whole catalog at global scope", async () => {
    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(SEED_SCRIPTS.length);

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

  test("re-seeding is idempotent — pristine, unchanged scripts are skipped", async () => {
    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUnchanged).toBe(SEED_SCRIPTS.length);
    expect(result.skippedUserModified).toBe(0);
  });

  test("a user-modified script is preserved, not overwritten, on re-seed", async () => {
    // Simulate a user editing one seeded script's source upstream.
    const target = SEED_SCRIPTS[0];
    const userSource = `${target.source}\n// edited by a user\n`;
    await upsertScriptByName({
      name: target.name,
      scope: "global",
      scopeId: null,
      source: userSource,
      description: target.description,
      intent: target.intent,
      signatureJson: JSON.stringify(extractScriptSignature(target.source)),
      fsMode: "none",
      agentId: null,
      isScratch: false,
      typeChecked: true,
    });

    const result = await runSeeder(scriptsSeeder, { quiet: true });
    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    expect(result.skippedUnchanged).toBe(SEED_SCRIPTS.length - 1);

    // The user's edit survived — the seed did not clobber it.
    const row = getScript({ name: target.name, scope: "global" });
    expect(row?.source).toBe(userSource);
  });
});

/**
 * Regression guard for the production seeding failure: in the `bun build
 * --compile` binary, `node_modules` is NOT shipped, so `typecheckScript` could
 * not resolve `import { z } from "zod"` (TS2307) and every catalog script
 * failed to seed. The Dockerfile now stages zod's declaration files under
 * `SCRIPT_TYPES_DIR`; these tests prove resolution works from that staged copy
 * alone — they deliberately do NOT rely on the repo's dev `node_modules`.
 */
describe("script typecheck resolves zod in compiled-binary mode", () => {
  const ENV_KEY = "SCRIPT_TYPES_DIR";
  const originalEnv = process.env[ENV_KEY];
  const tmpDirs: string[] = [];

  // Use the OS temp dir, NOT a path inside the repo: TypeScript's module
  // resolution walks UP looking for `node_modules`, so a base dir under the
  // repo would silently resolve zod from the repo's dev `node_modules` and mask
  // the very gap these tests exist to catch.
  async function makeTmpDir(): Promise<string> {
    const dir = join(tmpdir(), `swarm-zod-types-${crypto.randomUUID()}`);
    await mkdir(dir, { recursive: true });
    tmpDirs.push(dir);
    return dir;
  }

  // Mirror the Dockerfile builder step: stage ONLY zod's declaration files and
  // package.json manifests into `<baseDir>/node_modules/zod`. If this slim set
  // is insufficient, the typecheck below fails — exactly as production would.
  async function stageSlimZod(baseDir: string): Promise<void> {
    const src = "./node_modules/zod";
    const dest = join(baseDir, "node_modules", "zod");
    for (const rel of await readdir(src, { recursive: true })) {
      const keep =
        rel.endsWith(".d.ts") || rel.endsWith(".d.cts") || basename(rel) === "package.json";
      if (!keep) continue;
      const target = join(dest, rel);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(src, rel), target);
    }
  }

  afterAll(async () => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  test("every catalog script typechecks against the staged (declaration-only) zod copy", async () => {
    const base = await makeTmpDir();
    await stageSlimZod(base);
    process.env[ENV_KEY] = base;

    const failures: string[] = [];
    for (const s of SEED_SCRIPTS) {
      const tc = typecheckScript(s.source);
      if (!tc.ok) failures.push(`${s.name}: ${tc.diagnostics.join(" | ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("typecheck fails when zod is not staged — the production gap, now guarded", async () => {
    // An empty SCRIPT_TYPES_DIR simulates the compiled binary BEFORE this fix:
    // no node_modules/zod on disk. The dev-node_modules fallback masked this in
    // CI; pinning resolution to SCRIPT_TYPES_DIR makes the gap reproducible.
    const empty = await makeTmpDir();
    process.env[ENV_KEY] = empty;

    const result = typecheckScript(SEED_SCRIPTS[0].source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.join(" ")).toContain("TS2307");
    }
  });
});
