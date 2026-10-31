import type { RequestComposition, RequestCompositionPart } from "../../types";
import { getKv, upsertKv } from "../db";
import { getDbClient } from "./runtime";

type RequestCompositionRow = Omit<RequestComposition, "parts"> & { parts: string };

export interface CreateRequestCompositionInput {
  taskId: string;
  agentId: string;
  sessionId: string;
  provider: string;
  model?: string;
  source: RequestComposition["source"];
  parts: RequestCompositionPart[];
  tokenRatio?: number;
}

/**
 * Manifests kept per task. A session writes seq 0 plus one row per change of
 * its static parts, so a real task stays far below this. The cap bounds both
 * the table growth from one task and the GET read, which returns at most this
 * many rows.
 */
export const MAX_REQUEST_COMPOSITIONS_PER_TASK = 100;

/**
 * Store a manifest as the session's next `seq`. The MAX + 1 read runs in the
 * same immediate transaction as the insert, so two posts for one session
 * cannot claim the same seq. Returns null, and stores nothing, once the task
 * holds MAX_REQUEST_COMPOSITIONS_PER_TASK manifests.
 */
export async function createRequestComposition(
  input: CreateRequestCompositionInput,
): Promise<RequestComposition | null> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const staticEstTokens = input.parts.reduce((sum, part) => sum + part.estTokens, 0);
  const tokenRatio = input.tokenRatio ?? 1;

  const seq = await getDbClient().transaction(async (tx) => {
    const stored = await tx.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM request_composition WHERE taskId = ?",
      [input.taskId],
    );
    if ((stored?.count ?? 0) >= MAX_REQUEST_COMPOSITIONS_PER_TASK) return null;
    const last = await tx.get<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM request_composition WHERE sessionId = ?",
      [input.sessionId],
    );
    const next = last?.seq == null ? 0 : last.seq + 1;
    await tx.run(
      `INSERT INTO request_composition
         (id, taskId, agentId, sessionId, seq, provider, model, source, parts, staticEstTokens, tokenRatio, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.taskId,
        input.agentId,
        input.sessionId,
        next,
        input.provider,
        input.model ?? null,
        input.source,
        JSON.stringify(input.parts),
        staticEstTokens,
        tokenRatio,
        createdAt,
      ],
    );
    return next;
  });
  if (seq === null) return null;

  return {
    id,
    taskId: input.taskId,
    agentId: input.agentId,
    sessionId: input.sessionId,
    seq,
    provider: input.provider,
    model: input.model ?? null,
    source: input.source,
    parts: input.parts,
    staticEstTokens,
    tokenRatio,
    createdAt,
  };
}

/** The manifests of a task, oldest session first, at most `limit` rows. */
export async function getRequestCompositionsByTask(
  taskId: string,
  limit = MAX_REQUEST_COMPOSITIONS_PER_TASK,
): Promise<RequestComposition[]> {
  const rows = await getDbClient().query<RequestCompositionRow>(
    `SELECT id, taskId, agentId, sessionId, seq, provider, model, source, parts, staticEstTokens, tokenRatio, createdAt
       FROM request_composition WHERE taskId = ? ORDER BY createdAt ASC, seq ASC LIMIT ?`,
    [taskId, limit],
  );
  return rows.map((row) => ({ ...row, parts: JSON.parse(row.parts) as RequestCompositionPart[] }));
}

/** The session's newest worker-posted manifest, which a hook manifest extends. */
export async function getLatestWorkerComposition(
  sessionId: string,
): Promise<RequestComposition | null> {
  const row = await getDbClient().get<RequestCompositionRow>(
    `SELECT id, taskId, agentId, sessionId, seq, provider, model, source, parts, staticEstTokens, tokenRatio, createdAt
       FROM request_composition WHERE sessionId = ? AND source = 'worker'
       ORDER BY seq DESC LIMIT 1`,
    [sessionId],
  );
  return row ? { ...row, parts: JSON.parse(row.parts) as RequestCompositionPart[] } : null;
}

// ─── Token ratio calibration ────────────────────────────────────────────────
//
// `estTokens = ceil(chars / 4)`; the ratio corrects it per provider. It lives
// in KV, not swarm_config: a global config write reloads every integration.

export const TOKEN_RATIO_KV_NAMESPACE = "swarm";
export const TOKEN_RATIO_MIN = 0.5;
export const TOKEN_RATIO_MAX = 2;
/** EMA weight of each new observation. */
export const TOKEN_RATIO_ALPHA = 0.2;

export type TokenRatioState = { ratio: number; samples: number };

export const tokenRatioKey = (provider: string): string =>
  `request-composition/token-ratio/${provider}`;

export function clampTokenRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(TOKEN_RATIO_MAX, Math.max(TOKEN_RATIO_MIN, ratio));
}

/**
 * One EMA step. The first observation seeds the average, so a provider is
 * calibrated after one session instead of creeping up from 1.0.
 */
export function nextTokenRatio(prev: TokenRatioState | null, observed: number): TokenRatioState {
  const obs = clampTokenRatio(observed);
  if (!prev || prev.samples <= 0) return { ratio: obs, samples: 1 };
  return {
    ratio: clampTokenRatio(prev.ratio + TOKEN_RATIO_ALPHA * (obs - prev.ratio)),
    samples: prev.samples + 1,
  };
}

/** Read a stored ratio. An operator may set a bare number or `{ ratio }`. */
function parseTokenRatio(value: unknown): TokenRatioState | null {
  if (typeof value === "number") return { ratio: clampTokenRatio(value), samples: 0 };
  if (value && typeof value === "object" && "ratio" in value) {
    const { ratio, samples } = value as { ratio: unknown; samples?: unknown };
    if (typeof ratio !== "number") return null;
    return {
      ratio: clampTokenRatio(ratio),
      samples: typeof samples === "number" && samples > 0 ? Math.floor(samples) : 0,
    };
  }
  return null;
}

/** The provider's current ratio, 1 until a harness hook or an operator sets it. */
export async function getTokenRatio(provider: string): Promise<number> {
  const entry = await getKv(TOKEN_RATIO_KV_NAMESPACE, tokenRatioKey(provider));
  return parseTokenRatio(entry?.value)?.ratio ?? 1;
}

/**
 * Fold one observation into the provider's EMA. Read and write share one
 * immediate transaction, so two concurrent sessions cannot drop an update.
 */
export async function recordTokenRatio(
  provider: string,
  observed: number,
): Promise<TokenRatioState> {
  return getDbClient().transaction(async () => {
    const key = tokenRatioKey(provider);
    const entry = await getKv(TOKEN_RATIO_KV_NAMESPACE, key);
    const next = nextTokenRatio(parseTokenRatio(entry?.value), observed);
    await upsertKv({
      namespace: TOKEN_RATIO_KV_NAMESPACE,
      key,
      value: { ...next, updatedAt: new Date().toISOString() },
      valueType: "json",
    });
    return next;
  });
}
