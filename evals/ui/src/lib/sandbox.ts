/**
 * sandboxJson normalizer (v6 spec §0.4 — FROZEN).
 *
 * Attempts persist their sandbox blob in one of two shapes:
 *   v1 (legacy, read-only) — flat: apiSandboxId, workerSandboxId, workerAgentId, …
 *   v2 — `{ v: 2, …, workers: [...] }` (multi-worker, v6 §0.3)
 * The UI renders BOTH; normalization happens in exactly this one place. No UI
 * code outside this file may access fields on the raw `SandboxInfoJson` union
 * (ui/src/types.ts) — which is why this function deliberately takes `unknown`.
 */

export interface NormalizedWorker {
  index: number;
  /** Boot role (v7 §12) — the lead is the last workers[] entry with role "lead". Null on v1/pre-v7 rows = worker. */
  role: "lead" | "worker" | null;
  sandboxId: string;
  template: string | null;
  agentId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  version: string | null;
}

export interface NormalizedSandboxInfo {
  apiSandboxId: string;
  apiTemplate: string | null;
  apiUrl: string;
  swarmKey: string;
  domain: string | null;
  apiStartedAt: string | null;
  apiVersion: string | null;
  workers: NormalizedWorker[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function workerFromV2Entry(entry: unknown, position: number): NormalizedWorker | null {
  if (!isObject(entry)) return null;
  const sandboxId = str(entry.sandboxId);
  if (sandboxId === null) return null;
  return {
    index: typeof entry.index === "number" ? entry.index : position,
    // Distinguish the lead by role, never by position/count (v7 §12.6).
    role: entry.role === "lead" || entry.role === "worker" ? entry.role : null,
    sandboxId,
    template: str(entry.template),
    agentId: str(entry.agentId),
    startedAt: str(entry.startedAt),
    expiresAt: str(entry.expiresAt),
    version: str(entry.version),
  };
}

/**
 * v2 if `raw.v === 2` OR `Array.isArray(raw.workers)`; otherwise treated as the
 * v1 flat shape. Missing/garbage input → null (callers render the existing
 * "Sandbox info not captured" fallback).
 */
export function normalizeSandboxInfo(raw: unknown): NormalizedSandboxInfo | null {
  if (!isObject(raw)) return null;
  const apiSandboxId = str(raw.apiSandboxId);
  const apiUrl = str(raw.apiUrl);
  const swarmKey = str(raw.swarmKey);
  if (apiSandboxId === null || apiUrl === null || swarmKey === null) return null;

  const base = {
    apiSandboxId,
    apiTemplate: str(raw.apiTemplate),
    apiUrl,
    swarmKey,
    domain: str(raw.domain),
    apiStartedAt: str(raw.apiStartedAt),
    apiVersion: str(raw.apiVersion),
  };

  if (raw.v === 2 || Array.isArray(raw.workers)) {
    const entries = Array.isArray(raw.workers) ? raw.workers : [];
    const workers = entries
      .map((entry, i) => workerFromV2Entry(entry, i))
      .filter((w): w is NormalizedWorker => w !== null)
      .sort((a, b) => a.index - b.index);
    return { ...base, workers };
  }

  // v1 flat mapping (frozen): the single worker becomes workers[0].
  const workerSandboxId = str(raw.workerSandboxId);
  const workers: NormalizedWorker[] =
    workerSandboxId === null
      ? []
      : [
          {
            index: 0,
            role: null,
            sandboxId: workerSandboxId,
            template: str(raw.workerTemplate),
            agentId: str(raw.workerAgentId),
            startedAt: str(raw.workerStartedAt),
            expiresAt: str(raw.expiresAt),
            version: str(raw.workerVersion),
          },
        ];
  return { ...base, workers };
}

/** Tab/section label: "Worker" when there is exactly one, "Worker <i>" otherwise. */
export function workerLabel(index: number, workerCount: number): string {
  return workerCount === 1 ? "Worker" : `Worker ${index}`;
}

/**
 * Label for one sandbox member: the LEAD is identified by its `role`
 * (v7 §12 — never by position or count). `workerCount` counts non-lead
 * members so a 1-worker + lead roster still labels its worker plain "Worker".
 */
export function memberLabel(worker: NormalizedWorker, workerCount: number): string {
  return worker.role === "lead" ? "Lead" : workerLabel(worker.index, workerCount);
}
