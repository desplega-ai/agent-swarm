import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewSlackInboundReceipt, type SlackRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";
import { seedTask } from "./tasks";

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

    test("render state: visibility transitions and reconcile cursors", async () => {
      expect(await repo.getTreeVisibility()).toBeNull();
      expect(await repo.getReconcileCursors()).toBeNull();
      await storage.executor.run(
        sql`INSERT INTO slack_render_v2_state (id, activated_at) VALUES (1, ${T0})`,
      );
      expect(await repo.getTreeVisibility()).toEqual({
        task_tree_enabled: null,
        task_tree_enabled_at: null,
      });
      // From unset (not 0) to on: the activation time is not stamped.
      expect(await repo.setTreeVisibility(true, T1)).toBeNull();
      expect(await repo.setTreeVisibility(false, T1)).toBeNull();
      expect(await repo.getTreeVisibility()).toEqual({
        task_tree_enabled: 0,
        task_tree_enabled_at: null,
      });
      expect(await repo.setTreeVisibility(true, T2)).toBe(T2);
      expect(await repo.setTreeVisibility(false, T0)).toBe(T2);
      expect(await repo.getReconcileCursors()).toBe("{}");
      await repo.setReconcileCursors('{"outcome":"x"}');
      expect(await repo.getReconcileCursors()).toBe('{"outcome":"x"}');
    });

    test("bot and agent reply checks", async () => {
      for (const task of ["t1", "t2"]) {
        await storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt")
          VALUES (${task}, 't', 'completed', ${T0}, ${T0})`);
      }
      const msg = (
        id: string,
        kind: string,
        task: string | null,
        createdAt: string,
        by: string | null,
      ) =>
        storage.executor.run(sql`
          INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, task_id,
            finalized_at, created_at, updated_at, created_by)
          VALUES (${id}, ${`ctx-${id}`}, 'C1', '1.0', ${`${id}.ts`}, ${kind}, ${task}, ${T1},
            ${createdAt}, ${createdAt}, ${by})`);
      await msg("o1", "outcome", "t1", T1, null);
      expect(await repo.threadHasBotReplySince("C1", "1.0", T0, "t1")).toBe(false);
      expect(await repo.threadHasBotReplySince("C1", "1.0", T0, "t2")).toBe(true);
      expect(await repo.threadHasBotReplySince("C1", "1.0", T2, "t2")).toBe(false);
      await msg("a1", "agent", "t2", T1, "lead");
      expect(await repo.threadHasBotReplySince("C1", "1.0", T1, "t1")).toBe(true);
      expect(await repo.threadHasAgentReplyOnTasksSince("C1", "1.0", T0, "lead", ["t2"])).toBe(
        true,
      );
      expect(await repo.threadHasAgentReplyOnTasksSince("C1", "1.0", T0, "lead", ["t1"])).toBe(
        false,
      );
      expect(await repo.threadHasAgentReplyOnTasksSince("C1", "1.0", T0, "other", ["t2"])).toBe(
        false,
      );
      expect(await repo.threadHasAgentReplyOnTasksSince("C1", "1.0", T0, "lead", [])).toBe(false);
    });

    test("trees: render work, settling and the reconcile pages", async () => {
      await storage.executor.run(
        sql`INSERT INTO slack_render_v2_state (id, activated_at) VALUES (1, ${T0})`,
      );
      const tree = (id: string, ts: string, channel: string, createdAt: string) =>
        storage.executor.run(sql`
          INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind,
            created_at, updated_at)
          VALUES (${id}, ${`ctx-${id}`}, ${channel}, '1.0', ${ts}, 'tree', ${createdAt}, ${createdAt})`);
      await tree("tz", "pending:z", "C2", T1);
      await tree("ta", "pending:a", "C3", T1);
      await tree("posted", "9.9", "C4", T1);
      // Callers pass ISO instants; the epoch admits every row.
      const EPOCH = "1970-01-01T00:00:00.000Z";
      const window = { finishedAfter: EPOCH, closureActiveAfter: EPOCH, delegationEnabled: false };
      expect((await repo.listTreesNeedingRender()).map((row) => row.id)).toEqual(["tz", "ta"]);
      expect(
        (await repo.listTreesNeedingRender({ channelId: "C3", threadTs: "1.0" })).map((r) => r.id),
      ).toEqual(["ta"]);
      expect(await repo.closeTreeIfSettled("tz", T2)).toBe(false);
      expect(await repo.closeTreeIfSettled("posted", T2)).toBe(true);
      expect(await repo.closeTreeIfSettled("posted", T2)).toBe(false);
      const trees = await repo.pageReconcileCandidates("tree", "", 50, false, window);
      expect(trees).toEqual([
        { id: "ta", channelId: "C3", threadTs: "1.0", eligible: 1 },
        { id: "tz", channelId: "C2", threadTs: "1.0", eligible: 1 },
      ]);
      expect(await repo.pageReconcileCandidates("tree", "ta", 50, false, window)).toHaveLength(1);
      expect(await repo.pageReconcileCandidates("outcome", "", 50, false, window)).toEqual([]);
      expect(await repo.pageReconcileCandidates("active", "", 50, false, window)).toEqual([]);
      expect(await repo.pageReconcileCandidates("terminal", "", 50, false, window)).toEqual([]);
      expect(await repo.threadHasOutcomeWork({ channelId: "C2", threadTs: "1.0" }, window)).toBe(
        false,
      );
    });

    test("render v2 state activates once; delegation fills in once", async () => {
      await storage.executor.run(sql`DELETE FROM slack_render_v2_state`);
      expect(await repo.getRenderV2State()).toBeNull();
      await repo.ensureDelegationActivation(T0);
      await repo.ensureRenderV2Activation(T1);
      await repo.ensureDelegationActivation(T1);
      expect(await repo.getRenderV2State()).toEqual({
        activated_at: T0,
        delegation_activated_at: T0,
      });
    });

    test("slack message rows: record merges, reserve, bind, update, deliveries", async () => {
      const rec = (extra: Record<string, unknown> = {}) =>
        repo.recordSlackMessage({
          id: "m1",
          context_key: "ctx",
          channel_id: "C",
          thread_ts: "1.0",
          ts: "1.1",
          kind: "agent",
          task_id: null,
          permalink: null,
          finalized_at: null,
          stream_chunks_appended: 3,
          conclusion_kind: null,
          now: T0,
          actor: null,
          ...extra,
        });
      expect(await rec({ permalink: "p" })).toMatchObject({
        id: "m1",
        permalink: "p",
        stream_chunks_appended: 3,
      });
      expect(await rec({ id: "m2", stream_chunks_appended: 1, now: T1 })).toMatchObject({
        id: "m1",
        permalink: "p",
        stream_chunks_appended: 3,
        updated_at: T1,
      });
      expect((await repo.findSlackMessageByChannelTs("C", "1.1"))?.id).toBe("m1");
      const reserve = (id: string, ts: string) =>
        repo.reserveSlackMessage({
          id,
          context_key: "ctx",
          channel_id: "C",
          thread_ts: "1.0",
          ts,
          kind: "tree",
          task_id: null,
          now: T0,
          actor: null,
        });
      expect((await reserve("t1", "pending:t1"))?.ts).toBe("pending:t1");
      expect(await reserve("t2", "pending:t2")).toBeNull();
      expect((await repo.findSlackTreeByThread("C", "1.0"))?.id).toBe("t1");
      expect((await repo.findSlackTreeByContextKey("ctx"))?.id).toBe("t1");
      const bound = await repo.bindSlackMessageTimestamp("t1", "2.0", 4, T1);
      expect([bound?.ts, bound?.stream_chunks_appended, bound?.updated_at]).toEqual(["2.0", 4, T1]);
      expect(await repo.bindSlackMessageTimestamp("t1", "3.0", 0, T1)).toBeNull();
      expect((await repo.markSlackTreeRendered("t1", T0))?.updated_at).toBe(T0);
      expect(await repo.markSlackTreeRendered("m1", T0)).toBeNull();
      const kept = await repo.updateSlackMessageRecord("m1", {
        permalink: null,
        finalize: true,
        streamChunksAppended: null,
        conclusionKind: "complete",
        touch: false,
        actor: "u",
        now: T1,
      });
      expect([
        kept?.permalink,
        kept?.finalized_at,
        kept?.conclusion_kind,
        kept?.updated_at,
      ]).toEqual(["p", T1, "complete", T1]);
      await seedTask(storage, { id: "task1" });
      await rec({ id: "o1", ts: "5.0", kind: "outcome", task_id: "task1" });
      expect((await repo.findSlackOutcomeByTask("task1"))?.id).toBe("o1");
      expect(
        (await repo.noteSlackOutcomeDeliveryFailure("task1", "e1", T1))?.delivery_attempts,
      ).toBe(1);
      expect((await repo.abandonSlackOutcomeDelivery("task1", "e2", T1))?.delivery_last_error).toBe(
        "e2",
      );
      expect(await repo.abandonSlackOutcomeDelivery("task1", "e3", T1)).toBeNull();
      expect(await repo.noteSlackOutcomeDeliveryFailure("task1", "e4", T1)).toBeNull();
      await repo.markSlackDeferralResolved("o1", T1, true);
      const o = await repo.findSlackOutcomeByTask("task1");
      expect([o?.deferral_resolved_at, o?.deferral_abandoned_at]).toEqual([T1, T1]);
      expect(await repo.listResolvableDeferralOutcomes(10)).toEqual([]);
      expect(await repo.deleteSlackMessage("o1")).toBe(1);
    });

    test("Slack tasks missing a tree: thread scope and the updated-since sweep", async () => {
      await storage.executor.run(sql`DELETE FROM slack_render_v2_state`);
      await repo.ensureRenderV2Activation(T0);
      const task = (id: string, extra: Record<string, string>) =>
        seedTask(storage, {
          id,
          source: "slack",
          slackChannelId: "C",
          slackThreadTs: "1.0",
          createdAt: T1,
          ...extra,
        });
      await task("a", { lastUpdatedAt: T1 });
      await task("b", { lastUpdatedAt: T2 });
      await task("c", { slackThreadTs: "2.0", lastUpdatedAt: T2, status: "backlog" });
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
      expect(ids(await repo.listSlackTasksMissingTree({ since: T0 }))).toEqual(["b", "a"]);
      expect(ids(await repo.listSlackTasksMissingTree({ since: T2 }))).toEqual(["b"]);
      expect(
        ids(await repo.listSlackTasksMissingTree({ thread: { channelId: "C", threadTs: "1.0" } })),
      ).toEqual(["b", "a"]);
      await storage.executor.run(sql`
        INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, created_at, updated_at)
        VALUES ('tree', 'k', 'C', '1.0', '1.5', 'tree', ${T1}, ${T1})`);
      expect(await repo.listSlackTasksMissingTree({ since: T0 })).toEqual([]);
    });
  });
}
