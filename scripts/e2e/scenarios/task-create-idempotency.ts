// POST /api/tasks with an Idempotency-Key: a retried key returns the task it first created,
// never a second one (the Sessions composer's Retry on a failed follow-up).
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

export const taskCreateIdempotency: Scenario = {
  name: "task-create-idempotency",
  order: 31,
  async run(ctx) {
    const key = `task-idem-${ctx.nonce}`;
    const body = { task: `Idempotent follow-up ${ctx.nonce}`, source: "ui" };
    const countTasks = (task: string) =>
      ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks WHERE task = ?", [task])?.n;

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
        ctx.api("POST", "/api/tasks", { headers: { "Idempotency-Key": freshKey }, body: freshBody }),
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
  },
};
