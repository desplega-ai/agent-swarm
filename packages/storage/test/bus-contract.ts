import { describe, expect, test } from "bun:test";
import type { BusDurableGroups, ManagedBus } from "../src";

type Harness = {
  bus: ManagedBus;
  transaction(fn: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
  retry(): Promise<void>;
  close(): Promise<void>;
};

/** Reusable behavioral tests. No storage engine or SQL enters these bodies. */
export function runBusContract(fresh: (groups: BusDurableGroups) => Promise<Harness>): void {
  const groups: BusDurableGroups = { "script.job.requested": ["a", "b", "durable", "retry"] };
  describe("bus contract", () => {
    test("each durable group receives each event once on success", async () => {
      const h = await fresh(groups);
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
      const h = await fresh(groups);
      try {
        h.bus.start();
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
      const h = await fresh(groups);
      try {
        let attempts = 0;
        h.bus.subscribe(
          "script.job.requested",
          "retry",
          async () => {
            if (++attempts <= 12) throw new Error("retry");
          },
          { delivery: "durable" },
        );
        await h.bus.publish("script.job.requested", { runId: "retry" });
        await h.drain();
        expect(attempts).toBe(1);
        for (let attempt = 2; attempt <= 13; attempt++) {
          await h.retry();
          await h.drain();
          expect(attempts).toBe(attempt);
        }
      } finally {
        await h.close();
      }
    });
    test("declared groups receive earlier publications and undeclared groups fail", async () => {
      const h = await fresh(groups);
      try {
        expect(() =>
          h.bus.subscribe("script.job.requested", "undeclared", async () => {}, {
            delivery: "durable",
          }),
        ).toThrow("catalog");
        await h.bus.publish("script.job.requested", { runId: "before-subscribe" });
        const seen: string[] = [];
        h.bus.subscribe(
          "script.job.requested",
          "a",
          async (p) => {
            seen.push(p.runId);
          },
          { delivery: "durable" },
        );
        await h.drain();
        expect(seen).toEqual(["before-subscribe"]);
      } finally {
        await h.close();
      }
    });
    test("stop cancels pending wakeups, including callbacks from a previous start", async () => {
      const h = await fresh(groups);
      try {
        const seen: string[] = [];
        h.bus.subscribe(
          "script.job.requested",
          "wake",
          async (p) => {
            seen.push(p.runId);
          },
          {
            delivery: "wake-up",
          },
        );
        h.bus.start();
        await h.transaction(async () => {
          await h.bus.publish("script.job.requested", { runId: "before-stop" });
          await h.bus.stop();
        });
        await h.drain();
        expect(seen).toEqual([]);
        h.bus.start();
        await h.transaction(async () => {
          await h.bus.publish("script.job.requested", { runId: "previous-start" });
          await h.bus.stop();
          h.bus.start();
        });
        await h.drain();
        expect(seen).toEqual([]);
        h.bus.start();
        await h.bus.publish("script.job.requested", { runId: "current-start" });
        await h.drain();
        expect(seen).toEqual(["current-start"]);
      } finally {
        await h.close();
      }
    });
  });
}
