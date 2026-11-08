import { z } from "zod";
import { SessionCostModelBreakdownSchema } from "../types";
import {
  KEY_WIDE_WINDOWS,
  MODEL_SCOPED_WINDOWS,
  modelFamilyOf,
} from "../utils/model-rate-limit-windows";
import { codexWindowKey } from "../utils/provider-account-telemetry";
import { type ApiKeyStatus, getDbClient } from "./db";

const counterSchema = z.object({
  value: z.number().nullable(),
  measuredSessions: z.number().int(),
  missingSessions: z.number().int(),
});
const tokensSchema = z.object({
  uncachedInput: counterSchema,
  output: counterSchema,
  cacheRead: counterSchema,
  cacheWrite: counterSchema,
  reasoning: counterSchema,
  thinking: counterSchema,
});
export const keyWindowUsageSchema = z.object({
  statusId: z.string(),
  keyType: z.string(),
  keySuffix: z.string(),
  scope: z.string(),
  scopeId: z.string().nullable(),
  windowKey: z.string(),
  durationMins: z.number().nullable(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  dataThrough: z.string(),
  observedAt: z.string(),
  observationAgeMs: z.number(),
  modelScope: z.object({
    kind: z.enum(["account", "family", "unknown"]),
    model: z.string().nullable(),
  }),
  unavailableReason: z
    .enum(["missing_reset", "unknown_duration", "unknown_model_scope", "window_not_started"])
    .nullable(),
  usage: z
    .object({
      sessions: z.number().int(),
      errorSessions: z.number().int(),
      completedTasks: z.number().int(),
      tokens: tokensSchema,
      modelUnattributedSessions: z.number().int(),
      // This population spans the swarm, even when the request filters one key type.
      swarmUnattributedSessions: z.number().int(),
    })
    .nullable(),
});
export type KeyWindowUsage = z.infer<typeof keyWindowUsageSchema>;
type Tokens = z.infer<typeof tokensSchema>;

/** Preserve known Claude rules. Never infer duration or model scope from a label. */
export function currentKeyWindows(statuses: ApiKeyStatus[], nowMs: number): KeyWindowUsage[] {
  const result: KeyWindowUsage[] = [];
  for (const key of statuses) {
    for (const [windowKey, window] of Object.entries(key.rateLimitWindows)) {
      const resetMs = window.resetsAt === undefined ? null : window.resetsAt * 1000;
      if (resetMs !== null && (!Number.isFinite(resetMs) || resetMs <= nowMs)) continue;
      const legacyClaude = window.source ? window.source === "claude" : key.provider === "claude";
      const family = legacyClaude ? MODEL_SCOPED_WINDOWS[windowKey] : undefined;
      const durationMins =
        window.durationMins ??
        (legacyClaude
          ? windowKey === "five_hour"
            ? 300
            : windowKey === "seven_day" || family
              ? 10080
              : null
          : null);
      const accountWide = legacyClaude
        ? KEY_WIDE_WINDOWS.some((name) => name === windowKey)
        : [codexWindowKey("codex", "primary"), codexWindowKey("codex", "secondary")].includes(
            windowKey,
          );
      // Codex normalModelSlug describes a display alias, not the models charged to it.
      const modelScope: KeyWindowUsage["modelScope"] = family
        ? { kind: "family", model: family }
        : { kind: accountWide ? "account" : "unknown", model: null };
      const startMs = resetMs !== null && durationMins ? resetMs - durationMins * 60000 : null;
      const unavailableReason =
        resetMs === null
          ? "missing_reset"
          : startMs === null
            ? "unknown_duration"
            : startMs > nowMs
              ? "window_not_started"
              : modelScope.kind === "unknown"
                ? "unknown_model_scope"
                : null;
      result.push({
        statusId: key.id,
        keyType: key.keyType,
        keySuffix: key.keySuffix,
        scope: key.scope,
        scopeId: key.scopeId,
        windowKey,
        durationMins,
        startsAt: startMs === null ? null : new Date(startMs).toISOString(),
        endsAt: resetMs === null ? null : new Date(resetMs).toISOString(),
        dataThrough: new Date(Math.min(nowMs, resetMs ?? nowMs)).toISOString(),
        observedAt: window.lastSeenAt,
        observationAgeMs: Math.max(0, nowMs - Date.parse(window.lastSeenAt)),
        modelScope,
        unavailableReason,
        usage: null,
      });
    }
  }
  return result;
}

interface UsageRow {
  taskId: string | null;
  credentialKeyType: string | null;
  credentialKeySuffix: string | null;
  harness: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number;
  thinkingTokens: number;
  model: string;
  modelBreakdown: string | null;
  isError: number;
  createdAt: string;
  finishedAt: string | null;
}

const usageColumns = `sc.taskId, sc.credentialKeyType, sc.credentialKeySuffix, sc.harness,
  sc.inputTokens, sc.outputTokens, sc.cacheReadTokens, sc.cacheWriteTokens,
  sc.reasoningOutputTokens, sc.thinkingTokens, sc.model, sc.modelBreakdown,
  sc.isError, sc.createdAt`;

// Receipt rows and older completion-attribution rows are disjoint.
// Drive older rows from recent task completions, never the credential's entire history.
export const KEY_WINDOW_USAGE_SQL = `
  WITH requested_keys AS (
    SELECT json_extract(value, '$.keyType') AS keyType,
      json_extract(value, '$.keySuffix') AS keySuffix FROM json_each(?)
  )
  SELECT ${usageColumns}, CASE WHEN t.status = 'completed' THEN t.finishedAt END AS finishedAt
  FROM requested_keys k
  JOIN session_costs sc INDEXED BY idx_session_costs_credential_createdAt
    ON sc.credentialKeyType = k.keyType AND sc.credentialKeySuffix = k.keySuffix
  LEFT JOIN agent_tasks t ON t.id = sc.taskId
  WHERE sc.createdAt >= ? AND sc.createdAt < ?
  UNION ALL
  SELECT ${usageColumns}, t.finishedAt
  FROM agent_tasks t INDEXED BY idx_agent_tasks_status_finishedAt
  CROSS JOIN session_costs sc INDEXED BY idx_session_costs_taskId ON sc.taskId = t.id
  JOIN requested_keys k ON sc.credentialKeyType = k.keyType AND sc.credentialKeySuffix = k.keySuffix
  WHERE t.status = 'completed' AND t.finishedAt >= ? AND t.finishedAt < ? AND sc.createdAt < ?
  UNION ALL
  SELECT NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, 0, 0, '', NULL, 0, sc.createdAt, NULL
  FROM session_costs sc
  WHERE (sc.credentialKeyType IS NULL OR sc.credentialKeySuffix IS NULL)
    AND sc.createdAt >= ? AND sc.createdAt < ?`;

const emptyTokens = (): Tokens =>
  Object.fromEntries(
    ["uncachedInput", "output", "cacheRead", "cacheWrite", "reasoning", "thinking"].map((name) => [
      name,
      { value: null, measuredSessions: 0, missingSessions: 0 },
    ]),
  ) as Tokens;

function add(tokens: Tokens, name: keyof Tokens, value: number | null): void {
  const counter = tokens[name];
  if (value === null) counter.missingSessions++;
  else {
    counter.value = (counter.value ?? 0) + value;
    counter.measuredSessions++;
  }
}

/** One batch for all credentials and windows. The caller caches this expensive aggregation. */
export async function aggregateKeyWindowUsage(windows: KeyWindowUsage[], through: string) {
  const eligible = windows.filter(
    (w): w is KeyWindowUsage & { startsAt: string; endsAt: string; unavailableReason: null } =>
      w.unavailableReason === null && w.startsAt !== null && w.endsAt !== null,
  );
  const first = eligible[0];
  if (!first) return [];
  const start = eligible.reduce(
    (earliest, w) => (w.startsAt < earliest ? w.startsAt : earliest),
    first.startsAt,
  );
  const credentials = [
    ...new Map(
      eligible.map((w) => [
        JSON.stringify([w.keyType, w.keySuffix]),
        { keyType: w.keyType, keySuffix: w.keySuffix },
      ]),
    ).values(),
  ];
  const rows = await getDbClient().query<UsageRow>(KEY_WINDOW_USAGE_SQL, [
    JSON.stringify(credentials),
    start,
    through,
    start,
    through,
    start,
    start,
    through,
  ]);
  return eligible.map((window) => {
    const usage = {
      sessions: 0,
      errorSessions: 0,
      completedTasks: 0,
      tokens: emptyTokens(),
      modelUnattributedSessions: 0,
      swarmUnattributedSessions: 0,
    };
    const completed = new Set<string>();
    for (const row of rows) {
      const inReceiptWindow = row.createdAt >= window.startsAt && row.createdAt < through;
      if (row.credentialKeyType === null || row.credentialKeySuffix === null) {
        if (inReceiptWindow) usage.swarmUnattributedSessions++;
        continue;
      }
      if (row.credentialKeyType !== window.keyType || row.credentialKeySuffix !== window.keySuffix)
        continue;
      let parts = [
        {
          model: row.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheWriteTokens: row.cacheWriteTokens,
        },
      ];
      const scoped = window.modelScope.kind !== "account";
      if (scoped) {
        // A primary model cannot allocate mixed-model session totals to a family.
        parts = [];
        try {
          const parsed = SessionCostModelBreakdownSchema.array().safeParse(
            row.modelBreakdown ? JSON.parse(row.modelBreakdown) : null,
          );
          // A corrupt breakdown must never fall back to whole-session counters.
          parts = parsed.success ? parsed.data : [];
        } catch {
          parts = [];
        }
      }
      if (scoped) {
        const known = parts.length > 0 && parts.every((part) => part.model.length > 0);
        if (!known && inReceiptWindow) usage.modelUnattributedSessions++;
        parts = parts.filter((part) => modelFamilyOf(part.model) === window.modelScope.model);
        if (!parts.length) continue;
      }
      if (
        row.taskId &&
        row.finishedAt &&
        row.finishedAt >= window.startsAt &&
        row.finishedAt < through
      )
        completed.add(row.taskId);
      if (!inReceiptWindow) continue;
      usage.sessions++;
      usage.errorSessions += row.isError ? 1 : 0;
      const sum = (
        field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens",
      ) =>
        parts.some((part) => part[field] === null)
          ? null
          : parts.reduce((total, part) => total + (part[field] ?? 0), 0);
      const input = sum("inputTokens");
      const read = sum("cacheReadTokens");
      const knownInput = ["claude", "claude-managed", "pi", "opencode"].includes(row.harness ?? "");
      add(
        usage.tokens,
        "uncachedInput",
        row.harness === "codex"
          ? input !== null && read !== null
            ? Math.max(0, input - read)
            : null
          : knownInput
            ? input
            : null,
      );
      add(usage.tokens, "output", sum("outputTokens"));
      add(usage.tokens, "cacheRead", read);
      add(usage.tokens, "cacheWrite", sum("cacheWriteTokens"));
      // Stored zeroes predate presence tracking. Only positive measurements prove presence.
      // A model breakdown cannot allocate session-level reasoning or thinking.
      add(
        usage.tokens,
        "reasoning",
        !scoped && row.reasoningOutputTokens > 0 ? row.reasoningOutputTokens : null,
      );
      add(usage.tokens, "thinking", !scoped && row.thinkingTokens > 0 ? row.thinkingTokens : null);
    }
    usage.completedTasks = completed.size;
    return { statusId: window.statusId, windowKey: window.windowKey, dataThrough: through, usage };
  });
}
