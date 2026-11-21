import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewSlackInboundReceipt, type SlackRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

function receipt(overrides: Partial<NewSlackInboundReceipt> = {}): NewSlackInboundReceipt {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    dedupKey: `key-${id}`,
    transport: "socket",
    kind: "event",
    payloadType: "message",
    apiAppId: null,
    eventId: null,
    retryNum: null,
    retryReason: null,
    now: T0,
    ...overrides,
  };
}

export function slackContract(engine: ContractEngine): void {
  describe(`slack repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SlackRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.slack;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const admit = (overrides: Partial<NewSlackInboundReceipt> = {}, bytes = 10) =>
      repo.insertInboundReceipt({
        ...receipt(overrides),
        payloadCiphertext: "enc",
        payloadBytes: bytes,
      });

    test("insert, duplicate sightings and the backlog", async () => {
      const row = await admit({ id: "r1", dedupKey: "k1" }, 7);
      expect(row).toMatchObject({
        id: "r1",
        dedup_key: "k1",
        state: "pending",
        attempts: 0,
        duplicate_count: 0,
        payload_ciphertext: "enc",
        payload_bytes: 7,
        received_at: T0,
        available_at: T0,
      });
      expect(await admit({ id: "r2", dedupKey: "k1" })).toBeNull();
      const dup = await repo.touchInboundDuplicate("k1", T1);
      expect(dup).toMatchObject({ id: "r1", duplicate_count: 1, last_duplicate_at: T1 });
      expect(await repo.touchInboundDuplicate("missing", T1)).toBeNull();
      await admit({ id: "r3" }, 5);
      expect(await repo.inboundBacklog()).toEqual({ receipts: 2, bytes: 12 });
      expect(await repo.insertInboundTombstone(receipt({ id: "t1", dedupKey: "k-t" }))).toBe(true);
      expect(await repo.insertInboundTombstone(receipt({ id: "t2", dedupKey: "k-t" }))).toBe(false);
      expect(await repo.findInboundReceipt("t1")).toMatchObject({
        state: "processed",
        attempts: 1,
        outcome_code: "ran_inline",
        payload_ciphertext: null,
        completed_at: T0,
      });
      expect(await repo.inboundBacklog()).toEqual({ receipts: 2, bytes: 12 });
    });

    test("claim takes the oldest available, then a named receipt; complete and release", async () => {
      await admit({ id: "b", now: T1 });
      await admit({ id: "a", now: T1 });
      await admit({ id: "c", now: T0 });
      await admit({ id: "later", now: T2 });
      expect((await repo.claimInboundReceipt(T1))?.id).toBe("c");
      expect((await repo.claimInboundReceipt(T1))?.id).toBe("a");
      expect(await repo.claimInboundReceipt(T1, "later")).toBeNull();
      const named = await repo.claimInboundReceipt(T2, "later");
      expect(named).toMatchObject({ state: "processing", attempts: 1, claimed_at: T2 });
      expect(
        await repo.completeInboundReceipt(
          "c",
          {
            state: "processed",
            outcomeCode: "ok",
            errorCode: null,
            completedAt: T2,
            erasePayload: true,
          },
          T2,
        ),
      ).toBe(true);
      expect(await repo.findInboundReceipt("c")).toMatchObject({
        state: "processed",
        payload_ciphertext: null,
        payload_erased_at: T2,
        completed_at: T2,
      });
      expect(
        await repo.completeInboundReceipt(
          "c",
          {
            state: "failed",
            outcomeCode: null,
            errorCode: "x",
            completedAt: T2,
            erasePayload: false,
          },
          T2,
        ),
      ).toBe(false);
      expect(
        await repo.completeInboundReceipt(
          "a",
          {
            state: "failed",
            outcomeCode: null,
            errorCode: "boom",
            completedAt: T2,
            erasePayload: false,
          },
          T2,
        ),
      ).toBe(true);
      expect(await repo.findInboundReceipt("a")).toMatchObject({
        state: "failed",
        payload_ciphertext: "enc",
        payload_erased_at: null,
      });
      expect(await repo.releaseInboundReceipt("later", "retry", T2, T2)).toBe(true);
      expect(await repo.findInboundReceipt("later")).toMatchObject({
        state: "pending",
        claimed_at: null,
        error_code: "retry",
      });
      expect(await repo.releaseInboundReceipt("later", "retry", T2, T2)).toBe(false);
      expect(await repo.nextInboundAvailableAt()).toBe(T1);
    });

    test("interrupted receipts become uncertain; retention deletes and erases completed ones", async () => {
      await admit({ id: "p1" });
      await repo.claimInboundReceipt(T0, "p1");
      expect(await repo.markInterruptedInboundUncertain(T1)).toBe(1);
      expect(await repo.findInboundReceipt("p1")).toMatchObject({
        state: "uncertain",
        error_code: "interrupted_during_processing",
      });
      await admit({ id: "done-old" });
      await admit({ id: "done-new" });
      for (const [id, at] of [
        ["done-old", T0],
        ["done-new", T2],
      ] as const) {
        await repo.claimInboundReceipt(T0, id);
        await repo.completeInboundReceipt(
          id,
          {
            state: "ignored",
            outcomeCode: null,
            errorCode: null,
            completedAt: at,
            erasePayload: false,
          },
          at,
        );
      }
      expect(await repo.deleteCompletedInboundBefore(T1)).toBe(1);
      expect(await repo.eraseCompletedInboundPayloads(T2)).toBe(1);
      expect(await repo.findInboundReceipt("done-new")).toMatchObject({ payload_ciphertext: null });
      expect(await repo.findInboundReceipt("p1")).not.toBeNull();
    });

    test("stats queries: per-state counts, totals, last failure and uncertain order", async () => {
      for (const id of ["u1", "u2", "u3"]) {
        await admit({ id, now: id === "u3" ? T1 : T0 }, 4);
        await repo.claimInboundReceipt(T2, id);
      }
      await repo.markInterruptedInboundUncertain(T1);
      await admit({ id: "w" }, 3);
      expect(await repo.inboundStateCounts()).toEqual([
        { state: "pending", n: 1, oldest: T0 },
        { state: "uncertain", n: 3, oldest: T0 },
      ]);
      expect(await repo.inboundTotals()).toEqual({
        backlogBytes: 3,
        duplicates: 0,
        lastReceivedAt: T1,
      });
      expect(await repo.lastInboundFailure()).toEqual({
        error_code: "interrupted_during_processing",
        updated_at: T1,
      });
      expect((await repo.listUncertainInbound(10)).map((row) => row.id)).toEqual([
        "u3",
        "u2",
        "u1",
      ]);
      expect((await repo.listUncertainInbound(1)).map((row) => row.id)).toEqual(["u3"]);
    });

    test("outcome card groups: hosts, merged rows and their order", async () => {
      const card = (id: string, extra: Record<string, string | null>) =>
        storage.executor.run(sql`
          INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, task_id,
            finalized_at, merged_into_id, created_at, updated_at)
          VALUES (${id}, 'ctx', 'C1', '1.0', ${extra.ts ?? `${id}.ts`}, 'outcome', ${extra.task ?? id},
            ${"finalized" in extra ? (extra.finalized ?? null) : T0}, ${extra.merged ?? null}, ${extra.created ?? T0}, ${T0})`);
      // slack_messages.task_id references agent_tasks.
      for (const task of ["h1", "h2", "pending", "open", "t-0", "t-a", "t-b"]) {
        await storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt")
          VALUES (${task}, 't', 'completed', ${T0}, ${T0})`);
      }
      await card("h1", { finalized: T1 });
      await card("h2", { finalized: T1 });
      await card("pending", { ts: "pending:x", finalized: T2 });
      await card("open", { finalized: null });
      const host = await repo.findLatestOutcomeHost("C1", "1.0");
      expect(host).toEqual({
        id: "h1",
        ts: "h1.ts",
        task_id: "h1",
        context_key: "ctx",
        permalink: null,
        conclusion_kind: null,
        finalized_at: T1,
      });
      expect(await repo.findOutcomeHost("pending")).toBeNull();
      expect(await repo.findOutcomeHost("open")).toBeNull();
      expect(
        await repo.insertMergedOutcome({
          id: "m2",
          contextKey: "ctx",
          channelId: "C1",
          threadTs: "1.0",
          ts: "merged:m2",
          taskId: "t-b",
          permalink: "https://p",
          hostId: "h1",
          actorId: null,
          now: T1,
        }),
      ).toBe(true);
      // The task already has an outcome row.
      expect(
        await repo.insertMergedOutcome({
          id: "m2-again",
          contextKey: "ctx",
          channelId: "C1",
          threadTs: "1.0",
          ts: "merged:m2-again",
          taskId: "t-b",
          permalink: null,
          hostId: "h1",
          actorId: null,
          now: T1,
        }),
      ).toBe(false);
      await card("m1", { ts: "merged:m1", task: "t-a", merged: "h1", created: T1 });
      await card("m0", { ts: "merged:m0", task: "t-0", merged: "h1", created: T0 });
      expect(await repo.listMergedOutcomeTasks("h1")).toEqual([
        { task_id: "t-0", created_at: T0 },
        { task_id: "t-a", created_at: T1 },
        { task_id: "t-b", created_at: T1 },
      ]);
      expect(await repo.findMergedIntoId("m1")).toEqual({ merged_into_id: "h1" });
      expect(await repo.findMergedIntoId("nope")).toBeNull();
      expect(await repo.findOutcomeHost("m1")).toBeNull();
      expect((await repo.findOutcomeHost("h1"))?.id).toBe("h1");
    });
  });
}
