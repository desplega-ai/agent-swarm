import { describe, expect, test } from "bun:test";
import type { ContractEngine } from "./env";

export function scriptRunnersContract(engine: ContractEngine): void {
  describe(`script runners repository [${engine.name}]`, () => {
    test("stores hashes separately, enforces expiry and revocation, and preserves metadata", async () => {
      const storage = await engine.fresh();
      try {
        const repo = storage.repos.scriptRunners;
        const now = "2026-11-25T00:00:00.000Z";
        const expiresAt = "2026-11-26T00:00:00.000Z";
        const row = {
          id: "runner1",
          name: "runner",
          expiresAt,
          revokedAt: null,
          createdAt: now,
          updatedAt: now,
          createdBy: null,
          updatedBy: null,
        };
        await repo.insert(row, "hash1");
        expect(await repo.list()).toEqual([row]);
        expect(await repo.findActiveByHash("hash1", now)).toEqual(row);
        expect(await repo.findActiveByHash("wrong", now)).toBeNull();
        expect(await repo.findActiveByHash("hash1", expiresAt)).toBeNull();
        expect(await repo.revoke("missing", now, null)).toBe(false);
        expect(await repo.revoke(row.id, now, null)).toBe(true);
        expect(await repo.findActiveByHash("hash1", now)).toBeNull();
        expect((await repo.list())[0].revokedAt).toBe(now);
        expect(storage.capabilities.scriptRunners).toBe(engine.name === "postgres");
      } finally {
        await engine.release(storage);
      }
    });
  });
}
