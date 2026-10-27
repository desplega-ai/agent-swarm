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
  | "call_usage"
  | "parse_error"
  | "unknown";

/**
 * Token usage of one LLM call. `promptTokens` is the whole request:
 * uncached input + cache read + cache write, whatever the harness counts.
 */
export interface CallUsage {
  callId: string;
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** A sub-agent made the call (claude `parent_tool_use_id`). */
  sidechain: boolean;
  harness: "claude" | "codex" | "opencode" | "pi";
  /**
   * Where the harness logs the usage: on the call's first output line
   * (`start`: claude, pi) or after the call's output (`end`: codex, opencode).
   */
  reportedAt: "start" | "end";
}

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
  usage?: CallUsage;
  /** The Agent/Task call that spawned the sub-agent which emitted this item (claude). */
  parentToolUseId?: string;
  /** Extra source-row ids aggregated into this item (e.g. opencode stream deltas). */
  coveredRecIds?: string[];
  /** Lifecycle state for items merged across started/completed events by id (e.g. codex unknown items). */
  status?: "running" | "completed" | "failed";
  /** Wall-clock span from the started to the terminal event, set once a merged item reaches status. */
  durationMs?: number;
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
  /** Set when a sub-agent emitted this message: the id of the call that spawned it. */
  parentToolUseId?: string;
}

export interface UnwrappedResult {
  prose?: string;
  json?: unknown;
}
