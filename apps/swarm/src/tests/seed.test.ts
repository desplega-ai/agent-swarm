import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  getSeedState,
  runSeeder,
  type Seeder,
  type SeederRunOptions,
  type SeedItem,
} from "../be/seed";

const TEST_DB_PATH = "./test-seed.sqlite";

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
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

/**
 * A fake seeder backed by two in-memory maps so the harness can be exercised
 * without any concrete entity kind. `source` is the version-controlled
 * definition; `upstream` is the live DB. `apply` faithfully writes source into
 * upstream, mirroring a real seeder.
 */
function makeFakeSeeder(
  kind: string,
  source: Map<string, string>,
  upstream: Map<string, string>,
): Seeder<SeedItem> {
  return {
    kind,
    items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
    upstreamHash: (item) => upstream.get(item.key) ?? null,
    apply: (item) => {
      upstream.set(item.key, item.contentHash);
    },
  };
}

describe("seeder harness — versioning rule", () => {
  test("absent upstream -> create, and records seed state", async () => {
    const source = new Map([
      ["a", "h-a1"],
      ["b", "h-b1"],
    ]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("create-test", source, upstream);

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.failed).toEqual([]);
    expect(upstream.get("a")).toBe("h-a1");
    expect(getSeedState("create-test", "a")?.seededHash).toBe("h-a1");
  });

  test("pristine upstream + unchanged source -> no-op", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map([["a", "h-a1"]]);
    const seeder = makeFakeSeeder("noop-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // seed once
    const result = await runSeeder(seeder, { quiet: true }); // re-seed
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUnchanged).toBe(1);
    expect(result.skippedUserModified).toBe(0);
  });

  test("pristine upstream + changed source -> update", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("update-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // creates a@h-a1
    source.set("a", "h-a2"); // source moves; upstream still pristine at h-a1

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.updated).toBe(1);
    expect(result.skippedUnchanged).toBe(0);
    expect(upstream.get("a")).toBe("h-a2");
    expect(getSeedState("update-test", "a")?.seededHash).toBe("h-a2");
  });

  test("user-modified upstream -> preserved, never overwritten", async () => {
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder = makeFakeSeeder("preserve-test", source, upstream);

    await runSeeder(seeder, { quiet: true }); // creates a@h-a1
    upstream.set("a", "h-user-edit"); // a user changes it upstream
    source.set("a", "h-a2"); // and the source also moves on

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    // The user's edit survived — the harness did not clobber it.
    expect(upstream.get("a")).toBe("h-user-edit");
  });

  test("pre-existing entity identical to source with no seed state -> adopted as no-op", async () => {
    const source = new Map([["x", "h-x1"]]);
    const upstream = new Map([["x", "h-x1"]]); // pre-exists, byte-identical, never seeded
    const seeder = makeFakeSeeder("adopt-test", source, upstream);

    expect(getSeedState("adopt-test", "x")).toBeNull();
    const first = await runSeeder(seeder, { quiet: true });
    expect(first.skippedUnchanged).toBe(1);
    // It was adopted: seed state is now recorded so a future change is detectable.
    expect(getSeedState("adopt-test", "x")?.seededHash).toBe("h-x1");

    source.set("x", "h-x2");
    const second = await runSeeder(seeder, { quiet: true });
    expect(second.updated).toBe(1);
    expect(upstream.get("x")).toBe("h-x2");
  });

  test("pre-existing entity differing from source with no seed state -> preserved (conservative)", async () => {
    const source = new Map([["y", "h-src"]]);
    const upstream = new Map([["y", "h-pre-existing"]]); // pre-exists, never seeded
    const seeder = makeFakeSeeder("conservative-test", source, upstream);

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skippedUserModified).toBe(1);
    expect(upstream.get("y")).toBe("h-pre-existing");
  });

  test("runner passes opts through to apply()", async () => {
    const capturedOpts: (SeederRunOptions | undefined)[] = [];
    const source = new Map([["a", "h-a1"]]);
    const upstream = new Map<string, string>();
    const seeder: Seeder<SeedItem> = {
      kind: "opts-passthrough-test",
      items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
      upstreamHash: (item) => upstream.get(item.key) ?? null,
      apply: (item, _action, opts) => {
        capturedOpts.push(opts);
        upstream.set(item.key, item.contentHash);
      },
    };

    await runSeeder(seeder, { quiet: true, scriptEmbeddingMode: "skip" });
    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0]?.scriptEmbeddingMode).toBe("skip");
  });

  test("a throwing apply is captured per-item without aborting the run", async () => {
    const source = new Map([
      ["ok", "h-ok"],
      ["bad", "h-bad"],
    ]);
    const upstream = new Map<string, string>();
    const seeder: Seeder<SeedItem> = {
      kind: "failure-test",
      items: () => [...source.entries()].map(([key, contentHash]) => ({ key, contentHash })),
      upstreamHash: (item) => upstream.get(item.key) ?? null,
      apply: (item) => {
        if (item.key === "bad") throw new Error("boom");
        upstream.set(item.key, item.contentHash);
      },
    };

    const result = await runSeeder(seeder, { quiet: true });
    expect(result.created).toBe(1);
    expect(result.failed).toEqual([{ key: "bad", error: "boom" }]);
    expect(upstream.get("ok")).toBe("h-ok");
    // A failed apply did not record seed state, so a later run retries it.
    expect(getSeedState("failure-test", "bad")).toBeNull();
  });
});
