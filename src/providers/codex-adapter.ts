/**
 * Codex provider adapter.
 *
 * Wraps the `@openai/codex-sdk` (which drives the `codex app-server` JSON-RPC
 * protocol via a child process). This file owns:
 *
 *   Phase 1 — factory wiring + skeleton classes.
 *   Phase 2 — event stream normalization, CostData, AbortController, log file,
 *             AGENTS.md system-prompt injection, canResume via resumeThread.
 *   Phase 3 — per-session MCP config builder + model catalogue wiring. The
 *             baseline Codex config (`~/.codex/config.toml`) is written at
 *             Docker image build time (deferred to Phase 6). For local dev
 *             we pass the equivalent overrides via `new Codex({ config })`.
 *
 * Phases 4-5 extend this file with:
 *   - Skill resolution (slash-command inlining)
 *   - Adapter-side swarm hooks (cancellation polling, tool-loop detection, ...)
 *
 * ### Codex SDK `config` option
 *
 * `CodexOptions.config` is typed as `CodexConfigObject` — a recursive
 * `Record<string, CodexConfigValue>` where values are primitives, arrays, or
 * nested objects. The SDK flattens the object into dotted-path `--config`
 * overrides for the underlying Codex CLI. This means we can pass a STRUCTURED
 * object like `{ mcp_servers: { "agent-swarm": { url: "..." } } }` and the
 * SDK handles the flattening — no pre-flattening required on our side.
 * `CodexConfigObject` is NOT exported from the SDK, so we use
 * `NonNullable<CodexOptions["config"]>` (or `Record<string, unknown>` for
 * locally-built fragments) instead of duplicating the type.
 *
 * ### MCP server field names (verified against developers.openai.com/codex/mcp)
 *
 * Streamable HTTP transport (supported):
 *   url, http_headers, bearer_token_env_var, enabled, startup_timeout_sec,
 *   tool_timeout_sec, enabled_tools, disabled_tools
 *
 * Stdio transport (supported):
 *   command, args, env, enabled, startup_timeout_sec, tool_timeout_sec
 *
 * SSE transport is NOT yet supported by Codex (tracked in openai/codex#2129).
 * We skip any SSE servers with a warning so the session still runs.
 *
 * Type discipline: every Codex-related type below is imported directly from
 * `@openai/codex-sdk`. We do NOT hand-roll parallel interfaces for `Thread`,
 * `Turn`, events, or items — the SDK already exports them as a tagged union.
 */

import os from "node:os";
import { join } from "node:path";
import {
  type AgentMessageItem,
  Codex,
  type CodexOptions,
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
import {
  CODEX_DEFAULT_MODEL,
  type CodexModel,
  computeCodexCostUsd,
  getCodexContextWindow,
  resolveCodexModel,
} from "./codex-models";
import { credentialsToAuthJson } from "./codex-oauth/auth-json.js";
import { getValidCodexOAuth } from "./codex-oauth/storage.js";
import { resolveCodexPrompt } from "./codex-skill-resolver";
import { createCodexSwarmEventHandler } from "./codex-swarm-events";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/** Alias for the SDK's (unexported) `CodexConfigObject` type. */
type CodexConfig = NonNullable<CodexOptions["config"]>;

/**
 * Shape returned by `GET /api/agents/:id/mcp-servers?resolveSecrets=true`.
 * Mirrors `pi-mono-adapter.ts:430-439` and `claude-adapter.ts:59-72`, plus
 * the DB handler at `src/http/mcp-servers.ts:170-210` which injects the
 * `resolvedEnv` / `resolvedHeaders` fields when `resolveSecrets=true`.
 */
interface InstalledMcpServersResponse {
  servers: Array<{
    name: string;
    transport: "stdio" | "http" | "sse";
    isActive: boolean;
    isEnabled: boolean;
    command?: string | null;
    args?: string | null;
    url?: string | null;
    headers?: string | null;
    resolvedEnv?: Record<string, string>;
    resolvedHeaders?: Record<string, string>;
  }>;
  total?: number;
}

/**
 * Build the per-session Codex config object, which becomes the
 * `config` option to `new Codex({ config })`. This layers on top of the
 * baseline `~/.codex/config.toml` written at Docker image build time (Phase 6).
 *
 * Includes:
 * 1. Baseline overrides (model, approval_policy, sandbox_mode, …) — repeated
 *    here (in addition to the baseline file) so local dev without the baseline
 *    file still gets the same settings.
 * 2. The swarm MCP server over Streamable HTTP, with per-task headers so the
 *    server can correlate cross-task inheritance.
 * 3. Installed MCP servers fetched from the API, mapped to Codex's MCP config
 *    shape (stdio or Streamable HTTP). SSE servers are skipped with a warning.
 *
 * Fetch failures are non-fatal — we emit a `raw_stderr` warning via `emit`
 * and return the config with only the swarm server so the session can still
 * run.
 */
export async function buildCodexConfig(
  config: ProviderSessionConfig,
  model: CodexModel,
  emit: (event: ProviderEvent) => void,
): Promise<CodexConfig> {
  const mcpServers: Record<string, Record<string, unknown>> = {};

  // (2) Swarm MCP server — Streamable HTTP transport.
  // Field names verified against https://developers.openai.com/codex/mcp:
  // `url`, `http_headers`, `enabled`, `startup_timeout_sec`, `tool_timeout_sec`.
  mcpServers["agent-swarm"] = {
    url: `${config.apiUrl}/mcp`,
    http_headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "X-Agent-ID": config.agentId,
      "X-Source-Task-Id": config.taskId ?? "",
    },
    enabled: true,
    startup_timeout_sec: 30,
    tool_timeout_sec: 120,
  };

  // (3) Installed MCP servers — fetched from the API. Non-fatal on failure.
  if (config.apiUrl && config.apiKey && config.agentId) {
    try {
      const res = await fetch(
        `${config.apiUrl}/api/agents/${config.agentId}/mcp-servers?resolveSecrets=true`,
        {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "X-Agent-ID": config.agentId,
          },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as InstalledMcpServersResponse;
        for (const srv of data.servers ?? []) {
          if (!srv.isActive || !srv.isEnabled) continue;

          if (srv.transport === "stdio") {
            if (!srv.command) continue;
            let parsedArgs: string[] = [];
            try {
              parsedArgs = srv.args ? (JSON.parse(srv.args) as string[]) : [];
            } catch {
              // Invalid JSON — fall through with empty args.
            }
            mcpServers[srv.name] = {
              command: srv.command,
              args: parsedArgs,
              env: srv.resolvedEnv ?? {},
              enabled: true,
              startup_timeout_sec: 30,
              tool_timeout_sec: 120,
            };
            continue;
          }

          if (srv.transport === "http") {
            if (!srv.url) continue;
            let parsedHeaders: Record<string, string> = {};
            try {
              parsedHeaders = srv.headers
                ? (JSON.parse(srv.headers) as Record<string, string>)
                : {};
            } catch {
              // Invalid JSON — fall through with empty headers.
            }
            mcpServers[srv.name] = {
              url: srv.url,
              http_headers: { ...parsedHeaders, ...(srv.resolvedHeaders ?? {}) },
              enabled: true,
              startup_timeout_sec: 30,
              tool_timeout_sec: 120,
            };
            continue;
          }

          if (srv.transport === "sse") {
            emit({
              type: "raw_stderr",
              content: `[codex] Skipping MCP server "${srv.name}": SSE transport is not yet supported by Codex (tracked in openai/codex#2129).\n`,
            });
          }
        }
      } else {
        emit({
          type: "raw_stderr",
          content: `[codex] Failed to fetch installed MCP servers: HTTP ${res.status}. Continuing with only the swarm MCP server.\n`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "raw_stderr",
        content: `[codex] Failed to fetch installed MCP servers: ${message}. Continuing with only the swarm MCP server.\n`,
      });
    }
  }

  // (1) Baseline overrides. Keep these aligned with the Dockerfile baseline
  // at `~/.codex/config.toml` (Phase 6). Repeating them here makes local dev
  // (no baseline file) behave identically to the Docker worker.
  return {
    model,
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    skip_git_repo_check: true,
    show_raw_agent_reasoning: false,
    mcp_servers: mcpServers as CodexConfig,
  };
}

/** Running session backed by a Codex `Thread`. */
class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly config: ProviderSessionConfig;
  private readonly agentsMdHandle: CodexAgentsMdHandle;
  private readonly resolvedModel: CodexModel;
  private readonly contextWindow: number;
  private readonly skillsDir: string;
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly startedAt = Date.now();
  private readonly completionPromise: Promise<ProviderResult>;
  private resolveCompletion!: (result: ProviderResult) => void;
  private abortController: AbortController | null = null;
  /**
   * Mutable holder for the current turn's `AbortController`. Shared with the
   * swarm event handler so it can trigger an abort from outside `runSession`
   * (e.g. when a tool-loop is detected or the task has been cancelled).
   */
  private readonly abortRef: { current: AbortController | null } = { current: null };
  private _sessionId: string | undefined;
  private numTurns = 0;
  private lastUsage: Usage | null = null;
  private aborted = false;
  private settled = false;

  constructor(
    thread: Thread,
    config: ProviderSessionConfig,
    agentsMdHandle: CodexAgentsMdHandle,
    resolvedModel: CodexModel,
    initialEvents: ProviderEvent[] = [],
    skillsDir?: string,
  ) {
    this.thread = thread;
    this.config = config;
    this.agentsMdHandle = agentsMdHandle;
    this.resolvedModel = resolvedModel;
    this.contextWindow = getCodexContextWindow(resolvedModel);
    // `CODEX_SKILLS_DIR` lets tests / non-Docker installs point at a custom
    // tree without polluting `~/.codex/skills` on the host. Fall back to the
    // runtime default of `${HOME}/.codex/skills`.
    this.skillsDir =
      skillsDir ?? process.env.CODEX_SKILLS_DIR ?? join(os.homedir(), ".codex", "skills");
    this.logFileHandle = Bun.file(config.logFile).writer();

    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    // Adapter-side swarm hooks: lower-latency cancellation poll, tool-loop
    // detection, heartbeat, activity ping, and context-usage reporting. The
    // handler reads `abortRef.current` to trigger aborts from outside
    // `runSession` (the runner-side polling at `runner.ts:2812-2841` is the
    // backstop). Skipped when there's no task or API context to talk to.
    if (config.taskId && config.apiUrl && config.apiKey) {
      this.listeners.push(
        createCodexSwarmEventHandler({
          apiUrl: config.apiUrl,
          apiKey: config.apiKey,
          agentId: config.agentId,
          taskId: config.taskId,
          abortRef: this.abortRef,
        }),
      );
    }

    // Replay any events that fired before the session was constructed
    // (e.g. warnings from `buildCodexConfig`). They enter the same path as
    // events emitted during the session: written to the log file, pushed to
    // any attached listeners, otherwise queued for later flush in `onEvent`.
    for (const event of initialEvents) {
      this.emit(event);
    }

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
    const inputTokens = usage?.input_tokens ?? 0;
    const cachedInputTokens = usage?.cached_input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    return {
      // Runner overrides with its own session id.
      sessionId: "",
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      // Codex SDK does not report dollar cost directly. We compute it from
      // token counts × per-model pricing in `codex-models.ts`. The pricing
      // table is sourced from developers.openai.com/api/docs/pricing — bump
      // it whenever OpenAI updates published rates.
      totalCostUsd: computeCodexCostUsd(
        this.resolvedModel,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      ),
      inputTokens,
      outputTokens,
      cacheReadTokens: cachedInputTokens,
      // Codex does not distinguish cache writes in its Usage payload.
      cacheWriteTokens: 0,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.numTurns,
      model: this.resolvedModel,
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
        // Surface partial agent_message deltas as `custom` events so a future
        // UI can show streaming tokens. We deliberately use `custom` (instead
        // of new ProviderEvent variants) to avoid touching the cross-provider
        // contract — the dashboard can opt-in by listening for the event name.
        // The full text still flows through `item.completed` → `message`
        // below, so consumers that don't subscribe to deltas see no behavior
        // change.
        const updatedItem = event.item as ThreadItem;
        if (updatedItem.type === "agent_message") {
          const msg = updatedItem as AgentMessageItem;
          if (msg.text) {
            this.emit({
              type: "custom",
              name: "codex.message_delta",
              data: { itemId: updatedItem.id, text: msg.text },
            });
          }
        }
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
            // Promote Codex reasoning items to first-class `custom` events so
            // the dashboard can render them in a separate "thinking" panel
            // without conflating them with the agent's actual output. Codex
            // emits these between turns when the model produces an explicit
            // reasoning trace (gpt-5.x reasoning effort > none).
            const r = item as ReasoningItem;
            const text =
              (r as { text?: string; summary?: string }).text ??
              (r as { summary?: string }).summary ??
              "";
            if (text) {
              this.emit({
                type: "custom",
                name: "codex.reasoning",
                data: { itemId: r.id, text },
              });
            }
            break;
          }
          case "todo_list": {
            // Promote Codex todo lists to a `custom` event so a future
            // dashboard widget can render the checkbox state. The shape of
            // the items (title, status, etc.) lives in the SDK's
            // `TodoListItem` and is preserved verbatim.
            const todo = item as TodoListItem;
            this.emit({
              type: "custom",
              name: "codex.todo_list",
              data: { itemId: todo.id, items: (todo as { items?: unknown }).items ?? [] },
            });
            break;
          }
          case "error": {
            const errItem = item as ErrorItem;
            this.emit({ type: "error", message: this.formatTerminalError(errItem.message) });
            break;
          }
        }
        break;
      }
      case "turn.completed": {
        this.lastUsage = event.usage;
        if (event.usage) {
          // The Codex SDK reports `input_tokens` as the SUM of every prompt
          // sent to the model across the entire turn (one `codex exec` call
          // can fan out to dozens of model invocations as MCP tools roundtrip
          // back and forth). For chatty turns this number routinely exceeds
          // the model's context window, even though no single model call did.
          //
          // For peak-context reporting we want a proxy for "the largest
          // single-call prompt". We approximate it as the uncached portion
          // (cached tokens are reused across calls so they count once toward
          // the actual peak), plus the output. This isn't perfect — the SDK
          // would have to expose per-call stats for that — but it's far more
          // representative than `(input + output) / window` which clamps to
          // 1.0 the moment a turn makes any meaningful tool history.
          const uncachedInput = Math.max(
            0,
            event.usage.input_tokens - event.usage.cached_input_tokens,
          );
          const peakProxy = uncachedInput + event.usage.output_tokens;
          // `contextPercent` is on a 0-100 scale across all providers — claude
          // emits `(used / total) * 100`, pi-mono passes through `usage.percent`
          // which is already 0-100. The dashboard at
          // new-ui/src/pages/tasks/[id]/page.tsx renders it via `.toFixed(0)`
          // expecting an integer percent, so a 0-1 fraction would render as
          // "0%" instead of e.g. "40%".
          this.emit({
            type: "context_usage",
            contextUsedTokens: peakProxy,
            contextTotalTokens: this.contextWindow,
            contextPercent: Math.min(100, (peakProxy / this.contextWindow) * 100),
            outputTokens: event.usage.output_tokens,
          });
        }
        break;
      }
      case "turn.failed": {
        const message = this.formatTerminalError(event.error.message);
        this.emit({ type: "error", message });
        break;
      }
      case "error": {
        const message = this.formatTerminalError(event.message);
        this.emit({ type: "error", message });
        break;
      }
    }
  }

  /**
   * Detect context-window-exceeded errors from the Codex CLI / SDK and rewrite
   * them with a clearer, actionable message. Codex does not auto-compact like
   * Claude does — when context fills, the next model call hard-fails. We can't
   * compact retroactively, so we just mark the failure with a recognizable
   * `[context-overflow]` prefix that the runner can flag in dashboards. See
   * Linear DES-143 (codex auto-compaction follow-up) for the long-term fix.
   *
   * Patterns observed in the wild (case-insensitive):
   *   - "context length exceeded"
   *   - "maximum context length"
   *   - "too many tokens"
   *   - "input too long"
   *   - "request too large"
   */
  private formatTerminalError(raw: string): string {
    const normalized = raw.toLowerCase();
    const overflowPatterns = [
      "context length exceeded",
      "maximum context length",
      "too many tokens",
      "input too long",
      "request too large",
      "context_length_exceeded",
    ];
    if (overflowPatterns.some((p) => normalized.includes(p))) {
      return `[context-overflow] Codex turn exceeded the model's context window for ${this.resolvedModel} (${this.contextWindow.toLocaleString()} tokens). Codex does not auto-compact conversation history like Claude does — start a fresh task or split the work into smaller turns. Original error: ${raw}`;
    }
    return raw;
  }

  private async runSession(): Promise<void> {
    this.abortController = new AbortController();
    // Expose the controller to the swarm event handler so it can trigger an
    // abort from outside this method (tool-loop detection, cancellation poll).
    this.abortRef.current = this.abortController;
    let terminalError: string | undefined;
    let sawTurnCompleted = false;

    try {
      // Inline Codex skills if the prompt starts with a slash command. If the
      // prompt doesn't begin with a recognized slash command (or the skill
      // file is missing), this returns the prompt unchanged and emits a
      // `raw_stderr` warning in the latter case.
      const resolvedPrompt = await resolveCodexPrompt(this.config.prompt, this.skillsDir, (event) =>
        this.emit(event),
      );

      const streamed = await this.thread.runStreamed(resolvedPrompt, {
        signal: this.abortController.signal,
      });

      try {
        for await (const event of streamed.events) {
          this.handleEvent(event);
          if (event.type === "turn.completed") {
            sawTurnCompleted = true;
          }
          if (event.type === "turn.failed" && !terminalError) {
            terminalError = this.formatTerminalError(event.error.message);
          }
          if (event.type === "error" && !terminalError) {
            terminalError = this.formatTerminalError(event.message);
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
      // Detach the abort controller now that the turn has settled.
      this.abortRef.current = null;
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

  /**
   * Optional override for the skill resolver's skills directory. When unset,
   * each `CodexSession` falls back to `CODEX_SKILLS_DIR` / `~/.codex/skills`.
   * Primarily a test hook so unit tests can point the adapter at a temp dir
   * without mutating `process.env`.
   */
  private readonly skillsDir?: string;

  constructor(opts: { skillsDir?: string } = {}) {
    this.skillsDir = opts.skillsDir;
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Codex ingests per-session instructions via AGENTS.md in the cwd. Write
    // (or refresh) the managed block before we spin up the thread.
    const agentsMdHandle = await writeCodexAgentsMd(config.cwd, config.systemPrompt);

    try {
      // Resolve the model once and thread it through. Unknown values fall
      // back to `CODEX_DEFAULT_MODEL` (see `codex-models.ts`).
      const resolvedModel = resolveCodexModel(config.model);

      // Buffer warnings emitted during config-building so they're not lost
      // before `CodexSession.onEvent` attaches a listener. The buffer is
      // replayed into the session's event stream right after construction
      // via the `initialEvents` constructor parameter.
      const preSessionEvents: ProviderEvent[] = [];
      const bufferedEmit = (event: ProviderEvent) => {
        preSessionEvents.push(event);
      };

      // Warn (as a buffered event) if the caller passed a model that didn't
      // round-trip through `resolveCodexModel`. This catches typos early.
      if (
        config.model &&
        config.model.toLowerCase() !== resolvedModel &&
        !["opus", "sonnet", "haiku"].includes(config.model.toLowerCase())
      ) {
        bufferedEmit({
          type: "raw_stderr",
          content: `[codex] Unknown model "${config.model}" — falling back to ${CODEX_DEFAULT_MODEL}. See src/providers/codex-models.ts for the supported list.\n`,
        });
      }

      const mergedConfig = await buildCodexConfig(config, resolvedModel, bufferedEmit);

      // `CodexOptions.env` does NOT inherit from `process.env`. Construct a
      // minimal env explicitly so the spawned Codex CLI can still find its
      // binary (PATH), write to HOME, and authenticate (OPENAI_API_KEY).
      // Merge anything the runner passed in `config.env` on top.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
        ...(config.env ?? {}),
      };

      // OAuth credential resolution: if no OPENAI_API_KEY is set, try to
      // restore or refresh ChatGPT OAuth credentials from the config store.
      // The entrypoint also restores at boot, but this handles cases where
      // the entrypoint didn't run (local dev) or tokens expired mid-session.
      if (!process.env.OPENAI_API_KEY && config.apiUrl && config.apiKey) {
        const authJsonPath = join(os.homedir(), ".codex", "auth.json");
        let hasAuth = false;
        try {
          const fs = await import("node:fs/promises");
          await fs.access(authJsonPath);
          hasAuth = true;
        } catch {
          // auth.json doesn't exist
        }

        if (!hasAuth) {
          const oauthCreds = await getValidCodexOAuth(config.apiUrl, config.apiKey);
          if (oauthCreds) {
            try {
              const fs = await import("node:fs/promises");
              const authJson = credentialsToAuthJson(oauthCreds);
              await fs.mkdir(join(os.homedir(), ".codex"), { recursive: true, mode: 0o700 });
              await fs.writeFile(authJsonPath, JSON.stringify(authJson, null, 2), {
                mode: 0o600,
              });
              bufferedEmit({
                type: "raw_stderr",
                content: "[codex] Restored OAuth credentials from config store\n",
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              bufferedEmit({
                type: "raw_stderr",
                content: `[codex] Failed to write auth.json: ${message}\n`,
              });
            }
          }
        }
      }

      // The SDK's default `findCodexPath()` does `require.resolve("@openai/codex")`
      // from the SDK's own module. When agent-swarm runs as a Bun single-file
      // compiled executable, the bundled SDK can't resolve `@openai/codex` at
      // runtime because it's not part of the bundle — it lives in a global
      // install (`/usr/lib/node_modules/@openai/codex` in the Docker worker
      // image). Honor `CODEX_PATH_OVERRIDE` so Docker can point us at the CLI
      // wrapper (or native binary) directly. Fall back to undefined so local
      // dev with `@openai/codex-sdk` installed as a regular node_modules
      // dependency keeps working via the SDK's own resolver.
      const codexPathOverride = process.env.CODEX_PATH_OVERRIDE;

      const codex = new Codex({
        ...(codexPathOverride ? { codexPathOverride } : {}),
        env,
        config: mergedConfig,
      });

      const threadOptions: ThreadOptions = {
        workingDirectory: config.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        model: resolvedModel,
      };

      const thread = config.resumeSessionId
        ? codex.resumeThread(config.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);

      return new CodexSession(
        thread,
        config,
        agentsMdHandle,
        resolvedModel,
        preSessionEvents,
        this.skillsDir,
      );
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
