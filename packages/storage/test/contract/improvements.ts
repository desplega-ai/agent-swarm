import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ImprovementsRepository, Storage } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

export function improvementsContract(engine: ContractEngine): void {
  describe(`improvements repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: ImprovementsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.improvements;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const draft = (id: string, now = T0) =>
      repo.insert({
        id,
        text: `t-${id}`,
        source: "api",
        requestedByAgentId: null,
        createdBy: null,
        now,
      });

    test("insert returns a pending draft in the stored shape", async () => {
      await draft("i1");
      expect(await repo.findById("i1")).toEqual({
        id: "i1",
        text: "t-i1",
        email: null,
        status: "pending_approval",
        source: "api",
        requested_by_agent_id: null,
        approved_by: null,
        approved_at: null,
        sent_at: null,
        proxy_status: null,
        proxy_id: null,
        proxy_error: null,
        created_at: T0,
        updated_at: T0,
        created_by: null,
        updated_by: null,
      });
      expect(await repo.findById("missing")).toBeNull();
    });

    test("claim, send result and discard move only actionable rows", async () => {
      await draft("i1");
      const claim = { approvedBy: "operator", email: "a@b.co", now: T1, updatedBy: null };
      expect(await repo.claimForSend("i1", claim)).toBe(true);
      expect(await repo.claimForSend("i1", claim)).toBe(false);
      expect(await repo.findById("i1")).toMatchObject({
        status: "sending",
        approved_by: "operator",
        approved_at: T1,
        email: "a@b.co",
        updated_at: T1,
      });
      await repo.recordSendResult("i1", {
        status: "failed",
        sentAt: null,
        proxyStatus: 500,
        proxyId: null,
        proxyError: "boom",
        now: T2,
      });
      expect(await repo.findById("i1")).toMatchObject({
        status: "failed",
        proxy_status: 500,
        proxy_error: "boom",
        updated_at: T2,
      });
      // A failed row can be claimed again; the claim clears the last result.
      expect(await repo.claimForSend("i1", claim)).toBe(true);
      expect(await repo.findById("i1")).toMatchObject({ proxy_status: null, proxy_error: null });
      expect(await repo.discard("i1", T2, null)).toBe(false);

      await draft("i2");
      expect(await repo.discard("i2", T2, null)).toBe(true);
      expect(await repo.discard("i2", T2, null)).toBe(false);
      expect(await repo.findById("i2")).toMatchObject({ status: "discarded", updated_at: T2 });
    });

    test("listing: every actionable row plus capped history, newest first, ties by id descending", async () => {
      await draft("p-old", T0);
      await draft("h1", T0);
      await draft("h2", T1);
      await draft("h3", T1);
      await draft("p-new", T2);
      for (const id of ["h1", "h2", "h3"]) await repo.discard(id, T2, null);
      expect((await repo.listActionableAndHistory(10)).map((r) => r.id)).toEqual([
        "p-new",
        "h3",
        "h2",
        "p-old",
        "h1",
      ]);
      expect((await repo.listActionableAndHistory(1)).map((r) => r.id)).toEqual([
        "p-new",
        "h3",
        "p-old",
      ]);
    });
  });
}
