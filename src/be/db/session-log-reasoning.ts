import { classifyClaudeThinking } from "../../utils/reasoning-events";
import { getStorage } from "../storage";

// Marks the pre-tool update among the thinking lines of `messageId` that sit
// directly before its tool_use line (classifyClaudeThinking). Reads rows from
// this transaction and from earlier POSTs alike (repository calls join the
// caller's transaction).
export async function classifyClaudeUpdate(
  sessionId: string,
  messageId: string,
  toolLineNumber: number,
): Promise<void> {
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const repo = getStorage().repos.sessions;
  const rows = await repo.listClaudeReasoningLines(sessionId, since);
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
      await repo.markLogReasoningUpdate(id);
    }
  }
}
