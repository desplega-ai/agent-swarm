import { isRecord, resultBlockText, stringifyForDisplay, tryParseJson } from "./helpers";
import type { SessionLogRecord } from "./types";

export type SubagentRunStatus = "running" | "completed" | "failed";

export interface SubagentRun {
  id: string;
  provider: "claude" | "opencode";
  label: string;
  agentType: string;
  input: string;
  outcome?: string;
  status: SubagentRunStatus;
  startedAt: string;
  finishedAt?: string;
  durationMs: number;
  background: boolean;
  childId?: string;
  sourceRecordIds: string[];
}

interface MutableRun extends Omit<SubagentRun, "sourceRecordIds"> {
  sourceRecordIds: Set<string>;
}

function eventTime(event: Record<string, unknown>, fallback: string): string {
  return timestampValue(event.timestamp) ?? fallback;
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  return new Date(milliseconds).toISOString();
}

function durationMs(startedAt: string, finishedAt?: string): number {
  if (!finishedAt) return 0;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function displayValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = resultBlockText(value).trim();
  return text || undefined;
}

function inputText(input: Record<string, unknown>): string {
  return (
    stringField(input.prompt) ??
    stringField(input.task) ??
    stringField(input.description) ??
    stringifyForDisplay(input)
  );
}

function runLabel(input: Record<string, unknown>): string {
  return stringField(input.description) ?? stringField(input.task) ?? "Sub-agent";
}

function runType(input: Record<string, unknown>): string {
  return stringField(input.subagent_type) ?? stringField(input.agent) ?? "sub-agent";
}

function decodedLogs(logs: SessionLogRecord[]) {
  return logs
    .map((record, fileIndex) => {
      const parsed = tryParseJson(record.content);
      return parsed.ok && isRecord(parsed.value)
        ? { record, fileIndex, event: parsed.value }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => {
      const time = Date.parse(a.record.createdAt) - Date.parse(b.record.createdAt);
      if (Number.isFinite(time) && time !== 0) return time;
      const line = a.record.lineNumber - b.record.lineNumber;
      return line !== 0 ? line : a.fileIndex - b.fileIndex;
    });
}

function extractClaudeRuns(logs: SessionLogRecord[]): MutableRun[] {
  const decoded = decodedLogs(
    logs.filter((record) => record.cli === "claude" || record.cli === "claude-managed"),
  );
  const runs = new Map<string, MutableRun>();

  // Discover calls first so background lifecycle rows can correlate even when
  // persisted timestamps are tied or arrive slightly out of order.
  for (const { record, event } of decoded) {
    if (record.cli === "claude-managed" && event.type === "agent.tool_use") {
      const name = stringField(event.name);
      const id = stringField(event.id);
      if ((name === "Agent" || name === "Task") && id) {
        const input = isRecord(event.input) ? event.input : {};
        runs.set(id, {
          id,
          provider: "claude",
          label: runLabel(input),
          agentType: runType(input),
          input: inputText(input),
          status: "running",
          startedAt: eventTime(event, record.createdAt),
          durationMs: 0,
          background: input.run_in_background === true,
          sourceRecordIds: new Set([record.id]),
        });
      }
      continue;
    }
    const message = isRecord(event.message) ? event.message : undefined;
    if (event.type !== "assistant" && message?.role !== "assistant") continue;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      if (block.name !== "Agent" && block.name !== "Task") continue;
      const id = stringField(block.id);
      if (!id) continue;
      const input = isRecord(block.input) ? block.input : {};
      const startedAt = eventTime(event, record.createdAt);
      const existing = runs.get(id);
      if (existing) {
        existing.sourceRecordIds.add(record.id);
        continue;
      }
      runs.set(id, {
        id,
        provider: "claude",
        label: runLabel(input),
        agentType: runType(input),
        input: inputText(input),
        status: "running",
        startedAt,
        durationMs: 0,
        background: input.run_in_background === true,
        sourceRecordIds: new Set([record.id]),
      });
    }
  }

  const localAgentRunIds = new Set<string>();
  const runByTaskId = new Map<string, MutableRun>();

  // Establish background runs before reading tool results. Claude's launch
  // acknowledgement is a tool_result, but it is not the child run's outcome.
  for (const { record, event } of decoded) {
    const subtype = stringField(event.subtype);
    if (event.type !== "system" || subtype !== "task_started") continue;
    // Claude also emits this lifecycle for local shell jobs. Only the
    // provider's explicit local_agent type is a sub-agent.
    if (event.task_type !== "local_agent") continue;
    const toolUseId = stringField(event.tool_use_id);
    const run = toolUseId ? runs.get(toolUseId) : undefined;
    if (!run) continue;
    const taskId = stringField(event.task_id);
    run.background = true;
    run.childId = taskId ?? run.childId;
    run.sourceRecordIds.add(record.id);
    localAgentRunIds.add(run.id);
    if (taskId) runByTaskId.set(taskId, run);
  }

  for (const { record, event } of decoded) {
    const subtype = stringField(event.subtype);

    if (event.type === "system" && subtype === "task_notification") {
      if (event.task_type !== undefined && event.task_type !== "local_agent") continue;
      const toolUseRun = runs.get(stringField(event.tool_use_id) ?? "");
      const taskRun = runByTaskId.get(stringField(event.task_id) ?? "");
      // Both identifiers are present in current logs. Refuse a conflicting
      // pair instead of attaching a terminal event to the wrong child.
      if (toolUseRun && taskRun && toolUseRun !== taskRun) continue;
      const run = toolUseRun ?? taskRun;
      if (!run || !localAgentRunIds.has(run.id)) continue;
      run.background = true;
      run.childId = stringField(event.task_id) ?? run.childId;
      run.sourceRecordIds.add(record.id);
      run.finishedAt = eventTime(event, record.createdAt);
      const status = stringField(event.status);
      run.status = status === "completed" || status === "success" ? "completed" : "failed";
      run.outcome = displayValue(event.summary ?? event.error ?? event.result);
      continue;
    }

    if (record.cli === "claude-managed" && event.type === "agent.tool_result") {
      const resultRun = runs.get(stringField(event.tool_use_id) ?? "");
      if (!resultRun) continue;
      resultRun.sourceRecordIds.add(record.id);
      if (resultRun.background) continue;
      resultRun.finishedAt = eventTime(event, record.createdAt);
      resultRun.status = event.is_error === true ? "failed" : "completed";
      resultRun.outcome = displayValue(event.content);
      continue;
    }

    const message = isRecord(event.message) ? event.message : undefined;
    if (event.type !== "user" && message?.role !== "user") continue;
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const resultRun = runs.get(String(block.tool_use_id ?? ""));
      if (!resultRun) continue;
      resultRun.sourceRecordIds.add(record.id);
      if (resultRun.background) continue;
      resultRun.finishedAt = eventTime(event, record.createdAt);
      resultRun.status = block.is_error === true ? "failed" : "completed";
      resultRun.outcome = displayValue(block.content);
    }
  }

  return [...runs.values()];
}

function extractOpenCodeRuns(logs: SessionLogRecord[]): MutableRun[] {
  const decoded = decodedLogs(logs.filter((record) => record.cli === "opencode"));
  const runs = new Map<string, MutableRun>();
  const terminalRunIds = new Set<string>();

  for (const { record, event } of decoded) {
    if (event.type !== "message.part.updated") continue;
    const properties = isRecord(event.properties) ? event.properties : undefined;
    const part = properties && isRecord(properties.part) ? properties.part : undefined;
    if (!part || part.type !== "tool" || part.tool !== "task") continue;
    const id = stringField(part.callID ?? part.callId ?? part.toolCallId ?? part.id);
    if (!id) continue;
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};
    const time = isRecord(state.time) ? state.time : {};
    const startedAt = timestampValue(time.start) ?? eventTime(event, record.createdAt);
    const existing = runs.get(id);
    const run =
      existing ??
      ({
        id,
        provider: "opencode",
        label: runLabel(input),
        agentType: runType(input),
        input: inputText(input),
        status: "running",
        startedAt,
        durationMs: 0,
        background: false,
        sourceRecordIds: new Set<string>(),
      } satisfies MutableRun);

    run.sourceRecordIds.add(record.id);
    const status = stringField(state.status);
    const isTerminal = status === "completed" || status === "error" || status === "failed";
    // A delayed pending/running duplicate must not replace the richer terminal
    // snapshot. A later terminal snapshot is authoritative over an earlier one.
    if (isTerminal || !terminalRunIds.has(id)) {
      const preciseStart = timestampValue(time.start);
      if (preciseStart) run.startedAt = preciseStart;
      if (Object.keys(input).length > 0) {
        run.label = runLabel(input);
        run.agentType = runType(input);
        run.input = inputText(input);
      }
      const childId = stringField(isRecord(state.metadata) ? state.metadata.sessionId : undefined);
      if (childId) run.childId = childId;
    }

    if (status === "completed") {
      run.status = "completed";
      run.finishedAt = timestampValue(time.end) ?? eventTime(event, record.createdAt);
      run.outcome = displayValue(state.output);
      terminalRunIds.add(id);
    } else if (status === "error" || status === "failed") {
      run.status = "failed";
      run.finishedAt = timestampValue(time.end) ?? eventTime(event, record.createdAt);
      run.outcome = displayValue(state.error ?? state.output);
      terminalRunIds.add(id);
    }
    runs.set(id, run);
  }

  // tool_start/tool_end duplicate the rich task-part lifecycle. Mark them as
  // consumed so the transcript can substitute exactly one native agent row.
  for (const { record, event } of decoded) {
    if (event.type !== "tool_start" && event.type !== "tool_end") continue;
    if (event.toolName !== "task") continue;
    const id = stringField(event.toolCallId);
    const run = id ? runs.get(id) : undefined;
    if (run) run.sourceRecordIds.add(record.id);
  }

  return [...runs.values()];
}

/** Extract the sub-agent lifecycles that current harness logs expose reliably. */
export function extractSubagentRuns(logs: SessionLogRecord[]): SubagentRun[] {
  return [...extractClaudeRuns(logs), ...extractOpenCodeRuns(logs)]
    .map((run) => ({
      ...run,
      durationMs: durationMs(run.startedAt, run.finishedAt),
      sourceRecordIds: [...run.sourceRecordIds],
    }))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}
