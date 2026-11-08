import { block, type SwarmExtension } from "swarm-extension";
import { z } from "zod";

export const config = z.object({});

/** MCP tools that run raw SQL. db-query is the only one today. */
const SQL_TOOLS = new Set(["db-query"]);

const manifest = {
  name: "sql-admin-only",
  description: "Blocks db-query tool calls on tasks created by a non-admin user",
  version: "1.1.0",
  runtime: "api",
  assets: { hooks: "hooks.ts" },
  config,
} as const;

/**
 * The task's creator and that user's `users.role`, the role the swarm shows for a
 * requester (for example "Alice (admin)"). RBAC roles do not work here: every user is
 * created with the RBAC `admin` role.
 */
export const CREATOR_SQL = `SELECT t.requestedByUserId, u.role
FROM agent_tasks t
LEFT JOIN users u ON u.id = t.requestedByUserId
WHERE t.id = ?`;

type Envelope = { success?: boolean; data?: { rows?: unknown[] }; rows?: unknown[] } | null;

const cell = (row: unknown, i: number, key: string): unknown =>
  Array.isArray(row) ? row[i] : (row as Record<string, unknown> | null)?.[key];

/**
 * The dispatcher fails a pre hook OPEN when it runs past
 * EXTENSION_HANDLER_TIMEOUT_MS (default 5s). Give the lookup a shorter budget so
 * a slow lookup ends in our own block, not in a silent allow.
 */
const lookupBudgetMs = (): number => {
  const raw = Number(process.env.EXTENSION_HANDLER_TIMEOUT_MS);
  const handlerMs = Number.isFinite(raw) && raw > 0 ? raw : 5_000;
  return Math.floor(handlerMs * 0.6);
};

const withDeadline = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`lookup timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const extension: SwarmExtension<typeof manifest> = (api) => {
  api.on("pre.tool.call", async (event, ctx) => {
    const tool = event.tool;
    if (!SQL_TOOLS.has(tool)) return;

    // No task context means no task creator: allow.
    const taskId = event.requestInfo?.sourceTaskId;
    if (!taskId) return;

    // Creator lookup. A failed lookup blocks this SQL call only (fail closed).
    let creator: string;
    let role: string;
    try {
      const q = (await withDeadline(
        ctx.swarm.db_query({ sql: CREATOR_SQL, params: [taskId] }),
        lookupBudgetMs(),
      )) as Envelope;
      if (q?.success === false) throw new Error("db-query lookup returned success=false");
      const row = (q?.data?.rows ?? q?.rows ?? [])[0];
      // A successful lookup with no row: the id is not a task. The runner sends a
      // random correlation id for sessions with no task (pool or channel-message
      // triggers, src/commands/runner.ts effectiveTaskId). No task means no creator:
      // allow, the same as a missing header. Errors and timeouts above still block.
      if (!row) return;
      creator = String(cell(row, 0, "requestedByUserId") ?? "");
      role = String(cell(row, 1, "role") ?? "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `${tool} is restricted to admin task creators, and the creator of task ${taskId} could not be verified (${message}).`;
      ctx.log.warn(reason, { tool, taskId });
      return block(reason);
    }

    if (!creator) return;
    if (role.trim().toLowerCase() === "admin") return;

    const reason = `${tool} is restricted to admin task creators. Task ${taskId} was created by user ${creator}, whose role is ${role ? `"${role}"` : "not set"}.`;
    ctx.log.warn(reason, { tool, taskId, requestedByUserId: creator });
    return block(reason);
  });
};

export default extension;
