import type { ManagedBus } from "@desplega/storage";
import { getScriptRun } from "../db";
import { getStorage } from "../storage";

const bootId = crypto.randomUUID();

let current: ManagedBus | undefined;
let unsubscribe: (() => void) | undefined;

/** Register before accepting launches, so every launch gets a delivery row. */
export function startDurableBus(start: (run: NonNullable<Awaited<ReturnType<typeof getScriptRun>>>) => Promise<void>): void {
  const storage = getStorage();
  if (!storage.capabilities.scriptRunners || current) return;
  current = storage.executionBus;
  unsubscribe = current?.subscribe(
    "script.job.requested",
    "script-dispatcher",
    async ({ runId, deferredByBootId }) => {
      if (deferredByBootId === bootId) return;
      const run = await getScriptRun(runId);
      // The supervisor claims the unowned row before it mints a broker credential.
      if (!run || run.status !== "running" || run.pid || run.ownerId) return;
      await start(run);
    },
    { delivery: "durable" },
  );
  current?.start();
}

export async function publishDurableRunRequested(runId: string, deferred = false): Promise<void> {
  const storage = getStorage();
  if (storage.capabilities.scriptRunners) {
    if (process.env.NODE_ENV === "test" && process.env.E2E_BUS_CRASH_AFTER_LAUNCH === "true") {
      storage.afterCommit(() => process.exit(86));
    }
    await storage.executionBus?.publish("script.job.requested", {
      runId,
      ...(deferred ? { deferredByBootId: bootId } : {}),
    });
    if (process.env.NODE_ENV === "test" && process.env.E2E_BUS_ROLLBACK_LAUNCH === "true") {
      throw new Error("Test bus launch rollback");
    }
  }
}

export async function stopDurableBus(): Promise<void> {
  await current?.stop();
  unsubscribe?.();
  unsubscribe = undefined;
  current = undefined;
}
