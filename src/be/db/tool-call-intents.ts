import type { ToolCallIntentRow } from "@desplega/storage";
import type { ToolCallIntent } from "../../types";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getStorage } from "../storage";

/** Cap on the stored argument summary: the preamble shows 200 chars of it. */
const MAX_ARGS_SUMMARY_CHARS = 500;
/** Cap on the intents one task lists. */
const MAX_LISTED_INTENTS = 100;

function toIntent(row: ToolCallIntentRow): ToolCallIntent {
  return { ...row, argsSummary: row.argsSummary ?? undefined, agentId: row.agentId ?? undefined };
}

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
  const row = await getStorage().repos.sessions.insertToolCallIntent({
    id: crypto.randomUUID(),
    taskId: input.taskId,
    agentId: input.agentId,
    toolCallId: input.toolCallId,
    toolName: scrubSecrets(input.toolName),
    argsSummary,
  });
  if (!row) throw new Error("tool call intent vanished after insert");
  return toIntent(row);
}

/** The call finished: its intent is no longer evidence of anything. */
export async function clearToolCallIntent(taskId: string, toolCallId: string): Promise<boolean> {
  return (await getStorage().repos.sessions.deleteToolCallIntent(taskId, toolCallId)) > 0;
}

/** Calls of a task that started and never reported back, oldest first. */
export async function listToolCallIntents(taskId: string): Promise<ToolCallIntent[]> {
  const rows = await getStorage().repos.sessions.listToolCallIntents(taskId, MAX_LISTED_INTENTS);
  return rows.map(toIntent);
}
