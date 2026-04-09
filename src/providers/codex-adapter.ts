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
  getCodexContextWindow,
  resolveCodexModel,
} from "./codex-models";
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

  constructor(
    thread: Thread,
    config: ProviderSessionConfig,
    agentsMdHandle: CodexAgentsMdHandle,
    resolvedModel: CodexModel,
    initialEvents: ProviderEvent[] = [],
  ) {
    this.thread = thread;
    this.config = config;
    this.agentsMdHandle = agentsMdHandle;
    this.resolvedModel = resolvedModel;
    this.contextWindow = getCodexContextWindow(resolvedModel);
    this.logFileHandle = Bun.file(config.logFile).writer();

    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

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
            contextTotalTokens: this.contextWindow,
            contextPercent: Math.min(1, total / this.contextWindow),
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

      const codex = new Codex({ env, config: mergedConfig });

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

      return new CodexSession(thread, config, agentsMdHandle, resolvedModel, preSessionEvents);
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
