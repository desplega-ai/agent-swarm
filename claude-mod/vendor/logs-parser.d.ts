// Types for logs-parser.js, the bundle of apps/ui/src/logs-parser. Only what the
// mod uses; the source of truth is apps/ui/src/logs-parser/types.ts.

export type SessionLogRecord = {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
};

export type NormalizedItem = {
  recId: string;
  kind:
    | "text"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "file_change"
    | "result"
    | "lifecycle"
    | "parse_error"
    | "unknown";
  role?: "user" | "assistant" | "system";
  text?: string;
  tool?: { id: string; name: string; input: unknown };
  result?: { id: string; payload: unknown; isError?: boolean };
  status?: "running" | "completed" | "failed";
  t: number;
};

export function normalizeSessionLogs(logs: SessionLogRecord[]): { items: NormalizedItem[] };
export function resultPayloadText(payload: unknown): string;
