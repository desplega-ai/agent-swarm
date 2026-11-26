/**
 * Request-scoped memo for `getTaskById` and `getAgentById`. One HTTP request (MCP
 * tool calls included: `POST /mcp` runs inside the same handler) re-reads the same
 * task and agent rows many times, mostly in the Slack render-v2 path. Inside a
 * scope a repeat read reuses the first read; outside a scope nothing changes.
 *
 * Freshness: every write statement that touches `agent_tasks` (or `agents`, or
 * `runtime_pools` through its ON DELETE SET NULL) bumps a process-wide epoch for
 * that table, from any request or background loop. A memo entry read under an
 * older epoch is a miss. A write inside a transaction bumps again at COMMIT, before
 * the transaction resolves, because a pooled Postgres read can still see the old
 * row until then (src/be/storage-root.ts). Reads
 * inside a transaction skip the memo: they can see uncommitted rows. Entries also
 * expire after MEMO_TTL_MS, so a request that polls a row (a long-poll loop)
 * still sees writes this process did not make.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getStorage } from "./storage";
import { isWriteStatement } from "./write-stats";

const MEMO_TTL_MS = 250;
// shortcut: a scope that a background loop inherits keeps at most this many ids
// per kind (the map is cleared when full); upgrade to an LRU if a loop needs more.
const MAX_ENTRIES = 1_000;

// "slack" (slack_messages) is never memoized here: it only keeps a write epoch for requestMemoEpoch.
type Kind = "task" | "agent" | "slack";
type Entry = { epoch: number; at: number; value: Promise<unknown> };
type Scope = Record<Kind, Map<string, Entry>> & { hits: number; misses: number };

const scopes = new AsyncLocalStorage<Scope>();
const epochs: Record<Kind, number> = { task: 0, agent: 0, slack: 0 };

/** Run `fn` with a fresh memo scope: one per HTTP request. */
export function withRequestMemo<T>(fn: () => Promise<T>): Promise<T> {
  return scopes.run(
    { task: new Map(), agent: new Map(), slack: new Map(), hits: 0, misses: 0 },
    fn,
  );
}

/** Reads served from (hits) and missed by (misses) the current scope's memo. */
export function requestMemoStats(): { hits: number; misses: number } | undefined {
  const scope = scopes.getStore();
  return scope && { hits: scope.hits, misses: scope.misses };
}

/** Memoize `load()` for `id` in the current request scope. Each caller gets its own copy. */
export async function memoizedRead<T>(kind: Kind, id: string, load: () => Promise<T>): Promise<T> {
  const scope = scopes.getStore();
  if (!scope || getStorage().inTransaction()) return load();
  const map = scope[kind];
  const now = performance.now();
  let entry = map.get(id);
  if (entry && entry.epoch === epochs[kind] && now - entry.at < MEMO_TTL_MS) {
    scope.hits += 1;
  } else {
    scope.misses += 1;
    if (map.size >= MAX_ENTRIES) map.clear();
    // The epoch is taken before the read starts, so a write that lands during the read invalidates it.
    entry = { epoch: epochs[kind], at: now, value: load() };
    map.set(id, entry);
  }
  const current = entry;
  try {
    return structuredClone((await current.value) as T);
  } catch (err) {
    if (map.get(id) === current) map.delete(id);
    throw err;
  }
}

/** The memo kinds a statement writes, or none for a read or an unrelated table. */
export function requestMemoKindsWritten(sql: string): Kind[] {
  if (!isWriteStatement(sql)) return [];
  const kinds: Kind[] = [];
  if (/\bagent_tasks\b/i.test(sql)) kinds.push("task");
  if (/\b(agents|runtime_pools)\b/i.test(sql)) kinds.push("agent");
  if (/\bslack_messages\b/i.test(sql)) kinds.push("slack");
  return kinds;
}

/**
 * Bumped by every write to the kind's table in this process. A caller that keeps
 * rows past one read compares it to the value taken before that read: equal means
 * this process wrote nothing since.
 */
export function requestMemoEpoch(kind: Kind): number {
  return epochs[kind];
}

export function invalidateRequestMemo(kinds: readonly Kind[]): void {
  for (const kind of kinds) epochs[kind] += 1;
}
