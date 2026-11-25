import { describe, expect, test } from "bun:test";
import { sql } from "../../src";
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
        expect(await repo.revoke(row.id, expiresAt, null)).toBe(true);
        const revoked = (await repo.list())[0];
        expect(revoked.revokedAt).toBe(now);
        expect(revoked.updatedAt).toBe(now);
        for (const id of ["issuer", "replacement"]) {
          await storage.executor.run(sql`INSERT INTO users (id, name, status, "createdAt", "lastUpdatedAt")
            VALUES (${id}, ${id}, 'active', ${now}, ${now})`);
        }
        await repo.insert({ ...row, id: "user-runner", createdBy: "issuer" }, "user-hash");
        expect((await repo.findActiveByHash("user-hash", now))?.createdBy).toBe("issuer");
        // User deletion can clear audit attribution or transfer it to another user.
        for (const replacement of ["replacement", null]) {
          await storage.executor.run(sql`UPDATE script_runner_credentials SET created_by = ${replacement}
            WHERE id = 'user-runner'`);
          expect(await repo.findActiveByHash("user-hash", now)).toBeNull();
        }
        // A pre-migration binary omits the issuer column when it inserts a credential.
        await storage.executor.run(sql`INSERT INTO script_runner_credentials
          (id, name, token_hash, expires_at, created_at, updated_at)
          VALUES ('old-writer', 'old writer', 'old-hash', ${expiresAt}, ${now}, ${now})`);
        expect(await repo.findActiveByHash("old-hash", now)).toBeNull();
        expect(storage.capabilities.scriptRunners).toBe(engine.name === "postgres");
      } finally {
        await engine.release(storage);
      }
    });
  });
}
