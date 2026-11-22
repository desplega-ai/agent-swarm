import { asRecord, createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { startSut, stopSut } from "../sut";

const LOCKED = 6;

// On Postgres a pool claim skips a row another transaction holds (FOR UPDATE SKIP LOCKED),
// and the held task stays at the top of the priority order. The poll reads the pool again
// past every ID it tried, so a free task below more held ones than one read returns is
// still claimed. The API runs on its own Postgres database: no lead, so the pool is ours.
export const pollRescanLocked: Scenario = {
  name: "poll-rescan-locked",
  order: 9_040,
  async run(ctx) {
    const sut = await startSut(false, { SLACK_DISABLE: "true" }, {}, undefined, "postgres");
    const holder = new Bun.SQL({ url: sut.databaseUrl ?? "", max: 1 });
    try {
      const api = createApiClient(sut.baseUrl, sut.apiKey);
      const create = async (label: string, priority: number) => {
        const response = await api("POST", "/api/tasks", {
          body: {
            task: `rescan ${label} ${ctx.nonce}`,
            priority,
            followUpConfig: { disabled: true },
          },
        });
        expectStatus(response, [201], `create pool task ${label}`);
        const task = asRecord(response.json);
        expect(task.status === "unassigned", `task ${label} started ${String(task.status)}`);
        return String(task.id);
      };
      const held: string[] = [];
      for (let i = 0; i < LOCKED; i++) held.push(await create(`held-${i}`, 90));
      const free = await create("free", 10);

      const agentId = crypto.randomUUID();
      const registered = await api("POST", "/api/agents", {
        agentId,
        body: { name: `rescan-worker-${ctx.nonce}`, role: "worker", status: "online" },
      });
      expectStatus(registered, [200, 201], "register a worker");

      // Another writer holds the high-priority rows for the whole poll.
      const conn = await holder.reserve();
      try {
        await conn.unsafe("BEGIN");
        const locked = await conn.unsafe(
          "SELECT id FROM agent_tasks WHERE id = ANY($1::text[]) FOR UPDATE",
          [held],
        );
        expect(locked.length === LOCKED, `locked ${locked.length} of ${LOCKED} rows`);

        const polled = await api("GET", "/api/poll", { agentId });
        expectStatus(polled, [200], "poll");
        const trigger = asRecord(polled.json).trigger as Record<string, unknown> | null;
        expect(
          trigger?.taskId === free,
          `the poll did not claim the free task below ${LOCKED} held ones: ${polled.text.slice(0, 400)}`,
        );
        await conn.unsafe("ROLLBACK");
      } finally {
        conn.release();
      }
    } finally {
      await holder.close();
      await stopSut(sut, false);
    }
  },
};
