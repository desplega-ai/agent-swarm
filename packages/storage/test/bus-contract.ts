import { describe, expect, test } from "bun:test";
import type { Bus } from "../src";

type Harness = {
  bus: Bus;
  transaction(fn: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
  retry(): Promise<void>;
  close(): Promise<void>;
};

/** Reusable behavioral tests. No storage engine or SQL enters these bodies. */
export function runBusContract(fresh: () => Promise<Harness>): void {
  describe("bus contract", () => {
    test("each durable group receives each event once on success", async () => {
      const h = await fresh();
      try {
        const seen: string[] = [];
        h.bus.subscribe(
          "script.job.requested",
          "a",
          async (p) => {
            seen.push(`a:${p.runId}`);
          },
          { delivery: "durable" },
        );
        h.bus.subscribe(
          "script.job.requested",
          "b",
          async (p) => {
            seen.push(`b:${p.runId}`);
          },
          { delivery: "durable" },
        );
        await h.bus.publish("script.job.requested", { runId: "one" });
        await h.bus.publish("script.job.requested", { runId: "two" });
        await h.drain();
        expect(seen.sort()).toEqual(["a:one", "a:two", "b:one", "b:two"]);
      } finally {
        await h.close();
      }
    });
    test("rollback drops delivery and wakeups; commit precedes handlers", async () => {
      const h = await fresh();
      try {
        const seen: string[] = [];
        for (const delivery of ["durable", "wake-up"] as const) {
          h.bus.subscribe(
            "script.job.requested",
            delivery,
            async (p) => {
              seen.push(p.runId);
            },
            { delivery },
          );
        }
        await expect(
          h.transaction(async () => {
            await h.bus.publish("script.job.requested", { runId: "rollback" });
            expect(seen).toEqual([]);
            throw new Error("rollback");
          }),
        ).rejects.toThrow("rollback");
        await h.drain();
        expect(seen).toEqual([]);
        await h.transaction(async () => {
          await h.bus.publish("script.job.requested", { runId: "commit" });
          expect(seen).toEqual([]);
        });
        await h.drain();
        expect(seen).toEqual(["commit", "commit"]);
      } finally {
        await h.close();
      }
    });
    test("a failed handler receives the event again", async () => {
      const h = await fresh();
      try {
        let attempts = 0;
        h.bus.subscribe(
          "script.job.requested",
          "retry",
          async () => {
            if (++attempts === 1) throw new Error("retry");
          },
          { delivery: "durable" },
        );
        await h.bus.publish("script.job.requested", { runId: "retry" });
        await h.drain();
        expect(attempts).toBe(1);
        await h.retry();
        await h.drain();
        expect(attempts).toBe(2);
      } finally {
        await h.close();
      }
    });
  });
}
