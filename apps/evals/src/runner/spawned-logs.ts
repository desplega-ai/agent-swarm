import type { SessionLogRow } from "../swarm/client.ts";
import type { SwarmTask } from "../types.ts";

/**
 * Session logs of the runtime-spawned tasks (lead child tasks, follow-ups,
 * wake-ups, resumes). `raw-session-logs` covers only the upfront tasks, so
 * post-hoc counters that score every run task (scripts/toolmap-compare.ts)
 * read this artifact too. Stored as kind `meta` so the transcript viewer,
 * which takes the first `raw-session-logs` artifact, stays unchanged.
 */
export const SPAWNED_LOGS_ARTIFACT = "spawned-session-logs.json";

const MAX_CONTENT = 2_000_000;

export interface SpawnedLogs {
  /** Tasks whose logs were fetched (rows may be empty: a task that never ran). */
  taskIds: string[];
  /** Tasks whose log fetch failed: their evidence is missing. */
  failedTaskIds: string[];
  /** Rows were dropped to fit the artifact cap. */
  truncated: boolean;
  rows: SessionLogRow[];
}

/** Fetch the logs of every run task not in `covered` (the upfront set). */
export async function collectSpawnedLogs(
  tasks: SwarmTask[],
  covered: ReadonlySet<string>,
  getSessionLogs: (taskId: string) => Promise<SessionLogRow[]>,
): Promise<SpawnedLogs> {
  const ids = tasks
    .filter((t) => t.id && !covered.has(t.id) && t.origin !== "seed")
    .map((t) => t.id);
  const fetched = await Promise.all(
    ids.map((id) =>
      getSessionLogs(id).then(
        (rows) => ({ id, rows }),
        () => ({ id, rows: null }),
      ),
    ),
  );
  return {
    taskIds: fetched.filter((f) => f.rows !== null).map((f) => f.id),
    failedTaskIds: fetched.filter((f) => f.rows === null).map((f) => f.id),
    truncated: false,
    rows: fetched.flatMap((f) => f.rows ?? []),
  };
}

/** Artifact content. Over the cap the rows are dropped and `truncated` is set. */
export function serializeSpawnedLogs(logs: SpawnedLogs, redact: (s: string) => string): string {
  const content = redact(JSON.stringify(logs));
  return content.length <= MAX_CONTENT
    ? content
    : redact(JSON.stringify({ ...logs, truncated: true, rows: [] }));
}

/** Parse the artifact; null when it does not hold the expected shape. */
export function parseSpawnedLogs(content: string): SpawnedLogs | null {
  try {
    const v = JSON.parse(content) as Partial<SpawnedLogs>;
    return Array.isArray(v.taskIds) &&
      Array.isArray(v.failedTaskIds) &&
      Array.isArray(v.rows) &&
      typeof v.truncated === "boolean"
      ? (v as SpawnedLogs)
      : null;
  } catch {
    return null;
  }
}
