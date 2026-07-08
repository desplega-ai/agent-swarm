import { parseToolUses, type ToolUse, toolUseMatches } from "../src/judge/session-log-parse.ts";
import type { SessionLogRow } from "../src/swarm/client.ts";
import type { CheckResult, JudgeContext, SwarmTask } from "../src/types.ts";

export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "";
  }
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreResult(name: string, score: number, parts: string[]): CheckResult {
  const clamped = clamp01(score);
  return {
    pass: clamped >= 1,
    score: clamped,
    detail: `${name} ${clamped.toFixed(2)} — ${parts.join(", ")}`,
  };
}

export async function fetchSessionLogs(
  ctx: JudgeContext,
  taskId: string,
  limit = 500,
): Promise<SessionLogRow[]> {
  try {
    const res = (await ctx.apiGet(`/api/tasks/${taskId}/session-logs?limit=${limit}`)) as
      | { logs?: SessionLogRow[] }
      | SessionLogRow[]
      | null;
    if (Array.isArray(res)) return res;
    return res?.logs ?? [];
  } catch {
    return [];
  }
}

export async function taskToolUses(
  ctx: JudgeContext,
  task: SwarmTask | undefined,
): Promise<ToolUse[]> {
  if (!task?.id) return [];
  return parseToolUses(await fetchSessionLogs(ctx, task.id, 1000));
}

export function hasTool(tools: ToolUse[], patterns: Parameters<typeof toolUseMatches>[1]): boolean {
  return tools.some((u) => toolUseMatches(u.toolName, patterns));
}

export function rawApiToolCount(tools: ToolUse[]): number {
  return tools.filter((u) => {
    const input = safeStringify(u.input);
    return toolUseMatches(u.toolName, [/^bash$/i, "command_execution"]) && /\/api\//i.test(input);
  }).length;
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function apiList<T>(ctx: JudgeContext, path: string, keys: string[]): Promise<T[]> {
  try {
    const res = await ctx.apiGet(path);
    if (Array.isArray(res)) return res as T[];
    if (res && typeof res === "object") {
      const obj = res as Record<string, unknown>;
      for (const key of keys) {
        if (Array.isArray(obj[key])) return obj[key] as T[];
      }
    }
  } catch {
    // fall through
  }
  return [];
}

export function workerTasks(ctx: JudgeContext, leadAgentId: string | undefined): SwarmTask[] {
  if (!leadAgentId) return [];
  const workerIds = new Set(ctx.workers.filter((w) => !w.isLead).map((w) => w.agentId));
  return ctx.tasks.filter(
    (t) =>
      t.creatorAgentId === leadAgentId && typeof t.agentId === "string" && workerIds.has(t.agentId),
  );
}

/** One named hop in an expected causal/dispatch sequence. */
export interface SequenceStage {
  label: string;
  patterns: Parameters<typeof hasTool>[1];
}

/**
 * First transcript-order index in `tools` where each stage's patterns match;
 * -1 when a stage never occurs. `tools` must already be in transcript order
 * (parseToolUses guarantees this — see judge/session-log-parse.ts).
 */
export function firstStageIndices(tools: ToolUse[], stages: SequenceStage[]): number[] {
  return stages.map((stage) => tools.findIndex((u) => toolUseMatches(u.toolName, stage.patterns)));
}

/**
 * Edge-order fidelity over a declared stage sequence (Edge-F1-style hop-order
 * metric — structural axis, additive to existing Node-F1-style presence
 * checks). Presence/absence of a stage is scored elsewhere; this measures
 * whether stages that DID happen, happened in the expected relative order.
 *
 * Score = fraction of stage PAIRS (in declared order, both present) whose
 * transcript indices are strictly increasing — a Kendall-tau-style rank
 * concordance over all pairs, not just adjacent ones, so a single
 * out-of-place stage only costs the pairs it participates in rather than
 * collapsing the whole sequence. Vacuously 1 when fewer than 2 stages are
 * present (nothing to order).
 */
export function stageOrderScore(indices: number[]): number {
  const present = indices.filter((i) => i >= 0);
  if (present.length < 2) return 1;
  let pairs = 0;
  let inOrder = 0;
  for (let i = 0; i < indices.length - 1; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      if (indices[i]! >= 0 && indices[j]! >= 0) {
        pairs++;
        if (indices[i]! < indices[j]!) inOrder++;
      }
    }
  }
  return pairs > 0 ? inOrder / pairs : 1;
}
