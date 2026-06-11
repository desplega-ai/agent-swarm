export type LogRole = "user" | "assistant" | "system";

export interface SessionLogRecord {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
}

export interface DecodedRecord {
  rec: SessionLogRecord;
  fileIndex: number;
  event: unknown;
  parseError?: string;
  t: number;
}

export type NormalizedKind =
  | "text"
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "file_change"
  | "result"
  | "lifecycle"
  | "parse_error"
  | "unknown";

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface NormalizedToolResult {
  id: string;
  payload: unknown;
  isError?: boolean;
}

export interface NormalizedItem {
  recId: string;
  fileIndex: number;
  iteration: number;
  lineNumber: number;
  createdAt: string;
  t: number;
  cli: string;
  kind: NormalizedKind;
  role?: LogRole;
  text?: string;
  tool?: NormalizedToolCall;
  result?: NormalizedToolResult;
  diff?: unknown;
  meta?: unknown;
  raw?: unknown;
}

export interface ParseGate {
  total: number;
  ok: number;
  bad: number;
  passed: boolean;
}

export interface PairingSummary {
  paired: number;
  orphanCalls: string[];
  orphanResults: string[];
  resultById: Map<string, NormalizedItem>;
}

export interface TranscriptParseResult {
  gate: ParseGate;
  ordered: DecodedRecord[];
  items: NormalizedItem[];
  pairing: PairingSummary;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ProviderMetaBlock {
  type: "provider_meta";
  kind:
    | "status"
    | "structured_output"
    | "internal"
    | "helper"
    | "lifecycle"
    | "result"
    | "file_change"
    | "parse_error"
    | "unknown";
  provider: string;
  data: Record<string, unknown>;
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ProviderMetaBlock;

export interface ParsedMessage {
  id: string;
  role: LogRole;
  content: ContentBlock[];
  model?: string;
  iteration: number;
  timestamp: string;
}

export interface UnwrappedResult {
  prose?: string;
  json?: unknown;
}
