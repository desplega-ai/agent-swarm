import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SchedulesRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";

export function schedulesContract(engine: ContractEngine): void {
  describe(`schedules repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SchedulesRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.schedules;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    async function insertSchedule(
      id: string,
      fields: { profile?: string | null; modelGroup?: string | null },
    ): Promise<void> {
      await storage.executor.run(sql`
        INSERT INTO scheduled_tasks
          (id, name, "intervalMs", "taskTemplate", "createdAt", "lastUpdatedAt", profile, "modelGroup")
        VALUES (${id}, ${`s-${id}`}, 60000, 't', ${T0}, ${T0}, ${fields.profile ?? null},
                ${fields.modelGroup ?? null})`);
    }

    test("schedule ids by profile and by model group, ordered by id", async () => {
      for (const name of ["p1", "p2"]) {
        await storage.repos.models.insertProfile({
          id: crypto.randomUUID(),
          name,
          harness: "claude",
          model: "opus",
          effort: null,
          allowCustomModel: false,
          description: null,
          seededFrom: null,
          credentialAllowlist: null,
          fallbacks: "[]",
          actor: null,
          now: T0,
        });
      }
      await storage.repos.models.insertGroup({
        id: "g-id",
        name: "g1",
        description: null,
        seededFrom: null,
        actor: null,
        now: T0,
      });
      await insertSchedule("c", { profile: "p1" });
      await insertSchedule("a", { profile: "p1", modelGroup: "g1" });
      await insertSchedule("b", { profile: "p2", modelGroup: "g1" });
      await insertSchedule("d", {});
      expect(await repo.listIdsByProfile("p1")).toEqual(["a", "c"]);
      expect(await repo.listIdsByProfile("p2")).toEqual(["b"]);
      expect(await repo.listIdsByProfile("none")).toEqual([]);
      expect(await repo.listIdsByModelGroup("g1")).toEqual(["a", "b"]);
      expect(await repo.listIdsByModelGroup("none")).toEqual([]);
    });

    test("enabled preflight rows in insertion order; last error read and write", async () => {
      await storage.executor.run(sql`
        INSERT INTO scheduled_tasks (id, name, "intervalMs", "taskTemplate", "createdAt", "lastUpdatedAt", enabled)
        VALUES ('z', 'zz', 60000, 't', ${T0}, ${T0}, ${true}),
               ('a', 'aa', 60000, 't', ${T0}, ${T0}, ${false}),
               ('m', 'mm', 60000, 't', ${T0}, ${T0}, ${true})`);
      const rows = await repo.listEnabledPreflightRows();
      expect(rows.map((r) => r.id)).toEqual(["z", "m"]);
      expect(rows[0]).toEqual({
        id: "z",
        name: "zz",
        kind: "schedule",
        params: expect.any(String),
        requiredParams: expect.any(String),
        requires: expect.any(String),
      });

      expect(await repo.getLastError("z")).toEqual({ lastErrorAt: null, lastErrorMessage: null });
      expect(await repo.getLastError("missing")).toBeNull();
      await repo.setLastError("z", { at: "2026-11-21T11:00:00.000Z", message: "m1", now: T0 });
      expect(await repo.getLastError("z")).toEqual({
        lastErrorAt: "2026-11-21T11:00:00.000Z",
        lastErrorMessage: "m1",
      });
    });
  });
}
