import { classifyClaudeThinking } from "../../utils/reasoning-events";
import type { DbExecutor } from "../db-client";

// Marks the pre-tool update among the thinking lines of `messageId` that sit
// directly before its tool_use line (classifyClaudeThinking). Reads rows from
// this transaction and from earlier POSTs alike.
export async function classifyClaudeUpdate(
  tx: DbExecutor,
  sessionId: string,
  messageId: string,
  toolLineNumber: number,
): Promise<void> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  // INDEXED BY: with `sessionId = ?` the planner would pick the sessionId
  // index and read every line of the session.
  const rows = await tx.query<{ id: string; lineNumber: number; messageId: string | null }>(
    `SELECT id, lineNumber, json_extract(content, '$.message.id') AS messageId
     FROM session_logs INDEXED BY idx_session_logs_reasoning
     WHERE reasoningChars IS NOT NULL AND createdAt >= ? AND cli = 'claude' AND sessionId = ?`,
    [since, sessionId],
  );
  const byLine = new Map<number, string>();
  for (const row of rows) if (row.messageId === messageId) byLine.set(row.lineNumber, row.id);
  const runIds: string[] = [];
  for (let n = toolLineNumber - 1; byLine.has(n); n--) runIds.unshift(byLine.get(n) as string);
  const kinds = classifyClaudeThinking([
    ...runIds.map(() => ({ type: "thinking" })),
    { type: "tool_use" },
  ]);
  for (const [i, kind] of kinds.entries()) {
    const id = runIds[i];
    if (kind === "update" && id) {
      await tx.run("UPDATE session_logs SET reasoningKind = 'update' WHERE id = ?", [id]);
    }
  }
}
