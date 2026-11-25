import { expect, test } from "bun:test";
import { runBusContract } from "../../storage/test/bus-contract";
import { PostgresTableBus } from "../src/bus/table-backend";
import { createPostgresClient } from "../src/client";
import { PostgresBusRepository } from "../src/repositories/bus";
import { createScratchDatabase } from "./scratch";

async function fresh() {
  const scratch = await createScratchDatabase("bus");
  const observations: { attempts: number; outcome: string; stack: string }[] = [];
  const client = createPostgresClient(scratch.url, {
    max: 12,
    onTransactionEnd: (o) => observations.push(o),
  });
  await client.run(await Bun.file("src/be/migrations/postgres/381_bus_tables.sql").text());
  const bus = new PostgresTableBus(client, { sweepMs: 60_000, leaseMs: 60_000 });
  return {
    bus,
    client,
    observations,
    scratch,
    async close() {
      await bus.stop();
      await client.close();
      await scratch.drop();
    },
  };
}
runBusContract(async () => {
  const h = await fresh();
  return {
    ...h,
    transaction: (fn) => h.client.transaction(fn),
    async drain() {
      h.bus.start();
      await h.bus.drain();
      await Bun.sleep(5);
      await h.bus.drain();
      await h.bus.stop();
    },
    async retry() {
      await h.client.run('UPDATE bus_deliveries SET "availableAt"=0');
    },
  };
});

test("expired claims recover, and a stale owner cannot acknowledge", async () => {
  const h = await fresh();
  try {
    const repo = new PostgresBusRepository(h.client);
    await h.bus.publish("script.job.requested", { runId: "lease" });
    const first = await repo.claim("script.job.requested", "script-dispatcher", 10);
    expect(first).not.toBeNull();
    await Bun.sleep(20);
    const next = await repo.claim("script.job.requested", "script-dispatcher", 60_000);
    expect(next?.claimedBy).not.toBe(first?.claimedBy);
    await repo.settle(first!, "script-dispatcher", true, 0);
    expect(
      (await h.client.get<{ status: string }>("SELECT status FROM bus_deliveries"))?.status,
    ).toBe("claimed");
    await repo.settle(next!, "script-dispatcher", true, 0);
    expect(
      (await h.client.get<{ attempts: number }>("SELECT attempts FROM bus_deliveries"))?.attempts,
    ).toBe(2);
  } finally {
    await h.close();
  }
});

test("two consumers claim concurrently, outside handler transactions; wakeups create no delivery", async () => {
  const h = await fresh();
  const second = new PostgresTableBus(h.client);
  try {
    const seen: string[] = [];
    const handler = async ({ runId }: { runId: string }) => {
      expect(h.client.inTransaction()).toBe(false);
      seen.push(runId);
    };
    h.bus.subscribe("script.job.requested", "script-dispatcher", handler, { delivery: "durable" });
    second.subscribe("script.job.requested", "script-dispatcher", handler, { delivery: "durable" });
    h.bus.subscribe("script.job.requested", "wake", async () => {}, { delivery: "wake-up" });
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        h.bus.publish("script.job.requested", { runId: String(i) }),
      ),
    );
    h.bus.start();
    second.start();
    await Promise.all([h.bus.drain(), second.drain()]);
    expect(seen.length).toBe(100);
    expect(new Set(seen).size).toBe(100);
    expect(
      (
        await h.client.get<{ n: number }>(
          "SELECT count(*) n FROM bus_deliveries WHERE \"groupName\"='wake'",
        )
      )?.n,
    ).toBe(0);
    const claims = h.observations.filter((o) => /at claim \(/.test(o.stack));
    console.log(
      `bus stress: transactions=${claims.length}, retrying=${claims.filter((o) => o.attempts > 1).length}, retries=${claims.reduce((n, o) => n + o.attempts - 1, 0)}`,
    );
  } finally {
    await second.stop();
    await h.close();
  }
}, 30_000);

test("producer before consumer, restart recovery, and bounded retention preserve pending groups", async () => {
  const h = await fresh();
  try {
    for (let i = 0; i < 20; i++) await h.bus.publish("script.job.requested", { runId: String(i) });
    expect((await h.client.get<{ n: number }>("SELECT count(*) n FROM bus_events"))?.n).toBe(20);
    const recovered = new PostgresTableBus(h.client);
    let delivered = 0;
    recovered.subscribe(
      "script.job.requested",
      "script-dispatcher",
      async () => {
        delivered++;
      },
      { delivery: "durable" },
    );
    recovered.start();
    await recovered.drain();
    await recovered.stop();
    expect(delivered).toBe(20);
    const repo = new PostgresBusRepository(h.client);
    await h.client.run('UPDATE bus_events SET "createdAt"=0');
    expect(await repo.prune(Date.now() - 1000)).toBe(0);
    await h.client.run('UPDATE bus_deliveries SET "deliveredAt"=0');
    const started = performance.now();
    expect(await repo.prune(Date.now() - 1000)).toBe(20);
    console.log(
      `bus retention: 20 events/20 deliveries -> 0/0 in ${(performance.now() - started).toFixed(2)}ms`,
    );
    await h.bus.publish("script.job.requested", { runId: "pending" });
    await h.client.run('UPDATE bus_events SET "createdAt"=0');
    expect(await repo.prune(Date.now())).toBe(0);
    expect((await h.client.get<{ n: number }>("SELECT count(*) n FROM bus_deliveries"))?.n).toBe(1);
  } finally {
    await h.close();
  }
});
