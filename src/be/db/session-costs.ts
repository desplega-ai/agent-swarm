import { chatgptSubscriptionModelId } from "@desplega/model-catalog";
import type { SessionCostRow } from "@desplega/storage";
import {
  type ProviderName,
  type SessionCost,
  type SessionCostKind,
  type SessionCostModelBreakdown,
  SessionCostModelBreakdownSchema,
  type SessionCostSource,
} from "../../types";
import { getStorage } from "../storage";

export type { SessionCostRow } from "@desplega/storage";

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
    harness: row.harness as ProviderName | null,
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
  const repo = getStorage().repos.sessions;
  return getStorage().transaction(async () => {
    const id = input.id ?? crypto.randomUUID();
    // Taskless triggers register a synthetic ID that has no task row.
    const active = await repo.findActiveSessionIdentity(input.sessionId);
    if (active && (active.agentId !== input.agentId || active.taskId !== (input.taskId ?? null))) {
      throw new SessionCostConflictError("Session cost identity conflicts with an active session.");
    }
    const existing = await repo.findSessionCostByIdOrSession(id, input.sessionId);
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
    await repo.insertSessionCost({
      id,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      agentId: input.agentId,
      totalCostUsd: input.totalCostUsd,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? null,
      cacheWriteTokens: input.cacheWriteTokens ?? null,
      reasoningOutputTokens,
      thinkingTokens,
      durationMs: input.durationMs,
      numTurns: input.numTurns,
      // Cost rows group by the underlying model, while task configuration and
      // session logs retain the pi route used to select credentials.
      model: chatgptSubscriptionModelId(input.model)?.toLowerCase() ?? input.model,
      isError: input.isError === true,
      costSource,
      harnessCostUsd: input.harnessCostUsd ?? null,
      cacheWrite5mTokens: input.cacheWrite5mTokens ?? null,
      cacheWrite1hTokens: input.cacheWrite1hTokens ?? null,
      modelBreakdown: input.modelBreakdown
        ? JSON.stringify(
            input.modelBreakdown.map((entry) => ({
              ...entry,
              model: chatgptSubscriptionModelId(entry.model)?.toLowerCase() ?? entry.model,
            })),
          )
        : null,
      credentialKeyType: input.credentialKeyType ?? null,
      credentialKeySuffix: input.credentialKeySuffix ?? null,
      harness: input.harness ?? null,
      kind: input.kind ?? "harness",
    });

    const row = await repo.findSessionCostById(id);
    if (!row) throw new Error("Session cost record is missing after insertion.");
    return { cost: rowToSessionCost(row), created: true };
  });
}
