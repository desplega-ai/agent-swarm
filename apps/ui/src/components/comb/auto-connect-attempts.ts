// The automatic connect attempts of this page load, shared by every caller
// (the Comb card, the `/setup` step, a StrictMode remount) and by the agent-fs
// context, which reads the settled outcome so links stop opening Comb when
// the browser could not connect. No React and no agent-fs context import, so
// the context can use it without an import cycle.

import type { AutoConnectOutcome } from "./connect-flow";

const attempts = new Map<string, Promise<AutoConnectOutcome>>();
const settled = new Map<string, AutoConnectOutcome>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** One attempt per swarm, agent-fs endpoint, and dashboard user. */
export function autoConnectRunKey(
  apiUrl: string,
  endpoint: string | null,
  userId: string | null,
): string | null {
  return endpoint ? `${apiUrl}|${endpoint}|${userId ?? ""}` : null;
}

export function currentAttempt(runKey: string): Promise<AutoConnectOutcome> | undefined {
  return attempts.get(runKey);
}

/** Record a new attempt for `runKey`. Its outcome counts only while it is the latest. */
export function startAttempt(
  runKey: string,
  run: () => Promise<AutoConnectOutcome>,
): Promise<AutoConnectOutcome> {
  const attempt = run();
  attempts.set(runKey, attempt);
  if (settled.delete(runKey)) notify();
  void attempt.then((outcome) => {
    if (attempts.get(runKey) !== attempt) return;
    settled.set(runKey, outcome);
    notify();
  });
  return attempt;
}

/** The latest settled outcome for `runKey`. Null while none has settled. */
export function settledOutcome(runKey: string | null): AutoConnectOutcome | null {
  return runKey ? (settled.get(runKey) ?? null) : null;
}

export function subscribeSettled(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function _resetAutoConnectAttemptsForTests(): void {
  attempts.clear();
  settled.clear();
  notify();
}
