import { sql } from "../db";
// POST /api/tasks with an Idempotency-Key: a retried key returns the task it first created,
// never a second one (the Sessions composer's Retry on a failed follow-up).
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { asUser, cancelQuietly, createUser, registerWorker } from "./core-helpers";

export const taskCreateIdempotency: Scenario = {
  name: "task-create-idempotency",
  order: 31,
  async run(ctx) {
    const key = `task-idem-${ctx.nonce}`;
    const body = { task: `Idempotent follow-up ${ctx.nonce}`, source: "ui" };
    const countTasks = (task: string) =>
      ctx.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM agent_tasks WHERE task = ${task}`)?.n;

    const first = await ctx.api("POST", "/api/tasks", {
      headers: { "Idempotency-Key": key },
      body,
    });
    expectStatus(first, [201], "keyed create");
    const taskId = asString(asRecord(first.json).id, "keyed task id");
    expect(first.headers.get("idempotent-replayed") === null, "first create is not a replay");

    const retry = await ctx.api("POST", "/api/tasks", {
      headers: { "Idempotency-Key": key },
      body,
    });
    expectStatus(retry, [201], "retried create");
    expect(asRecord(retry.json).id === taskId, "a retried key returns the same task");
    expect(retry.headers.get("idempotent-replayed") === "true", "retry carries the replay header");

    expect(countTasks(body.task) === 1, "the key created exactly one task");

    expectStatus(
      await ctx.api("POST", "/api/tasks", {
        headers: { "Idempotency-Key": key },
        body: { ...body, task: `${body.task} edited` },
      }),
      [409],
      "same key, different body",
    );

    // Two fresh keys racing: each creates its own task, and the record commits with it.
    const freshKey = `task-idem-fresh-${ctx.nonce}`;
    const freshBody = { task: `Idempotent race ${ctx.nonce}`, source: "ui" };
    const freshRace = await Promise.all(
      [0, 1, 2].map(() =>
        ctx.api("POST", "/api/tasks", {
          headers: { "Idempotency-Key": freshKey },
          body: freshBody,
        }),
      ),
    );
    const freshIds = new Set(
      freshRace.map((response) => {
        expectStatus(response, [201], "fresh-key race");
        return asString(asRecord(response.json).id, "fresh-key task id");
      }),
    );
    expect(freshIds.size === 1, "a key raced from three requests creates one task");
    expect(countTasks(freshBody.task) === 1, "the raced key left exactly one task row");

    // Without a key nothing changes: two sends are two tasks.
    const plain = { task: `Unkeyed ${ctx.nonce}`, source: "ui" };
    for (const label of ["unkeyed create 1", "unkeyed create 2"]) {
      expectStatus(await ctx.api("POST", "/api/tasks", { body: plain }), [201], label);
    }
    expect(countTasks(plain.task) === 2, "unkeyed creates are not deduplicated");

    const badKey = await ctx.api("POST", "/api/tasks", {
      headers: { "Idempotency-Key": "bad key with spaces" },
      body,
    });
    expectStatus(badKey, [400], "malformed key");
    expect(String(asRecord(badKey.json).error).includes("Idempotency-Key"), "malformed key error");

    await replayNeedsSessionRead(ctx);
  },
};

/**
 * A replay returns the task as it is now, output included, so it needs the
 * same session read access as GET /api/tasks/{id}: once the owner revokes a
 * share, the old key no longer reads the follow-up it created. The follow-up
 * names only a `contextKey`, so the server wires it under the owner's root and
 * the route's body-parentTaskId gate never sees the session.
 */
async function replayNeedsSessionRead(ctx: ScenarioContext): Promise<void> {
  const owner = await createUser(ctx, "idem-owner");
  const writer = await createUser(ctx, "idem-writer");
  const workerId = await registerWorker(ctx, "idem-worker");
  const contextKey = `task:ui:idem:${ctx.nonce}`;
  const pinned = { agentId: workerId, routingReason: "human_pinned", source: "ui", contextKey };
  const root = await ctx.api("POST", "/api/tasks", {
    body: { task: `Idempotent session root ${ctx.nonce}`, requestedByUserId: owner, ...pinned },
  });
  expectStatus(root, [201], "owner creates the session root");
  const rootId = asString(asRecord(root.json).id, "root task id");
  const share = (users: Array<{ userId: string; access: string }>) =>
    ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
      headers: asUser(owner),
      body: { everyone: "none", users },
    });
  expectStatus(await share([{ userId: writer, access: "write" }]), [200], "share with a writer");

  const send = () =>
    ctx.api("POST", "/api/tasks", {
      headers: { ...asUser(writer), "Idempotency-Key": `task-idem-share-${ctx.nonce}` },
      body: { task: `Shared follow-up ${ctx.nonce}`, ...pinned },
    });
  const created = await send();
  expectStatus(created, [201], "the writer sends a keyed follow-up");
  const followUp = asRecord(created.json);
  const followUpId = asString(followUp.id, "follow-up task id");
  expect(followUp.parentTaskId === rootId, "the contextKey wires the follow-up under the root");
  const replay = await send();
  expectStatus(replay, [201], "the writer retries while shared");
  expect(asRecord(replay.json).id === followUpId, "a shared retry returns the follow-up");

  expectStatus(await share([]), [200], "revoke the writer's share");
  expectStatus(
    await ctx.api("GET", `/api/tasks/${followUpId}`, { headers: asUser(writer) }),
    [403],
    "the revoked writer cannot read the follow-up",
  );
  const revoked = await send();
  expectStatus(revoked, [403], "a revoked writer replays the key");
  expect(
    asRecord(revoked.json).id === undefined && revoked.headers.get("idempotent-replayed") === null,
    "a denied replay returns no task",
  );
  await cancelQuietly(ctx, followUpId);
  await cancelQuietly(ctx, rootId);
}
