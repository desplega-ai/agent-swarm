import { sql } from "../db";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

const RACERS = 6;

// Unkeyed creates on one Linear tracker contextKey, all in one tick, make exactly one
// task, and every create answers 201 with that task. The dedup reads by contextKey with
// no row to lock, so on Postgres these creates stay SERIALIZABLE while other unkeyed
// creates run at READ COMMITTED; this guards that split.
export const divergenceTrackerDedup: Scenario = {
  name: "divergence-tracker-dedup",
  order: 9_441,
  async run(ctx) {
    const trackerKey = `task:trackers:linear:divergence-dedup-${ctx.nonce}`;
    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_, i) =>
        ctx.api("POST", "/api/tasks", {
          body: {
            task: `tracker dedup ${i} ${ctx.nonce}`,
            source: "api",
            contextKey: trackerKey,
          },
        }),
      ),
    );
    const ids = new Set<string>();
    responses.forEach((response, i) => {
      expectStatus(response, [201], `tracker create ${i}`);
      ids.add(asRecord(response.json).id as string);
    });
    const rows = ctx.db.query<{ id: string }>(
      sql`SELECT id FROM agent_tasks WHERE "contextKey" = ${trackerKey}`,
    );
    expect(
      rows.length === 1 && ids.size === 1 && ids.has(rows[0]?.id ?? ""),
      `tracker race made ${rows.length} tasks; creates answered ${[...ids].join(", ")}`,
    );
  },
};
