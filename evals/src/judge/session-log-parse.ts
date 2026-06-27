import type { SessionLogRow } from "../swarm/client.ts";

/**
 * One tool invocation extracted from a raw harness session-log row. Provider-
 * agnostic: the parser normalizes Claude / Codex / pi-opencode `content` shapes
 * onto this single record so deterministic checks (e.g. the delegation rubric's
 * "did the lead query the tasks API itself?" / Plan B's tool-error rate) can
 * reason about tool usage without knowing which harness produced the session.
 */
export interface ToolUse {
  /** Task the session-log row belongs to (when the source row carried one). */
  taskId?: string;
  /** Normalized tool name, e.g. "Bash", "mcp__agent-swarm__send-task", "get-tasks". */
  toolName: string;
  /** Tool-call input/arguments object (best-effort; `{}` when none present). */
  input: unknown;
  /**
   * True when the matching tool RESULT reported an error (Claude
   * `tool_result.is_error`, Codex failed `command_execution`/`mcp_tool_call`,
   * opencode `message.part.updated` tool part with `state.status === "error"`).
   * Undefined when no result was seen / the provider gives no error signal.
   */
  isError?: boolean;
}

/** Narrowed view of one parsed JSONL line — every field optional/unknown. */
type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

/**
 * Extract every `tool_use` from a set of raw session-log rows across the eval
 * roster's providers. Malformed JSON, non-tool lines, and unrecognized shapes
 * are skipped — this function NEVER throws (a single bad row must not blow up a
 * deterministic check that grades an entire attempt).
 *
 * Shapes covered (source-of-truth in the adapters):
 *   - Claude stream-json — `{type:"assistant", message.content[].type==="tool_use"}`
 *     with `name`/`input`; results via a later `{type:"user", message.content[]
 *     .type==="tool_result", is_error, tool_use_id}` line. See
 *     src/providers/claude-adapter.ts:800-811.
 *   - Codex — the adapter mirrors every raw SDK ThreadEvent as `raw_log` JSONL,
 *     so a row is `{type:"item.started"|"item.completed", item:{...}}`. Tool
 *     items are `command_execution` / `file_change` / `mcp_tool_call` /
 *     `web_search` (src/providers/codex-adapter.ts:644-653,712-763). Error =
 *     a completed `command_execution` with non-zero `exit_code`/failed `status`
 *     or an `mcp_tool_call` with `status==="failed"`.
 *   - pi — shares the Claude-style `{type:"assistant"|"user",
 *     message.content[]}` envelope (a `part`/`parts` fallback is tolerated).
 *   - opencode — does NOT use the Claude envelope. It emits native events:
 *     `{type:"tool_start", toolCallId, toolName, args}` (note: `args` is empty
 *     `{}` at start in practice), `{type:"tool_end", toolCallId, toolName,
 *     result}` (no error field — the swarm opencode adapter only fires tool_end
 *     on a `completed` part and never propagates an error flag), and
 *     `{type:"message.part.updated", properties.part}` where a tool part is
 *     `{type:"tool", tool, callID, state:{status, input, output, error?}}`. The
 *     part-updates carry the RICH input and the only explicit error signal
 *     (`state.status === "error"`). All three reference the same call id, so we
 *     dedupe by it and emit ONE ToolUse per call — see the opencode branch.
 *     See src/providers/opencode-adapter.ts:449-489.
 */
export function parseToolUses(logRows: SessionLogRow[]): ToolUse[] {
  const uses: ToolUse[] = [];
  /** tool_use_id → index into `uses`, so a later tool_result can backfill isError. */
  const byCallId = new Map<string, number>();

  for (const row of logRows) {
    let parsed: Json | undefined;
    try {
      parsed = asObject(JSON.parse(row.content));
    } catch {
      continue; // non-JSON / truncated line — skip, never throw
    }
    if (!parsed) continue;
    const taskId = row.taskId || undefined;

    try {
      collectFromLine(parsed, taskId, uses, byCallId);
    } catch {
      // Any unexpected shape inside a recognized envelope — skip this row.
    }
  }
  return uses;
}

function collectFromLine(
  parsed: Json,
  taskId: string | undefined,
  uses: ToolUse[],
  byCallId: Map<string, number>,
): void {
  const type = typeof parsed.type === "string" ? parsed.type : undefined;

  // ---- Claude / pi / opencode: assistant + user content blocks ----
  if (type === "assistant" || type === "user") {
    const message = asObject(parsed.message);
    const blocks =
      (message && Array.isArray(message.content) ? message.content : undefined) ??
      (Array.isArray(parsed.content) ? parsed.content : undefined) ??
      // pi/opencode occasionally nest under `part`/`parts`.
      (message && Array.isArray(message.parts) ? message.parts : undefined) ??
      (Array.isArray(parsed.parts) ? parsed.parts : undefined);
    if (!blocks) return;
    for (const raw of blocks) {
      const block = asObject(raw);
      if (!block) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        const idx = uses.push({ taskId, toolName: block.name, input: block.input ?? {} }) - 1;
        if (typeof block.id === "string") byCallId.set(block.id, idx);
      } else if (block.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const isError = block.is_error === true;
        if (callId && byCallId.has(callId)) {
          const idx = byCallId.get(callId);
          if (idx !== undefined && uses[idx]) uses[idx].isError = isError;
        }
      }
    }
    return;
  }

  // ---- Codex: raw SDK ThreadEvent mirrored as raw_log ----
  if (type === "item.started" || type === "item.completed") {
    const item = asObject(parsed.item);
    if (!item) return;
    const tool = codexToolFromItem(item);
    if (!tool) return;
    if (type === "item.started") {
      uses.push({ taskId, toolName: tool.toolName, input: tool.input });
    } else {
      // item.completed — record the terminal state, carrying its error signal.
      uses.push({ taskId, toolName: tool.toolName, input: tool.input, isError: tool.isError });
    }
    return;
  }

  // ---- opencode: native tool_start / tool_end / message.part.updated ----
  //
  // opencode does NOT use the Claude envelope. The same tool call surfaces in up
  // to three rows that all share one call id, so we dedupe by it (keyed in the
  // same `byCallId` map the Claude branch uses — opencode ids are `call_*`,
  // Claude's are `toolu_*`, so they never collide) and keep ONE ToolUse per call
  // with isError resolved — preferable for downstream tool-error-rate counting.
  //
  //   - tool_start  : seeds the ToolUse (name + `args`, which is usually `{}`).
  //   - part-update : type:"tool" parts carry the RICH `state.input` and the
  //                   only explicit error signal (`state.status === "error"`);
  //                   we upsert/enrich and prefer this input over an empty `args`.
  //   - tool_end    : confirms terminal state; the swarm adapter attaches no
  //                   error field, so it only creates the ToolUse if unseen.
  if (type === "tool_start" || type === "tool_end") {
    const callId = typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined;
    const toolName = typeof parsed.toolName === "string" ? parsed.toolName : undefined;
    if (!toolName) return;
    upsertOpencodeTool(
      uses,
      byCallId,
      callId,
      { taskId, toolName, input: parsed.args },
      // tool_end may carry an explicit error field in a future build; default false.
      type === "tool_end" ? opencodeErrorFlag(parsed) : undefined,
    );
    return;
  }

  if (type === "message.part.updated") {
    const props = asObject(parsed.properties);
    const part = props && asObject(props.part);
    if (!part || part.type !== "tool") return;
    const callId =
      typeof part.callID === "string"
        ? part.callID
        : typeof part.id === "string"
          ? part.id
          : undefined;
    const toolName = typeof part.tool === "string" ? part.tool : undefined;
    if (!toolName) return;
    const state = asObject(part.state);
    const status = state && typeof state.status === "string" ? state.status : undefined;
    // Only the part-update carries the rich input; skip the empty `{}` seen on
    // the initial `pending` part so we don't clobber a richer input later.
    const richInput =
      state && asObject(state.input) && Object.keys(asObject(state.input) ?? {}).length > 0
        ? state.input
        : undefined;
    // isError is known only once the part reaches a terminal status.
    const isError =
      status === "error" || (state ? state.error != null : false)
        ? true
        : status === "completed"
          ? false
          : undefined;
    upsertOpencodeTool(uses, byCallId, callId, { taskId, toolName, input: richInput }, isError);
    return;
  }
}

/**
 * Upsert ONE ToolUse per opencode call id. Creates on first sight; on later rows
 * for the same id, enriches the input (only when the new row carries a non-empty
 * one) and backfills isError (only when newly known) — mirroring how the Claude
 * branch backfills `is_error` onto an existing ToolUse via `tool_use_id`.
 */
function upsertOpencodeTool(
  uses: ToolUse[],
  byCallId: Map<string, number>,
  callId: string | undefined,
  seed: { taskId: string | undefined; toolName: string; input: unknown },
  isError: boolean | undefined,
): void {
  const existingIdx = callId !== undefined ? byCallId.get(callId) : undefined;
  if (existingIdx !== undefined && uses[existingIdx]) {
    const use = uses[existingIdx];
    if (hasInput(seed.input)) use.input = seed.input;
    if (isError !== undefined) use.isError = isError;
    return;
  }
  const idx =
    uses.push({
      taskId: seed.taskId,
      toolName: seed.toolName,
      input: hasInput(seed.input) ? seed.input : {},
      ...(isError !== undefined ? { isError } : {}),
    }) - 1;
  if (callId !== undefined) byCallId.set(callId, idx);
}

/** A tool input is "present" when it's a non-empty object (opencode `args` is `{}`). */
function hasInput(input: unknown): boolean {
  const obj = asObject(input);
  return obj !== undefined && Object.keys(obj).length > 0;
}

/** Best-effort error flag on an opencode native event (none today; future-proof). */
function opencodeErrorFlag(parsed: Json): boolean | undefined {
  if (parsed.isError === true || parsed.error != null) return true;
  if (typeof parsed.status === "string") return parsed.status === "error";
  return undefined;
}

/** Map a Codex SDK ThreadItem onto a normalized tool name + input + error flag. */
function codexToolFromItem(
  item: Json,
): { toolName: string; input: unknown; isError?: boolean } | undefined {
  const itemType = typeof item.type === "string" ? item.type : undefined;
  switch (itemType) {
    case "command_execution": {
      const status = typeof item.status === "string" ? item.status : undefined;
      const exit = typeof item.exit_code === "number" ? item.exit_code : undefined;
      const isError = status === "failed" || (exit !== undefined && exit !== 0);
      return { toolName: "bash", input: { command: item.command }, isError };
    }
    case "file_change":
      return { toolName: "Edit", input: { changes: item.changes } };
    case "mcp_tool_call": {
      const status = typeof item.status === "string" ? item.status : undefined;
      return {
        toolName: typeof item.tool === "string" ? item.tool : "mcp_tool_call",
        input: { server: item.server, tool: item.tool, arguments: item.arguments },
        isError: status === "failed",
      };
    }
    case "web_search":
      return { toolName: "WebSearch", input: { query: item.query } };
    default:
      return undefined;
  }
}

/**
 * Match a tool name against one or more patterns. A string pattern matches when
 * the tool name CONTAINS it (so the bare swarm tool slug `send-task` matches the
 * MCP-prefixed `mcp__agent-swarm__send-task`, and vice-versa); a RegExp is
 * tested directly. Case-insensitive for string patterns.
 */
export function toolUseMatches(name: string, patterns: Array<string | RegExp>): boolean {
  const lower = name.toLowerCase();
  return patterns.some((p) =>
    typeof p === "string" ? lower.includes(p.toLowerCase()) : p.test(name),
  );
}
