import type { ContextSnapshot, SteeringMessage } from "@/api/types";
import type {
  CallUsage,
  CallUsageTotals,
  ParsedMessage,
  ProviderMetaBlock,
  SubagentRun,
} from "@/logs-parser";

// The raw session log's row model: the rows `buildStream`
// (session-log-viewer.tsx) makes from the parsed messages, one per event.

export type ToolKind = "mcp" | "bash" | "file" | "web" | "task" | "skill" | "other";

export interface ToolEntry {
  id: string;
  kind: ToolKind;
  name: string;
  server: string;
  title: string;
  detail: string;
  input: string;
  preview: string;
  body: string;
  ok: boolean;
  hasResult: boolean;
  durMs: number;
  /** The LLM call that emitted this tool call, when it is the call's first row. */
  usage?: CallUsage;
}

export type StreamRow =
  | { type: "compaction"; id: string; snapshot: ContextSnapshot }
  | {
      type: "steering";
      id: string;
      time: string;
      iso: string;
      message: SteeringMessage;
      isNew: boolean;
    }
  | {
      type: "agent";
      id: string;
      role: "assistant" | "user" | "system";
      time: string;
      iso: string;
      md: string;
      isNew: boolean;
      /** The LLM call that emitted this text, when it is the call's first row. */
      usage?: CallUsage;
    }
  | {
      type: "thinking";
      id: string;
      time: string;
      iso: string;
      text: string;
      isNew: boolean;
      usage?: CallUsage;
    }
  | {
      type: "meta";
      id: string;
      time: string;
      iso: string;
      block: ProviderMetaBlock;
      isNew: boolean;
      /** Result rows: the calls since the previous result. */
      callTotals?: CallUsageTotals;
    }
  | {
      type: "subagent";
      id: string;
      time: string;
      iso: string;
      run: SubagentRun;
      isNew: boolean;
      /** The main-thread LLM call that spawned the run, when the spawn was its first row. */
      usage?: CallUsage;
    }
  | {
      type: "toolgroup";
      id: string;
      time: string;
      iso: string;
      tools: ToolEntry[];
      names: string[];
      durMs: number;
      defaultOpen: boolean;
      isNew: boolean;
    };

/** Human-friendly elapsed duration. 0/invalid → "" (renders nothing). */
export function formatDur(ms: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  }
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

/**
 * The usage of each main-thread LLM call whose first row spawned a sub-agent,
 * keyed by the run id (the Agent/Task call id). Such a record belongs to the
 * run, so its `call_usage` has no tool or text row to ride on: the run's row
 * shows it. One chip per call: a record that spawned several runs gives the
 * usage to the first.
 */
export function spawnCallUsage(
  messages: readonly ParsedMessage[],
  runIds: ReadonlySet<string>,
): Map<string, CallUsage> {
  const usageByRecord = new Map<string, CallUsage>();
  const runByRecord = new Map<string, string>();
  for (const m of messages) {
    if (m.parentToolUseId) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.id && runIds.has(b.id) && !runByRecord.has(m.id)) {
        runByRecord.set(m.id, b.id);
      }
      if (
        b.type === "provider_meta" &&
        b.kind === "helper" &&
        b.data.helperType === "call_usage" &&
        b.data.usage &&
        !usageByRecord.has(m.id)
      ) {
        usageByRecord.set(m.id, b.data.usage as CallUsage);
      }
    }
  }
  const byRun = new Map<string, CallUsage>();
  for (const [recordId, runId] of runByRecord) {
    const usage = usageByRecord.get(recordId);
    if (usage) byRun.set(runId, usage);
  }
  return byRun;
}
