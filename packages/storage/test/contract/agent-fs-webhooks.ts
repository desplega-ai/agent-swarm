import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentFsWebhooksRepository, Storage } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

export function agentFsWebhooksContract(engine: ContractEngine): void {
  describe(`agent-fs webhooks repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: AgentFsWebhooksRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.agentFsWebhooks;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("insertPendingIfAbsent keeps the first row of a drive", async () => {
      await repo.insertPendingIfAbsent("h1", "org", "drive", T0);
      await repo.insertPendingIfAbsent("h2", "org", "drive", T1);
      const row = await repo.findByDrive("org", "drive");
      expect(row).toMatchObject({
        id: "h1",
        orgId: "org",
        driveId: "drive",
        subscriptionId: null,
        url: null,
        secretCiphertext: null,
        status: "pending",
        lastError: null,
        claimedAt: null,
        attemptedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      expect(await repo.findById("h1")).toEqual(row);
      expect(await repo.findById("h2")).toBeNull();
      expect(await repo.findByDrive("org", "other")).toBeNull();
    });

    test("claim takes a free or lapsed lease, refuses a live one and a recent failure", async () => {
      await repo.insertPendingIfAbsent("h1", "org", "drive", T0);
      expect(await repo.claim("h1", T1, T0, T0)).toBe(true);
      // Live lease (claimedAt T1 is not before the cutoff T0).
      expect(await repo.claim("h1", T1, T0, T0)).toBe(false);
      // Lapsed lease.
      expect(await repo.claim("h1", T2, T2, T0)).toBe(true);

      await repo.markFailed("h1", "boom", T1);
      expect(await repo.findById("h1")).toMatchObject({
        status: "failed",
        lastError: "boom",
        claimedAt: null,
        attemptedAt: T1,
        updatedAt: T1,
      });
      // Failure attempted after the retry cutoff: refused; before it: claimable.
      expect(await repo.claim("h1", T2, T2, T0)).toBe(false);
      expect(await repo.claim("h1", T2, T2, T2)).toBe(true);

      await repo.markActive("h1", {
        subscriptionId: "sub",
        url: "https://x/h1",
        secretCiphertext: "cipher",
        now: T2,
      });
      expect(await repo.findById("h1")).toMatchObject({
        subscriptionId: "sub",
        url: "https://x/h1",
        secretCiphertext: "cipher",
        status: "active",
        lastError: null,
        claimedAt: null,
        attemptedAt: T2,
        updatedAt: T2,
      });
    });
  });
}
