/**
 * One mutex for every path that tears down and rebuilds the Slack app: the
 * config reload in `http/core.ts` and the socket watchdog in `app.ts`. A leaf
 * module, because `http/core.ts` imports `app.ts` (an import back would cycle).
 */
let tail: Promise<void> = Promise.resolve();
let holders = 0;

/** Run `fn` after every earlier holder has finished. */
export async function runSlackLifecycleExclusive<T>(fn: () => Promise<T>): Promise<T> {
  holders += 1;
  const previous = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await previous;
    return await fn();
  } finally {
    holders -= 1;
    release();
  }
}

/** True while a holder runs or waits. The watchdog skips its tick then. */
export function isSlackLifecycleBusy(): boolean {
  return holders > 0;
}
