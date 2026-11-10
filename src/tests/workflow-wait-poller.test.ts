import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as db from "../be/db";
import type { WaitStateRow } from "../types";
import type { ExecutorRegistry } from "../workflows/executors/registry";
import * as resume from "../workflows/resume";
import { startWaitPoller, stopWaitPoller } from "../workflows/wait-poller";
import { waitUntil } from "./workflow-wait";

// No DB: every tick sees one due wait, and the resume records which poller
// (by registry) ran the tick. Blocking a resume holds that tick in flight.
const dueWait = { id: "wait-1", mode: "time" } as WaitStateRow;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("wait poller stop", () => {
  const ticks = new Map<ExecutorRegistry, number>();
  const count = (registry: ExecutorRegistry) => ticks.get(registry) ?? 0;
  let blockFirstTick: Promise<void> | undefined;

  const dueSpy = spyOn(db, "getDueWaitStates").mockImplementation(async () => [dueWait]);
  const resumeSpy = spyOn(resume, "resumeWaitState").mockImplementation(
    async (_id, _kind, _payload, registry) => {
      ticks.set(registry, count(registry) + 1);
      const block = blockFirstTick;
      blockFirstTick = undefined;
      if (block) await block;
    },
  );

  afterAll(() => {
    dueSpy.mockRestore();
    resumeSpy.mockRestore();
  });

  afterEach(() => {
    stopWaitPoller();
    ticks.clear();
    blockFirstTick = undefined;
  });

  test("a stop during a tick keeps the poller stopped", async () => {
    const registry = {} as ExecutorRegistry;
    const gate = deferred();
    blockFirstTick = gate.promise;

    startWaitPoller(registry, 1);
    await waitUntil(
      () => count(registry) === 1,
      () => "the poller never ran its first tick",
    );
    stopWaitPoller();
    gate.resolve();

    // Negative: a poller revived by the finishing tick runs again within a few ms.
    await Bun.sleep(100);
    expect(count(registry)).toBe(1);
  });

  test("a stop then start during a tick leaves exactly one loop", async () => {
    const oldRegistry = {} as ExecutorRegistry;
    const newRegistry = {} as ExecutorRegistry;
    const gate = deferred();
    blockFirstTick = gate.promise;

    startWaitPoller(oldRegistry, 1);
    await waitUntil(
      () => count(oldRegistry) === 1,
      () => "the old poller never ran its first tick",
    );
    stopWaitPoller();
    startWaitPoller(newRegistry, 1);
    gate.resolve();

    await waitUntil(
      () => count(newRegistry) >= 3,
      () => "the new poller is not ticking",
    );
    await Bun.sleep(100);
    expect(count(oldRegistry)).toBe(1);

    // The surviving loop is the one the next stop reaches. A tick already past
    // getDueWaitStates may still finish its resume.
    stopWaitPoller();
    const afterStop = count(newRegistry);
    await Bun.sleep(100);
    expect(count(newRegistry)).toBeLessThanOrEqual(afterStop + 1);
  });
});
