import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PagesRepository, PrimitiveObjectSave, Storage } from "../../src";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function object(overrides: Partial<PrimitiveObjectSave> = {}): PrimitiveObjectSave {
  return {
    id: "o1",
    kind: "board",
    orgId: "org",
    driveId: "drive",
    path: "a.excalidraw",
    title: "A",
    fileVersion: 1,
    ownerAgentId: "agent-a",
    now: T0,
    ...overrides,
  };
}

export function pagesContract(engine: ContractEngine): void {
  describe(`pages repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: PagesRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.pages;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const app = (id: string, name: string, now: string, description: string | null = null) =>
      repo.insertApp({ id, key: `shared/app:${id}/`, name, description, definition: "{}", now });

    test("apps: insert shape, lists in a total order, LIKE folds ASCII case", async () => {
      expect(await app("b", "Beta", T0, "50%_off")).toEqual({
        id: "b",
        name: "Beta",
        description: "50%_off",
        definition: "{}",
        created_at: T0,
        updated_at: T0,
      });
      await app("a", "alpha", T0);
      await app("c", "Gamma", T1, "BETA tester");
      expect((await repo.listApps({})).map((row) => row.id)).toEqual(["c", "a", "b"]);
      expect((await repo.listApps({ limit: 1 })).map((row) => row.id)).toEqual(["c"]);
      expect((await repo.listAllApps()).map((row) => row.id)).toEqual(["a", "b", "c"]);
      expect((await repo.listApps({ pattern: "%beta%" })).map((row) => row.id)).toEqual(["c", "b"]);
      // Escaped wildcards match literally.
      expect((await repo.listApps({ pattern: "%50\\%\\_%" })).map((row) => row.id)).toEqual(["b"]);
      expect((await repo.listApps({ pattern: "%5_\\%%" })).map((row) => row.id)).toEqual(["b"]);
      expect(
        (await repo.listOtherAppDefinitions("b")).map((row) => `${row.id}:${row.name}`),
      ).toEqual(["c:Gamma", "a:alpha"]);
    });

    test("apps: update, raw reads, favorites and delete", async () => {
      await app("a", "alpha", T0);
      expect(
        await repo.updateApp("a", {
          name: "alpha2",
          description: "d",
          definition: '{"x":1}',
          updatedAt: T1,
        }),
      ).toMatchObject({ name: "alpha2", description: "d", created_at: T0, updated_at: T1 });
      expect(await repo.getStoredApp("a")).toEqual({
        name: "alpha2",
        description: "d",
        definition: '{"x":1}',
      });
      expect(await repo.getAppDefinition("a")).toBe('{"x":1}');
      expect(await repo.getAppDefinition("missing")).toBeNull();
      expect(await repo.appExists("a")).toBe(true);
      expect(await repo.appExists("missing")).toBe(false);

      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES (${"u1"}, ${"u1"})`);
      await storage.executor.run(sql`
        INSERT INTO user_favorites (id, "favoriteScope", "userId", "itemType", "itemId", "createdAt")
        VALUES (${"f1"}, ${"user:u1"}, ${"u1"}, 'app', ${"a"}, ${T0})`);
      await repo.deleteAppFavorites("a");
      const left = await storage.executor.get<{ n: number }>(
        sql`SELECT COUNT(*) AS n FROM user_favorites`,
      );
      expect(Number(left?.n)).toBe(0);
      expect(await repo.deleteApp("a")).toBe(1);
      expect(await repo.deleteApp("a")).toBe(0);
      expect(
        await repo.updateApp("a", {
          name: "x",
          description: null,
          definition: "{}",
          updatedAt: T1,
        }),
      ).toBeNull();
    });

    test("page versions: the highest version, null before the first", async () => {
      expect(await repo.latestPageVersion("p1")).toBeNull();
      await storage.executor.run(sql`
        INSERT INTO pages (id, "agentId", slug, title, "contentType", body)
        VALUES (${"p1"}, ${"agent-a"}, ${"s"}, ${"t"}, 'text/html', ${"b"})`);
      for (const version of [1, 3, 2]) {
        await storage.executor.run(sql`
          INSERT INTO page_versions (id, "pageId", version, snapshot)
          VALUES (${`v${version}`}, ${"p1"}, ${version}, ${"{}"})`);
      }
      expect(await repo.latestPageVersion("p1")).toBe(3);
      expect(await repo.pageExists("p1")).toBe(true);
      expect(await repo.pageExists("missing")).toBe(false);
    });

    test("objects: upsert keeps the title, onlyNewer skips older reads, path swap", async () => {
      await repo.upsertObject(object(), false);
      expect(await repo.findObjectById("o1")).toMatchObject({
        id: "o1",
        title: "A",
        fileVersion: 1,
        deletedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      await repo.upsertObject(object({ title: null, fileVersion: 3, now: T1 }), false);
      expect(await repo.findObjectById("o1")).toMatchObject({ title: "A", fileVersion: 3 });
      // Same path, older version: skipped with onlyNewer, applied without it.
      await repo.upsertObject(object({ fileVersion: 2, now: T2 }), true);
      expect(await repo.findObjectById("o1")).toMatchObject({ fileVersion: 3, updatedAt: T1 });
      await repo.upsertObject(object({ path: "b.excalidraw", fileVersion: 2, now: T2 }), true);
      expect(await repo.findObjectById("o1")).toMatchObject({
        path: "b.excalidraw",
        fileVersion: 2,
      });

      await repo.upsertObject(object({ id: "o2", path: "c.excalidraw" }), false);
      await repo.deleteObjectAtPathExcept("org", "drive", "c.excalidraw", "o2");
      expect(await repo.findObjectById("o2")).not.toBeNull();
      await repo.deleteObjectAtPathExcept("org", "drive", "c.excalidraw", "o1");
      expect(await repo.findObjectById("o2")).toBeNull();
      expect(await repo.findObjectOnDrive("o1", "org", "other")).toBeNull();
      expect((await repo.findObjectByPath("org", "drive", "b.excalidraw"))?.id).toBe("o1");
    });

    test("objects: list order, literal prefix, count, paths and drives", async () => {
      await repo.upsertObject(object({ id: "b", path: "x/%1.excalidraw", now: T1 }), false);
      await repo.upsertObject(object({ id: "a", path: "x/2.excalidraw", now: T1 }), false);
      await repo.upsertObject(object({ id: "c", path: "y/3.sheet.json", kind: "sheet" }), false);
      await repo.upsertObject(object({ id: "d", path: "x/_4.excalidraw", driveId: "d2" }), false);
      await repo.upsertObject(object({ id: "e", path: "x/5.excalidraw", orgId: "o2" }), false);
      const filter = { orgId: "org", driveId: "drive" };
      expect((await repo.listObjects(filter, 10, 0)).map((row) => row.id)).toEqual(["a", "b", "c"]);
      expect((await repo.listObjects(filter, 1, 1)).map((row) => row.id)).toEqual(["b"]);
      expect(
        (await repo.listObjects({ ...filter, prefix: "x/%" }, 10, 0)).map((r) => r.id),
      ).toEqual(["b"]);
      expect(
        (await repo.listObjects({ ...filter, kind: "sheet" }, 10, 0)).map((r) => r.id),
      ).toEqual(["c"]);
      expect(await repo.countObjects(filter)).toBe(3);
      expect(await repo.countObjects({ ...filter, prefix: "x/" })).toBe(2);
      expect(await repo.listObjectPaths("org", "drive", "board")).toEqual([
        "x/%1.excalidraw",
        "x/2.excalidraw",
      ]);
      expect(await repo.listObjectDrives(10)).toEqual([
        { orgId: "o2", driveId: "drive" },
        { orgId: "org", driveId: "d2" },
        { orgId: "org", driveId: "drive" },
      ]);
      expect(await repo.listObjectDrives(1)).toEqual([{ orgId: "o2", driveId: "drive" }]);

      await repo.setObjectFileVersion("a", 7, T2);
      expect(await repo.findObjectById("a")).toMatchObject({ fileVersion: 7, updatedAt: T2 });
      await repo.setObjectEditor("a", null);
      expect((await repo.findObjectById("a"))?.updated_by).toBeNull();
    });

    test("objects: conditional tombstone and revive", async () => {
      await repo.upsertObject(object({ fileVersion: 5 }), false);
      expect(await repo.tombstoneObjectIfOlder("o1", "a.excalidraw", 5, T1)).toBe(0);
      expect(await repo.tombstoneObjectIfOlder("o1", "other", 6, T1)).toBe(0);
      expect(await repo.tombstoneObjectIfOlder("o1", "a.excalidraw", 6, T1)).toBe(1);
      expect(await repo.findObjectById("o1")).toMatchObject({ deletedAt: T1, fileVersion: 6 });
      expect(await repo.countObjects({ orgId: "org", driveId: "drive" })).toBe(0);
      // Tombstones stay in the path list.
      expect(await repo.listObjectPaths("org", "drive", "board")).toEqual(["a.excalidraw"]);

      expect(await repo.reviveObjectIfOlder("o1", "a.excalidraw", 7, false, 9, T2)).toBe(1);
      expect(await repo.findObjectById("o1")).toMatchObject({ deletedAt: null, fileVersion: 6 });
      expect(await repo.reviveObjectIfOlder("o1", "a.excalidraw", 7, true, 9, T2)).toBe(1);
      expect(await repo.findObjectById("o1")).toMatchObject({ fileVersion: 9 });

      expect(await repo.tombstoneObjectAtVersion("o1", "a.excalidraw", 8, T2)).toBe(0);
      expect(await repo.tombstoneObjectAtVersion("o1", "a.excalidraw", 9, T2)).toBe(1);
      expect(await repo.tombstoneObjectAtVersion("o1", "a.excalidraw", 9, T2)).toBe(0);
    });
  });
}
