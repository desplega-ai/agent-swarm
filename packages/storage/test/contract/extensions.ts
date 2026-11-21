import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionsRepository, NewExtension, Storage } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";

function newExtension(overrides: Partial<NewExtension> = {}): NewExtension {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    name: `ext-${id.slice(0, 8)}`,
    description: "d",
    runtime: "api",
    manifestJson: '{"name":"x"}',
    contentHash: "h1",
    priority: 100,
    configJson: "{}",
    createdByAgentId: "agent-a",
    actor: "user-1",
    now: T0,
    ...overrides,
  };
}

export function extensionsContract(engine: ContractEngine): void {
  describe(`extensions repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ExtensionsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.extensions;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insert returns the row in the stored value shape", async () => {
      const row = await repo.insert(newExtension({ id: "e1", name: "alpha" }));
      expect(row).toMatchObject({
        id: "e1",
        name: "alpha",
        version: 1,
        activeVersion: 1,
        enabled: 0,
        status: "disabled",
        consecutiveFailures: 0,
        lastError: null,
        agentId: null,
        createdByAgentId: "agent-a",
        created_by: "user-1",
        updated_by: "user-1",
        createdAt: T0,
        updatedAt: T0,
      });
      expect(await repo.findByName("alpha")).toEqual(row);
      expect(await repo.findById("e1")).toEqual(row);
      expect(await repo.findById("missing")).toBeNull();
    });

    test("list orders by priority, then name in byte order", async () => {
      await repo.insert(newExtension({ name: "b", priority: 5 }));
      await repo.insert(newExtension({ name: "a", priority: 5 }));
      await repo.insert(newExtension({ name: "Z", priority: 5 }));
      await repo.insert(newExtension({ name: "c", priority: 1 }));
      expect((await repo.list()).map((row) => row.name)).toEqual(["c", "Z", "a", "b"]);
    });

    test("updateColumns sets flags and owner drafts only", async () => {
      await repo.insert(newExtension({ id: "e1" }));
      const enabled = await repo.updateColumns(
        "e1",
        { enabled: true, status: "enabled" },
        { actor: "u2", now: "2026-11-21T11:00:00.000Z" },
      );
      expect(enabled).toMatchObject({ enabled: 1, status: "enabled", updated_by: "u2" });
      // An enabled extension is no longer the owner's draft.
      expect(
        await repo.updateColumns("e1", { priority: 1 }, { actor: "u3", now: T0 }, "agent-a"),
      ).toBeNull();
      await repo.updateColumns("e1", { enabled: false }, { actor: "u2", now: T0 });
      expect(
        await repo.updateColumns("e1", { priority: 1 }, { actor: "u3", now: T0 }, "agent-b"),
      ).toBeNull();
      expect(
        await repo.updateColumns("e1", { priority: 1 }, { actor: "u3", now: T0 }, "agent-a"),
      ).toMatchObject({ priority: 1, enabled: 0 });
    });

    test("recordFailure disables at the threshold", async () => {
      await repo.insert(newExtension({ id: "e1" }));
      await repo.updateColumns(
        "e1",
        { enabled: true, status: "enabled" },
        { actor: null, now: T0 },
      );
      const first = await repo.recordFailure("e1", "boom", 2, T0);
      expect(first).toMatchObject({ consecutiveFailures: 1, enabled: 1, status: "enabled" });
      const second = await repo.recordFailure("e1", "boom2", 2, T0);
      expect(second).toMatchObject({
        consecutiveFailures: 2,
        enabled: 0,
        status: "auto-disabled",
        lastError: "boom2",
      });
    });

    test("delete honours the owner draft rule", async () => {
      await repo.insert(newExtension({ id: "e1" }));
      expect(await repo.delete("e1", "agent-b")).toBe(0);
      expect(await repo.delete("e1", "agent-a")).toBe(1);
      expect(await repo.findById("e1")).toBeNull();
    });

    test("files, versions and assets round trip in a stated order", async () => {
      await repo.insert(newExtension({ id: "e1" }));
      for (const path of ["b.ts", "a.ts", "B.ts"]) {
        await repo.insertFile({
          id: crypto.randomUUID(),
          extensionId: "e1",
          path,
          content: `// ${path}`,
          contentHash: path,
          actor: null,
        });
      }
      expect((await repo.listFiles("e1")).map((file) => file.path)).toEqual([
        "B.ts",
        "a.ts",
        "b.ts",
      ]);
      await repo.deleteFiles("e1");
      expect(await repo.listFiles("e1")).toEqual([]);

      for (const version of [1, 3, 2]) {
        await repo.insertVersion({
          id: crypto.randomUUID(),
          extensionId: "e1",
          version,
          manifestJson: "{}",
          filesJson: "{}",
          contentHash: `h${version}`,
          changedByAgentId: null,
          changedAt: T0,
          changeReason: null,
          actor: null,
        });
      }
      expect((await repo.listVersions("e1")).map((row) => row.version)).toEqual([3, 2, 1]);
      expect(await repo.getVersion("e1", 2)).toMatchObject({ contentHash: "h2" });

      const asset = {
        extensionId: "e1",
        kind: "script",
        name: "s1",
        assetId: "a1",
        seededHash: "x",
        enabledBefore: null,
        actor: null,
        now: T0,
      };
      await repo.upsertAsset({ ...asset, id: "as1" });
      await repo.upsertAsset({ ...asset, id: "as2", assetId: "a2", enabledBefore: 1 });
      await repo.upsertAsset({ ...asset, id: "as3", kind: "skill", name: "k" });
      const assets = await repo.listAssets("e1");
      expect(assets.map((row) => [row.id, row.kind, row.assetId, row.enabledBefore])).toEqual([
        ["as1", "script", "a2", 1],
        ["as3", "skill", "a1", null],
      ]);
      await repo.setAssetEnabledBefore("as1", null, "u", T0);
      await repo.deleteAsset("as3");
      expect((await repo.listAssets("e1")).map((row) => row.enabledBefore)).toEqual([null]);
    });

    test("runs: newest first, ties in reverse insertion order, prune keeps the newest", async () => {
      await repo.insert(newExtension({ id: "e1" }));
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = `r${i}`;
        ids.push(id);
        await repo.insertRun({
          id,
          extensionId: "e1",
          version: 1,
          event: "pre",
          action: "continue",
          durationMs: i,
          message: null,
          agentId: null,
          subject: null,
          // r1..r3 share one timestamp: the tie order must be reverse insertion.
          createdAt:
            i === 0 ? T0 : i === 4 ? "2026-11-21T12:00:00.000Z" : "2026-11-21T11:00:00.000Z",
        });
      }
      expect((await repo.listRuns("e1", 10)).map((row) => row.id)).toEqual([
        "r4",
        "r3",
        "r2",
        "r1",
        "r0",
      ]);
      expect((await repo.listRuns("e1", 2)).map((row) => row.id)).toEqual(["r4", "r3"]);
      await repo.pruneRuns("e1", 3);
      expect((await repo.listRuns("e1", 10)).map((row) => row.id)).toEqual(["r4", "r3", "r2"]);
    });

    test("statements inside a rolled-back transaction leave no row", async () => {
      await expect(
        storage.transaction(async () => {
          await repo.insert(newExtension({ id: "e1" }));
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await repo.findById("e1")).toBeNull();
    });
  });
}
