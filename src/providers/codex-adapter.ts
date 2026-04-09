/**
 * Codex provider adapter.
 *
 * Wraps the `@openai/codex-sdk` (which drives the `codex app-server` JSON-RPC
 * protocol via a child process). This file owns:
 *
 *   Phase 1 — factory wiring + skeleton classes.
 *   Phase 2 — event stream normalization, CostData, AbortController, log file,
 *             AGENTS.md system-prompt injection, canResume via resumeThread.
 *
 * Phases 3-5 extend this file with:
 *   - MCP baseline + per-session config (`new Codex({ config })`)
 *   - Skill resolution (slash-command inlining)
 *   - Adapter-side swarm hooks (cancellation polling, tool-loop detection, ...)
 *
 * Type discipline: every Codex-related type below is imported directly from
 * `@openai/codex-sdk`. We do NOT hand-roll parallel interfaces for `Thread`,
 * `Turn`, events, or items — the SDK already exports them as a tagged union.
 */

import {
  type AgentMessageItem,
  Codex,
  type CommandExecutionItem,
  type ErrorItem,
  type FileChangeItem,
  type McpToolCallItem,
  type ReasoningItem,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type TodoListItem,
  type Usage,
  type WebSearchItem,
} from "@openai/codex-sdk";
import { type CodexAgentsMdHandle, writeCodexAgentsMd } from "./codex-agents-md";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

// Approximate context window for the default Codex model. Codex's SDK does
// not currently expose per-model context limits, so we use a conservative
// static value for the `context_usage` percent calculation. Promote to
// `codex-models.ts` in Phase 3 if/when the SDK starts reporting this.
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Running session backed by a Codex `Thread`. */
class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly config: ProviderSessionConfig;
  private readonly agentsMdHandle: CodexAgentsMdHandle;
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly startedAt = Date.now();
  private readonly completionPromise: Promise<ProviderResult>;
  private resolveCompletion!: (result: ProviderResult) => void;
  private abortController: AbortController | null = null;
  private _sessionId: string | undefined;
  private numTurns = 0;
  private lastUsage: Usage | null = null;
  private aborted = false;
  private settled = false;

  constructor(thread: Thread, config: ProviderSessionConfig, agentsMdHandle: CodexAgentsMdHandle) {
    this.thread = thread;
    this.config = config;
    this.agentsMdHandle = agentsMdHandle;
    this.logFileHandle = Bun.file(config.logFile).writer();

    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    // Kick the event loop asynchronously so the constructor can return.
    void this.runSession();
  }

  get sessionId(): string | undefined {
    return this._sessionId ?? this.thread.id ?? undefined;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush any events that fired before a listener was attached.
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue.length = 0;
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.abortController?.abort();
  }

  private emit(event: ProviderEvent): void {
    try {
      this.logFileHandle.write(
        `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      );
    } catch {
      // Log writer failure must not break the event stream.
    }
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Swallow listener errors — a bad listener must not kill the session.
        }
      }
    } else {
      this.eventQueue.push(event);
    }
  }

  private settle(result: ProviderResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveCompletion(result);
  }

  /** Build CostData from the most recent turn usage. */
  private buildCostData(usage: Usage | null, isError: boolean): CostData {
    return {
      // Runner overrides with its own session id.
      sessionId: "",
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      // Codex SDK does not report dollar cost directly; leave at 0 and let
      // the backend compute it from token counts + model if/when needed.
      totalCostUsd: 0,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cached_input_tokens ?? 0,
      // Codex does not distinguish cache writes in its Usage payload.
      cacheWriteTokens: 0,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.numTurns,
      model: this.config.model,
      isError,
    };
  }

  /** Extract a human-friendly tool name for normalized `tool_start` events. */
  private toolNameForItem(item: ThreadItem): string {
    switch (item.type) {
      case "command_execution":
        return "bash";
      case "file_change": {
        const first = item.changes[0];
        if (!first) return "Edit";
        return first.kind === "add" ? "Write" : first.kind === "delete" ? "Delete" : "Edit";
      }
      case "mcp_tool_call":
        return item.tool;
      case "web_search":
        return "WebSearch";
      default:
        return item.type;
    }
  }

  /** Arguments payload for a `tool_start` event mirroring the SDK item. */
  private toolArgsForItem(item: ThreadItem): unknown {
    switch (item.type) {
      case "command_execution":
        return { command: (item as CommandExecutionItem).command };
      case "file_change":
        return { changes: (item as FileChangeItem).changes };
      case "mcp_tool_call": {
        const mcpItem = item as McpToolCallItem;
        return { server: mcpItem.server, tool: mcpItem.tool, arguments: mcpItem.arguments };
      }
      case "web_search":
        return { query: (item as WebSearchItem).query };
      default:
        return {};
    }
  }

  /** Whether the item variant should surface as a `tool_start`/`tool_end` pair. */
  private isToolItem(
    item: ThreadItem,
  ): item is CommandExecutionItem | FileChangeItem | McpToolCallItem | WebSearchItem {
    return (
      item.type === "command_execution" ||
      item.type === "file_change" ||
      item.type === "mcp_tool_call" ||
      item.type === "web_search"
    );
  }

  private handleEvent(event: ThreadEvent): void {
    // Mirror every raw SDK event into the log as raw_log for debugability —
    // parity with Claude's JSONL envelope.
    this.emit({ type: "raw_log", content: JSON.stringify(event) });

    switch (event.type) {
      case "thread.started": {
        this._sessionId = event.thread_id;
        this.emit({ type: "session_init", sessionId: event.thread_id });
        break;
      }
      case "turn.started": {
        this.numTurns += 1;
        break;
      }
      case "item.started": {
        if (this.isToolItem(event.item)) {
          this.emit({
            type: "tool_start",
            toolCallId: event.item.id,
            toolName: this.toolNameForItem(event.item),
            args: this.toolArgsForItem(event.item),
          });
        }
        break;
      }
      case "item.updated": {
        // UI does not need delta updates today — just keep the raw_log above.
        break;
      }
      case "item.completed": {
        const { item } = event;
        if (this.isToolItem(item)) {
          this.emit({
            type: "tool_end",
            toolCallId: item.id,
            toolName: this.toolNameForItem(item),
            result: item,
          });
          break;
        }
        switch (item.type) {
          case "agent_message": {
            const msg = item as AgentMessageItem;
            if (msg.text) {
              this.emit({ type: "message", role: "assistant", content: msg.text });
            }
            break;
          }
          case "reasoning": {
            // Surfaced only in raw_log above; skip to avoid double-messaging the UI.
            void (item as ReasoningItem);
            break;
          }
          case "todo_list": {
            // Codex's todo list has no mapping in ProviderEvent today — raw_log only.
            void (item as TodoListItem);
            break;
          }
          case "error": {
            const errItem = item as ErrorItem;
            this.emit({ type: "error", message: errItem.message });
            break;
          }
        }
        break;
      }
      case "turn.completed": {
        this.lastUsage = event.usage;
        if (event.usage) {
          const total = event.usage.input_tokens + event.usage.output_tokens;
          this.emit({
            type: "context_usage",
            contextUsedTokens: total,
            contextTotalTokens: DEFAULT_CONTEXT_WINDOW,
            contextPercent: Math.min(1, total / DEFAULT_CONTEXT_WINDOW),
            outputTokens: event.usage.output_tokens,
          });
        }
        break;
      }
      case "turn.failed": {
        this.emit({ type: "error", message: event.error.message });
        break;
      }
      case "error": {
        this.emit({ type: "error", message: event.message });
        break;
      }
    }
  }

  private async runSession(): Promise<void> {
    this.abortController = new AbortController();
    let terminalError: string | undefined;
    let sawTurnCompleted = false;

    try {
      const streamed = await this.thread.runStreamed(this.config.prompt, {
        signal: this.abortController.signal,
      });

      try {
        for await (const event of streamed.events) {
          this.handleEvent(event);
          if (event.type === "turn.completed") {
            sawTurnCompleted = true;
          }
          if (event.type === "turn.failed" && !terminalError) {
            terminalError = event.error.message;
          }
          if (event.type === "error" && !terminalError) {
            terminalError = event.message;
          }
        }
      } catch (err) {
        // AbortError from the SDK propagates here when signal.abort() fires.
        if (this.aborted || (err instanceof Error && err.name === "AbortError")) {
          const cost = this.buildCostData(this.lastUsage, true);
          this.emit({ type: "result", cost, isError: true, errorCategory: "cancelled" });
          this.settle({
            exitCode: 130,
            sessionId: this._sessionId,
            cost,
            isError: true,
            failureReason: "cancelled",
          });
          return;
        }
        throw err;
      }

      const isError = Boolean(terminalError) || !sawTurnCompleted;
      const cost = this.buildCostData(this.lastUsage, isError);
      this.emit({
        type: "result",
        cost,
        isError,
        errorCategory: terminalError ? "turn_failed" : undefined,
      });
      this.settle({
        exitCode: isError ? 1 : 0,
        sessionId: this._sessionId,
        cost,
        isError,
        failureReason: terminalError,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "raw_stderr", content: `[codex] Error: ${message}\n` });
      this.emit({ type: "error", message });
      const cost = this.buildCostData(this.lastUsage, true);
      this.emit({ type: "result", cost, isError: true, errorCategory: "exception" });
      this.settle({
        exitCode: 1,
        sessionId: this._sessionId,
        cost,
        isError: true,
        failureReason: message,
      });
    } finally {
      try {
        await this.logFileHandle.end();
      } catch {
        // Ignore log writer cleanup failures.
      }
      await this.agentsMdHandle.cleanup();
    }
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Codex ingests per-session instructions via AGENTS.md in the cwd. Write
    // (or refresh) the managed block before we spin up the thread.
    const agentsMdHandle = await writeCodexAgentsMd(config.cwd, config.systemPrompt);

    try {
      const codex = new Codex({
        env: config.env,
      });

      const threadOptions: ThreadOptions = {
        workingDirectory: config.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      };
      if (config.model) {
        threadOptions.model = config.model;
      }

      const thread = config.resumeSessionId
        ? codex.resumeThread(config.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);

      return new CodexSession(thread, config, agentsMdHandle);
    } catch (err) {
      // If we failed to construct the thread, clean up the managed AGENTS.md
      // block so we don't leak state on the filesystem.
      await agentsMdHandle.cleanup();
      throw err;
    }
  }

  async canResume(sessionId: string): Promise<boolean> {
    if (!sessionId || typeof sessionId !== "string") {
      return false;
    }
    try {
      const codex = new Codex();
      // `resumeThread` is synchronous in 0.118.x and returns a Thread handle.
      // The runner only calls canResume when deciding whether to resume a
      // task, so we accept the (cheap) handshake cost.
      codex.resumeThread(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    // Codex has no native slash-command system. Phase 4 adds a skill resolver
    // that inlines the matching SKILL.md content into the turn prompt before
    // it reaches `thread.runStreamed()`. The leading `/<name>` token here is
    // the marker the resolver looks for (mirrors Claude's format).
    return `/${commandName}`;
  }
}
