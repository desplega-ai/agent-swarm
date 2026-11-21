import type { ToolCallIntent } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient } from "../db";

/** Cap on the stored argument summary: the preamble shows 200 chars of it. */
const MAX_ARGS_SUMMARY_CHARS = 500;

/**
 * Record that a side-effecting call is about to run. Idempotent on
 * `(taskId, toolCallId)`: a retried hook POST keeps the first row.
 */
export async function recordToolCallIntent(input: {
  taskId: string;
  agentId: string | null;
  toolCallId: string;
  toolName: string;
  argsSummary?: string;
}): Promise<ToolCallIntent> {
  const argsSummary = input.argsSummary
    ? scrubSecrets(input.argsSummary).slice(0, MAX_ARGS_SUMMARY_CHARS)
    : null;
  await getDbClient().run(
    `INSERT INTO tool_call_intents (id, taskId, agentId, toolCallId, toolName, argsSummary, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (taskId, toolCallId) DO NOTHING`,
    [
      crypto.randomUUID(),
      input.taskId,
      input.agentId,
      input.toolCallId,
      scrubSecrets(input.toolName),
      argsSummary,
      new Date().toISOString(),
    ],
  );
  const row = await getDbClient().get<ToolCallIntent>(
    "SELECT * FROM tool_call_intents WHERE taskId = ? AND toolCallId = ?",
    [input.taskId, input.toolCallId],
  );
  if (!row) throw new Error("tool call intent vanished after insert");
  return { ...row, argsSummary: row.argsSummary ?? undefined, agentId: row.agentId ?? undefined };
}

/** The call finished: its intent is no longer evidence of anything. */
export async function clearToolCallIntent(taskId: string, toolCallId: string): Promise<boolean> {
  const result = await getDbClient().run(
    "DELETE FROM tool_call_intents WHERE taskId = ? AND toolCallId = ?",
    [taskId, toolCallId],
  );
  return result.changes > 0;
}

/** Calls of a task that started and never reported back, oldest first. */
export async function listToolCallIntents(taskId: string): Promise<ToolCallIntent[]> {
  const rows = await getDbClient().query<ToolCallIntent>(
    "SELECT * FROM tool_call_intents WHERE taskId = ? ORDER BY createdAt ASC, rowid ASC LIMIT 100",
    [taskId],
  );
  return rows.map((row) => ({
    ...row,
    argsSummary: row.argsSummary ?? undefined,
    agentId: row.agentId ?? undefined,
  }));
}
