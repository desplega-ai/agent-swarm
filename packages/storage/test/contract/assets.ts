import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssetsRepository, Storage } from "../../src";
import { ASSET_KEY_TABLES, sql } from "../../src";
import type { ContractEngine } from "./env";

export function assetsContract(engine: ContractEngine): void {
  describe(`assets repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: AssetsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.assets;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("existingUserIds returns only ids of existing users, across chunks and duplicates", async () => {
      const ids = Array.from({ length: 1_200 }, (_, i) => `ct-missing-${i}`);
      await storage.executor.run(
        sql`INSERT INTO users (id, name) VALUES ('ct-u1', 'One'), ('ct-u2', 'Two')`,
      );
      const found = await repo.existingUserIds([...ids, "ct-u2", "ct-u1", "ct-u2"]);
      expect([...found].sort()).toEqual(["ct-u1", "ct-u2"]);
      expect((await repo.existingUserIds([])).size).toBe(0);
    });

    test("audit data lists every keyed table in order, rows in insertion order", async () => {
      const data = await repo.readAssetKeyAuditData();
      expect(data.keyRows.map((entry) => entry.table)).toEqual([...ASSET_KEY_TABLES]);
      for (const entry of data.keyRows) {
        for (const row of entry.rows) expect(Object.keys(row).sort()).toEqual(["id", "key"]);
      }
      expect(Array.isArray(data.attachmentMappings)).toBe(true);
      expect(Array.isArray(data.sourcedMappings)).toBe(true);
    });
  });
}
