import { chatgptSubscriptionModelId } from "@desplega/model-catalog";
import {
  type ProviderName,
  type SessionCost,
  type SessionCostKind,
  type SessionCostModelBreakdown,
  SessionCostModelBreakdownSchema,
  type SessionCostSource,
} from "../../types";
import { getDbClient } from "./runtime";

/**
 * Sessions recorded before migration 307 carry no credential of their own.
 * Those legacy rows fall back to their task's credential, as usage read it
 * before 307. Newer rows keep their own, null included. Needs `t` joined.
 */
const LEGACY_CREDENTIAL_SQL =
  "(sc.credentialKeyType IS NULL AND sc.createdAt < (SELECT applied_at FROM _migrations WHERE version = 307))";
export const CREDENTIAL_TYPE_SQL = `CASE WHEN ${LEGACY_CREDENTIAL_SQL} THEN t.credentialKeyType ELSE sc.credentialKeyType END`;
export const CREDENTIAL_SUFFIX_SQL = `CASE WHEN ${LEGACY_CREDENTIAL_SQL} THEN t.credentialKeySuffix ELSE sc.credentialKeySuffix END`;

export type SessionCostRow = {
  id: string;
  sessionId: string;
  taskId: string | null;
  agentId: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  credentialKeyType: string | null;
  credentialKeySuffix: string | null;
  harness: ProviderName | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  // Migration 063 additions:
  reasoningOutputTokens: number;
  thinkingTokens: number;
  durationMs: number;
  numTurns: number | null;
  model: string;
  isError: number;
  costSource: string;
  kind: string;
  harnessCostUsd: number | null;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  modelBreakdown: string | null;
  createdAt: string;
};

export function rowToSessionCost(row: SessionCostRow): SessionCost {
  let modelBreakdown: SessionCostModelBreakdown[] | null = null;
  if (row.modelBreakdown) {
    try {
      const parsed = SessionCostModelBreakdownSchema.array().safeParse(
        JSON.parse(row.modelBreakdown),
      );
      if (parsed.success) modelBreakdown = parsed.data;
    } catch {
      // Corrupt JSON (manual edits, partial writes) must not fail the listing.
    }
  }

  return {
    id: row.id,
    sessionId: row.sessionId,
    taskId: row.taskId ?? undefined,
    agentId: row.agentId,
    credentialKeyType: row.credentialKeyType,
    credentialKeySuffix: row.credentialKeySuffix,
    harness: row.harness,
    totalCostUsd: row.totalCostUsd,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningOutputTokens: row.reasoningOutputTokens ?? 0,
    thinkingTokens: row.thinkingTokens ?? 0,
    durationMs: row.durationMs,
    numTurns: row.numTurns,
    model: row.model,
    isError: row.isError === 1,
    costSource: (row.costSource as SessionCostSource) ?? "harness",
    kind: (row.kind as SessionCostKind) ?? "harness",
    harnessCostUsd: row.harnessCostUsd,
    cacheWrite5mTokens: row.cacheWrite5mTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    modelBreakdown,
    createdAt: row.createdAt,
  };
}

export interface CreateSessionCostInput {
  credentialKeyType?: string | null;
  credentialKeySuffix?: string | null;
  harness?: ProviderName | null;
  id?: string;
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  // Migration 063 additions, adapters that have these numbers should pass
  // them; defaulting to 0 preserves the old write shape for callers that don't.
  reasoningOutputTokens?: number;
  thinkingTokens?: number;
  durationMs: number;
  // Nullable: some adapters (claude when num_turns is absent) can't honestly
  // report a turn count; we prefer null over a faked 1.
  numTurns: number | null;
  model: string;
  isError?: boolean;
  /**
   * Phase 6 (migration 063 added 'unpriced'): where `totalCostUsd` came from.
   *  - 'harness'       , value reported by the harness as-is (default).
   *  - 'pricing-table' , value recomputed by the API from `pricing` rows.
   *  - 'unpriced'      , recompute attempted but no matching pricing rows;
   *                       `totalCostUsd` is whatever the worker submitted.
   *  - 'estimated'     , fallback token counts priced at an assumed model
   *                       (amp with a failed thread export).
   */
  costSource?: SessionCostSource;
  /** Migration 320: 'system-one' for a SystemOne decision made for the task. */
  kind?: SessionCostKind;
  harnessCostUsd?: number | null;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  modelBreakdown?: SessionCostModelBreakdown[] | null;
}

export class SessionCostConflictError extends Error {}

/** Insert once. Existing session identity and attribution never change. */
export async function insertSessionCost(
  input: CreateSessionCostInput,
): Promise<{ cost: SessionCost; created: boolean }> {
  return getDbClient().transaction(async (client) => {
    const id = input.id ?? crypto.randomUUID();
    // Taskless triggers register a synthetic ID that has no task row.
    const active = await client.get<{ agentId: string; taskId: string | null }>(
      `SELECT a.agentId, t.id AS taskId FROM active_sessions a
       LEFT JOIN agent_tasks t ON t.id = a.taskId
       WHERE a.runnerSessionId = ? OR a.id = ? LIMIT 1`,
      [input.sessionId, input.sessionId],
    );
    if (active && (active.agentId !== input.agentId || active.taskId !== (input.taskId ?? null))) {
      throw new SessionCostConflictError("Session cost identity conflicts with an active session.");
    }
    const existing = await client.get<SessionCostRow>(
      "SELECT * FROM session_costs WHERE id = ? OR sessionId = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, createdAt, id LIMIT 1",
      [id, input.sessionId, id],
    );
    if (existing) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.agentId !== input.agentId ||
        existing.taskId !== (input.taskId ?? null)
      ) {
        throw new SessionCostConflictError(
          "Session cost identity conflicts with an existing record.",
        );
      }
      // Reposts return the original counters and attribution, including unknown values.
      return { cost: rowToSessionCost(existing), created: false };
    }
    const costSource: SessionCostSource = input.costSource ?? "harness";
    const reasoningOutputTokens = input.reasoningOutputTokens ?? 0;
    const thinkingTokens = input.thinkingTokens ?? 0;
    await client.run(
      `INSERT INTO session_costs (
         id, sessionId, taskId, agentId,
         totalCostUsd, inputTokens, outputTokens,
         cacheReadTokens, cacheWriteTokens,
         reasoningOutputTokens, thinkingTokens,
         durationMs, numTurns, model, isError,
         costSource, harnessCostUsd, cacheWrite5mTokens, cacheWrite1hTokens,
         modelBreakdown, credentialKeyType, credentialKeySuffix, harness, kind, createdAt
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO NOTHING`,
      [
        id,
        input.sessionId,
        input.taskId ?? null,
        input.agentId,
        input.totalCostUsd,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cacheReadTokens ?? null,
        input.cacheWriteTokens ?? null,
        reasoningOutputTokens,
        thinkingTokens,
        input.durationMs,
        input.numTurns,
        // Cost rows group by the underlying model, while task configuration and
        // session logs retain the pi route used to select credentials.
        chatgptSubscriptionModelId(input.model)?.toLowerCase() ?? input.model,
        input.isError ? 1 : 0,
        costSource,
        input.harnessCostUsd ?? null,
        input.cacheWrite5mTokens ?? null,
        input.cacheWrite1hTokens ?? null,
        input.modelBreakdown
          ? JSON.stringify(
              input.modelBreakdown.map((entry) => ({
                ...entry,
                model: chatgptSubscriptionModelId(entry.model)?.toLowerCase() ?? entry.model,
              })),
            )
          : null,
        input.credentialKeyType ?? null,
        input.credentialKeySuffix ?? null,
        input.harness ?? null,
        input.kind ?? "harness",
      ],
    );

    const row = await client.get<SessionCostRow>("SELECT * FROM session_costs WHERE id = ?", [id]);
    if (!row) throw new Error("Session cost record is missing after insertion.");
    return { cost: rowToSessionCost(row), created: true };
  });
}
