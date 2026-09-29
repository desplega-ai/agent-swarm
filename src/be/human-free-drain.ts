import { drainHumanFreeReclassifyQueue, setHumanFreeQueueListener } from "./db/tasks/human-free";

/**
 * Background drain for `human_free_reclassify_queue`: the part of a large
 * subtree's human-free reclassification that did not fit in the request that
 * changed it. It runs one batch per pass and yields between passes, so no
 * pass holds the write lock or the event loop for longer than one batch.
 *
 * It wakes when a mutation queues work, and once at boot and on a slow timer to
 * pick up rows that survived a restart or a failed pass.
 */

const YIELD_MS = 25;
const IDLE_INTERVAL_MS = 60_000;

let running = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let passTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleIdle(): void {
  if (!running) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => schedulePass(0), IDLE_INTERVAL_MS);
  idleTimer.unref?.();
}

function schedulePass(delayMs: number): void {
  if (!running || passTimer) return;
  passTimer = setTimeout(() => {
    passTimer = null;
    void runPass();
  }, delayMs);
  passTimer.unref?.();
}

async function runPass(): Promise<void> {
  if (!running) return;
  try {
    const { batches, remaining } = await drainHumanFreeReclassifyQueue({ maxBatches: 1 });
    if (batches > 0 && remaining > 0) {
      schedulePass(YIELD_MS);
      return;
    }
  } catch (err) {
    console.error(
      "[human-free-drain] batch failed, retrying later:",
      err instanceof Error ? err.message : String(err),
    );
  }
  scheduleIdle();
}

export function startHumanFreeDrain(): void {
  if (running) return;
  running = true;
  setHumanFreeQueueListener(() => schedulePass(0));
  schedulePass(0);
}

export function stopHumanFreeDrain(): void {
  running = false;
  setHumanFreeQueueListener(undefined);
  if (idleTimer) clearTimeout(idleTimer);
  if (passTimer) clearTimeout(passTimer);
  idleTimer = null;
  passTimer = null;
}
