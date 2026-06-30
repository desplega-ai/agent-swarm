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
