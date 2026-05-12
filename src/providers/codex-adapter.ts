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

import { existsSync as nodeExistsSync } from "node:fs";
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
import { buildRatingsFromLlm, fetchRetrievalsForTask, postRatings } from "../be/memory/raters/llm";
import { summarizeSession as runSummarize } from "../utils/internal-ai";
import { scrubSecrets } from "../utils/secret-scrubber";
import { type CodexAgentsMdHandle, writeCodexAgentsMd } from "./codex-agents-md";
import { computeCodexCostUsd, getCodexContextWindow, resolveCodexModel } from "./codex-models";
import { credentialsToAuthJson } from "./codex-oauth/auth-json.js";
import { getValidCodexOAuth } from "./codex-oauth/storage.js";
import { resolveCodexPrompt } from "./codex-skill-resolver";
import { createCodexSwarmEventHandler } from "./codex-swarm-events";
import type {
  CostData,
  CredCheckOptions,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/** Alias for the SDK's (unexported) `CodexConfigObject` type. */
type CodexConfig = NonNullable<CodexOptions["config"]>;

/**
 * Codex satisfies its credential requirement by ANY of:
 *   1. `~/.codex/auth.json` already exists on disk (the canonical state once
 *      `codex login` has run).
 *   2. `OPENAI_API_KEY` is set — the entrypoint will run
 *      `codex login --with-api-key` to materialise auth.json on the next boot.
 *   3. `CODEX_OAUTH` is set in the env (typically pulled from swarm_config) —
 *      the entrypoint restores it to disk.
 *
 * Cases 2/3 return `satisfiedBy: 'side-effect-pending'` because the worker
 * process can't proceed until the entrypoint side-effect has materialised the
 * file. The boot loop treats this as ready (the side-effect is the
 * entrypoint's job, and re-running it is idempotent).
 */
export function checkCodexCredentials(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
): CredStatus {
  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  const existsSync = opts.fs?.existsSync ?? nodeExistsSync;
  const authFile = `${homeDir}/.codex/auth.json`;
  if (existsSync(authFile)) {
    return { ready: true, missing: [], satisfiedBy: "file" };
  }
  if (env.OPENAI_API_KEY || env.CODEX_OAUTH) {
    return {
      ready: true,
      missing: [],
      satisfiedBy: "side-effect-pending",
      hint: "Credential present in env; entrypoint will materialise ~/.codex/auth.json on next boot.",
    };
  }
  return {
    ready: false,
    missing: ["OPENAI_API_KEY", "CODEX_OAUTH", authFile],
    hint: "Set OPENAI_API_KEY (entrypoint runs `codex login --with-api-key`), or store CODEX_OAUTH in swarm_config, or place a pre-authenticated `~/.codex/auth.json` in the worker home.",
  };
}

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
 * Resolve which Codex auth mode is active for the spawned subprocess and,
 * if needed, restore ChatGPT OAuth credentials from the swarm config store
 * to `~/.codex/auth.json`.
 *
 * Precedence (matches `docker-entrypoint.sh`): `codex_oauth` from the swarm
 * config store > `OPENAI_API_KEY` env var. If both exist, OAuth wins — and
 * if a stale api-key-mode `auth.json` is present, it gets overwritten with
 * the OAuth payload.
 *
 * Returns the `auth_mode` value the spawned Codex CLI will see, or `null`
 * if no `auth.json` exists (Codex will then fall back to `OPENAI_API_KEY`).
 */
async function resolveCodexAuthMode(
  config: ProviderSessionConfig,
  emit: (event: ProviderEvent) => void,
): Promise<string | null> {
  const fs = await import("node:fs/promises");
  const authJsonPath = join(os.homedir(), ".codex", "auth.json");

  const readAuthMode = async (): Promise<string | null> => {
    try {
      const raw = await fs.readFile(authJsonPath, "utf-8");
      const parsed = JSON.parse(raw) as { auth_mode?: unknown };
      return typeof parsed.auth_mode === "string" ? parsed.auth_mode : null;
    } catch {
      return null;
    }
  };

  let currentMode = await readAuthMode();

  // If config store creds are available and auth.json is missing or in
  // api-key mode, try to restore/upgrade to OAuth. Don't touch a file that's
  // already in chatgpt mode — `getValidCodexOAuth` refreshes and writes back
  // to the config store on its own when called next time.
  if (config.apiUrl && config.apiKey && currentMode !== "chatgpt") {
    const oauthCreds = await getValidCodexOAuth(config.apiUrl, config.apiKey);
    if (oauthCreds) {
      try {
        const authJson = credentialsToAuthJson(oauthCreds);
        await fs.mkdir(join(os.homedir(), ".codex"), { recursive: true, mode: 0o700 });
        await fs.writeFile(authJsonPath, JSON.stringify(authJson, null, 2), { mode: 0o600 });
        const verb = currentMode === null ? "Restored" : "Upgraded api-key auth.json to";
        emit({
          type: "raw_stderr",
          content: `[codex] ${verb} OAuth credentials from config store\n`,
        });
        currentMode = "chatgpt";
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({
          type: "raw_stderr",
          content: `[codex] Failed to write auth.json: ${message}\n`,
        });
      }
    }
  }

  return currentMode;
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
  model: string,
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

/**
 * Test-injection points for the codex session-end summarization path.
 *
 * Production callers omit `deps` entirely — the `CodexSession.summarizeAtEnd`
 * helper falls back to the symbols imported at the top of this file. Tests
 * override each function so we can exercise the summarize/index/rate flow
 * without standing up a real API server or LLM.
 *
 * Why this exists (mirrors `SummarizeSessionForPiDeps`): `bun:test`'s
 * `mock.module()` is process-wide and leaks across test files in the same
 * `bun test` run, breaking siblings that import the real symbols. Explicit DI
 * keeps the boundary local to this adapter.
 */
export interface SummarizeSessionForCodexDeps {
  runSummarize?: typeof runSummarize;
  fetchRetrievalsForTask?: typeof fetchRetrievalsForTask;
  postRatings?: typeof postRatings;
  buildRatingsFromLlm?: typeof buildRatingsFromLlm;
}

/** Running session backed by a Codex `Thread`. */
class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly config: ProviderSessionConfig;
  private readonly agentsMdHandle: CodexAgentsMdHandle;
  private readonly resolvedModel: string;
  private readonly contextWindow: number;
  private readonly skillsDir: string;
  private readonly summarizeDeps: SummarizeSessionForCodexDeps;
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly startedAt = Date.now();
  private readonly completionPromise: Promise<ProviderResult>;
  private resolveCompletion!: (result: ProviderResult) => void;
  private abortController: AbortController | null = null;
  /**
   * Per-session transcript buffer used to feed the session-end summarizer.
   * Reset at the start of `runSession` and appended in `handleEvent`.
   */
  private transcript: string[] = [];
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
  /**
   * Result captured by `settle` but held back from `resolveCompletion` until
   * `runSession`'s `finally` block has fully cleaned up (log writer flush,
   * AGENTS.md cleanup, session summary). Without this, callers awaiting
   * `waitForCompletion` would race the cleanup. Phase 3 added the session
   * summary path which materially relies on this ordering for testability.
   */
  private pendingResult: ProviderResult | null = null;

  constructor(
    thread: Thread,
    config: ProviderSessionConfig,
    agentsMdHandle: CodexAgentsMdHandle,
    resolvedModel: string,
    initialEvents: ProviderEvent[] = [],
    skillsDir?: string,
    summarizeDeps: SummarizeSessionForCodexDeps = {},
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
    this.summarizeDeps = summarizeDeps;
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
    // Scrub secret values from raw_log / raw_stderr content before any egress
    // (log file write, listener dispatch, downstream session-logs push). Keeps
    // secrets out of /workspace/logs/*.jsonl, the session_logs SQLite table,
    // and container stdout (pretty-print consumes event.content).
    const scrubbed: ProviderEvent =
      event.type === "raw_log" || event.type === "raw_stderr"
        ? { ...event, content: scrubSecrets(event.content) }
        : event;
    try {
      this.logFileHandle.write(
        `${JSON.stringify({ ...scrubbed, timestamp: new Date().toISOString() })}\n`,
      );
    } catch {
      // Log writer failure must not break the event stream.
    }
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(scrubbed);
        } catch {
          // Swallow listener errors — a bad listener must not kill the session.
        }
      }
    } else {
      this.eventQueue.push(scrubbed);
    }
  }

  private settle(result: ProviderResult): void {
    if (this.settled) return;
    this.settled = true;
    // Resolution deferred until `runSession`'s finally-block fully cleans up
    // (see `pendingResult` rationale on the field above). Caller-visible
    // ordering: cleanup → resolve waitForCompletion.
    this.pendingResult = result;
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
      provider: "codex",
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

  /**
   * Render a completed tool item as a short, signal-dense one-liner for the
   * session-end summarization transcript. Picks tool-type-specific fields so
   * the transcript doesn't get drowned in raw JSON (a single `command_execution`
   * can carry 100KB+ of `aggregated_output`). Each branch is capped at 500
   * chars; unknown types fall back to a trimmed `JSON.stringify`.
   */
  private shortenItemResult(item: ThreadItem): string {
    switch (item.type) {
      case "command_execution": {
        const cmd = item as CommandExecutionItem;
        const stdout = (cmd.aggregated_output ?? "").slice(0, 500);
        return `exit=${cmd.exit_code ?? "?"} status=${cmd.status ?? "?"} stdout=${stdout}`;
      }
      case "file_change": {
        const fc = item as FileChangeItem;
        const summarised = (fc.changes ?? [])
          .slice(0, 5)
          .map((c) => `${c.kind}:${c.path}`)
          .join(",");
        return `changes=[${summarised}]`;
      }
      case "mcp_tool_call": {
        const mcp = item as McpToolCallItem;
        return `server=${mcp.server} tool=${mcp.tool} status=${mcp.status ?? "?"}`;
      }
      case "web_search": {
        const ws = item as WebSearchItem;
        return `query=${(ws.query ?? "").slice(0, 200)}`;
      }
      default:
        return JSON.stringify(item).slice(0, 500);
    }
  }

  private handleEvent(event: ThreadEvent): void {
    // Mirror every raw SDK event into the log as raw_log for debugability —
    // parity with Claude's JSONL envelope.
    this.emit({ type: "raw_log", content: JSON.stringify(event) });

    switch (event.type) {
      case "thread.started": {
        this._sessionId = event.thread_id;
        this.emit({ type: "session_init", sessionId: event.thread_id, provider: "codex" });
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
          // Mirror into the transcript buffer for session-end summarization.
          // Tools are the bulk of useful signal in a codex session, so we
          // capture both the start (args) and the completion (result digest).
          this.transcript.push(
            `Tool[${this.toolNameForItem(event.item)}] started: ${JSON.stringify(
              this.toolArgsForItem(event.item),
            ).slice(0, 500)}`,
          );
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
          this.transcript.push(
            `Tool[${this.toolNameForItem(item)}] completed: ${this.shortenItemResult(item)}`,
          );
          break;
        }
        switch (item.type) {
          case "agent_message": {
            const msg = item as AgentMessageItem;
            if (msg.text) {
              this.emit({ type: "message", role: "assistant", content: msg.text });
              this.transcript.push(`Assistant: ${msg.text}`);
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
            this.emit({
              type: "error",
              message: this.formatTerminalError(errItem.message).message,
            });
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
          // ui/src/pages/tasks/[id]/page.tsx renders it via `.toFixed(0)`
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
        const { message } = this.formatTerminalError(event.error.message);
        this.emit({ type: "error", message });
        break;
      }
      case "error": {
        const { message } = this.formatTerminalError(event.message);
        this.emit({ type: "error", message });
        break;
      }
    }
  }

  /**
   * Categorize a terminal error from the Codex SDK and rewrite with a clearer
   * prefix that the runner / dashboard can key on. The Codex app-server emits a
   * structured `codexErrorInfo` discriminator
   * (https://developers.openai.com/codex/app-server#errors) with values like
   * `ContextWindowExceeded`, `UsageLimitExceeded`, `Unauthorized`, etc. — but
   * `@openai/codex-sdk`'s `ThreadError` only surfaces the flat `message`
   * string, so we still detect by pattern. Patterns below match the canonical
   * `codexErrorInfo` name (which sometimes appears literally in the message)
   * AND the human-readable text Codex puts in `error.message`.
   *
   * Categories returned are consumed two ways:
   *   1. `errorCategory` on the `result` event (dashboard surfacing).
   *   2. The bracketed prefix in `failureReason` (`[usage-limit]` etc.) is
   *      what runner.ts pattern-matches to flag the credential as
   *      rate-limited in the rotation pool.
   */
  private formatTerminalError(raw: string): { message: string; category?: string } {
    const normalized = raw.toLowerCase();

    // Context window exceeded — Codex has no auto-compact like Claude.
    // See Linear DES-143 for the long-term fix.
    const overflowPatterns = [
      "context length exceeded",
      "maximum context length",
      "too many tokens",
      "input too long",
      "request too large",
      "context_length_exceeded",
      "contextwindowexceeded",
    ];
    if (overflowPatterns.some((p) => normalized.includes(p))) {
      return {
        message: `[context-overflow] Codex turn exceeded the model's context window for ${this.resolvedModel} (${this.contextWindow.toLocaleString()} tokens). Codex does not auto-compact conversation history like Claude does — start a fresh task or split the work into smaller turns. Original error: ${raw}`,
        category: "context_overflow",
      };
    }

    // Pro / business quota exhausted — codexErrorInfo: "UsageLimitExceeded".
    // Message text typically reads "You've hit your usage limit. Upgrade to Pro …".
    const usageLimitPatterns = ["usage limit", "upgrade to pro", "usagelimitexceeded"];
    if (usageLimitPatterns.some((p) => normalized.includes(p))) {
      return {
        message: `[usage-limit] Codex account quota exhausted — upgrade plan or wait for monthly reset. Original error: ${raw}`,
        category: "usage_limit",
      };
    }

    // Per-minute / per-hour API rate limiting (HTTP 429).
    const rateLimitPatterns = [
      "rate limit",
      "rate_limit",
      "ratelimit",
      "too many requests",
      "http 429",
      " 429 ",
    ];
    if (rateLimitPatterns.some((p) => normalized.includes(p))) {
      return {
        message: `[rate-limit] Codex API rate limit hit. Original error: ${raw}`,
        category: "rate_limit",
      };
    }

    // Bad / missing / invalid API key — codexErrorInfo: "Unauthorized".
    const authPatterns = [
      "unauthorized",
      "http 401",
      " 401 ",
      "invalid api key",
      "invalid_api_key",
      "missing api key",
      "no api key",
      "authentication failed",
    ];
    if (authPatterns.some((p) => normalized.includes(p))) {
      return {
        message: `[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login. Original error: ${raw}`,
        category: "authentication_failed",
      };
    }

    return { message: raw };
  }

  private async runSession(): Promise<void> {
    this.abortController = new AbortController();
    // Expose the controller to the swarm event handler so it can trigger an
    // abort from outside this method (tool-loop detection, cancellation poll).
    this.abortRef.current = this.abortController;
    let terminalError: { message: string; category?: string } | undefined;
    let sawTurnCompleted = false;

    try {
      // Inline Codex skills if the prompt starts with a slash command. If the
      // prompt doesn't begin with a recognized slash command (or the skill
      // file is missing), this returns the prompt unchanged and emits a
      // `raw_stderr` warning in the latter case.
      const resolvedPrompt = await resolveCodexPrompt(this.config.prompt, this.skillsDir, (event) =>
        this.emit(event),
      );

      // Reset + seed the transcript buffer so the session-end summarizer has
      // the user's prompt as anchor context. Subsequent appends happen in
      // `handleEvent` (tool start/end, agent_message).
      this.transcript = [`User: ${resolvedPrompt}`];

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
        errorCategory: terminalError ? (terminalError.category ?? "turn_failed") : undefined,
      });
      this.settle({
        exitCode: isError ? 1 : 0,
        sessionId: this._sessionId,
        cost,
        isError,
        failureReason: terminalError?.message,
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
      // Session-end summarization. Pure addition for codex — no behavior to
      // preserve. Wrapped in its own try/catch so summary failure must NOT
      // block the existing log/AGENTS.md cleanup below. Gate `SKIP_SESSION_SUMMARY=1`
      // matches the parity convention used by the claude Stop hook + pi/opencode.
      if (process.env.SKIP_SESSION_SUMMARY !== "1") {
        try {
          await this.summarizeAtEnd();
        } catch (err) {
          console.error("session_summary failed (codex):", err);
        }
      }

      // Detach the abort controller now that the turn has settled.
      this.abortRef.current = null;
      try {
        await this.logFileHandle.end();
      } catch {
        // Ignore log writer cleanup failures.
      }
      await this.agentsMdHandle.cleanup();

      // Resolve `waitForCompletion()` only AFTER all cleanup has finished so
      // downstream observers (tests + the runner's `.then(...)` chain) don't
      // race the finally-block side effects. Fallback to an error result if
      // we somehow never called `settle` (defensive — every codepath in the
      // try/catch above calls settle exactly once).
      const finalResult =
        this.pendingResult ??
        ({
          exitCode: 1,
          sessionId: this._sessionId,
          cost: this.buildCostData(this.lastUsage, true),
          isError: true,
          failureReason: "session did not settle",
        } as ProviderResult);
      this.resolveCompletion(finalResult);
    }
  }

  /**
   * Index a session summary into agent memory at the end of a codex turn.
   *
   * Mirrors `summarizeSessionForPi` and the claude Stop hook:
   *   1. Truncate the in-memory transcript buffer to the last 20 KB.
   *   2. Bail when the transcript is too short or the swarm context is
   *      missing (no agentId / no taskId / no apiUrl / no apiKey).
   *   3. (Optional) Pre-fetch retrievals when `MEMORY_RATERS` includes `llm`
   *      so the LLM can score them alongside the summary.
   *   4. Call `runSummarize` from `src/utils/internal-ai` (Phase 0). Returns
   *      `null` when no credential resolves — silent skip.
   *   5. Apply length/quality gate; POST to `/api/memory/index`.
   *   6. POST ratings (`events:` key, NOT `ratings:`) via `postRatings` when
   *      `MEMORY_RATERS=llm` and the LLM returned per-memory scores.
   *
   * All catches log via `console.error(..., err)` — silent-fail behavior is
   * gone. The outer try in `runSession`'s finally-block is the final safety
   * net guaranteeing existing cleanup runs regardless.
   */
  private async summarizeAtEnd(): Promise<void> {
    const transcriptStr = this.transcript.join("\n").slice(-20_000);
    const { agentId, taskId, apiUrl, apiKey } = this.config;
    if (!agentId || !taskId || !apiUrl || !apiKey) return;
    if (transcriptStr.length <= 100) return;

    const _runSummarize = this.summarizeDeps.runSummarize ?? runSummarize;
    const _fetchRetrievals = this.summarizeDeps.fetchRetrievalsForTask ?? fetchRetrievalsForTask;
    const _postRatings = this.summarizeDeps.postRatings ?? postRatings;
    const _buildRatings = this.summarizeDeps.buildRatingsFromLlm ?? buildRatingsFromLlm;

    const memoryRaters = (process.env.MEMORY_RATERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const wantRatings = memoryRaters.includes("llm");
    const retrievals = wantRatings
      ? await _fetchRetrievals({ apiUrl, apiKey, agentId, taskId }).catch(() => [])
      : [];

    const result = await _runSummarize({
      harness: "codex",
      transcript: transcriptStr,
      retrievals,
      taskContext: {
        sourceTaskId: taskId,
        agentId,
        prompt: this.config.prompt,
      },
      apiUrl,
      apiKey,
    });
    // null = no auth resolved or wrapper exhausted retries (already logged inside)
    if (!result) return;

    const summary = result.summary.trim();
    if (summary.length <= 20 || summary.toLowerCase().includes("no significant learnings")) {
      return;
    }

    const indexResp = await fetch(`${apiUrl}/api/memory/index`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
      body: JSON.stringify({
        scope: "agent",
        source: "session_summary",
        sourceTaskId: taskId,
        content: summary,
        name: "session-summary",
        agentId,
      }),
    });
    if (!indexResp.ok) {
      const text = await indexResp.text().catch(() => "");
      console.error(
        "session_summary: /api/memory/index POST failed (codex):",
        indexResp.status,
        text,
      );
      return;
    }

    if (wantRatings && result.ratings && result.ratings.length > 0) {
      const ratingEvents = _buildRatings(result.ratings, retrievals);
      if (ratingEvents.length > 0) {
        await _postRatings({
          apiUrl,
          apiKey,
          agentId,
          taskId,
          events: ratingEvents,
        }).catch((err) => console.error("session_summary: postRatings failed (codex):", err));
      }
    }
  }
}

export class CodexAdapter implements ProviderAdapter {
  readonly name = "codex";
  readonly traits = { hasMcp: true, hasLocalEnvironment: true };

  /**
   * Optional override for the skill resolver's skills directory. When unset,
   * each `CodexSession` falls back to `CODEX_SKILLS_DIR` / `~/.codex/skills`.
   * Primarily a test hook so unit tests can point the adapter at a temp dir
   * without mutating `process.env`.
   */
  private readonly skillsDir?: string;

  /**
   * Optional dependency-injection points for session-end summarization. Tests
   * pass stubs in here to exercise the summarize → index → rate flow without
   * standing up a real API server or LLM. Production callers omit this and the
   * `CodexSession` falls back to the module-level imports.
   */
  private readonly summarizeDeps: SummarizeSessionForCodexDeps;

  constructor(opts: { skillsDir?: string; summarizeDeps?: SummarizeSessionForCodexDeps } = {}) {
    this.skillsDir = opts.skillsDir;
    this.summarizeDeps = opts.summarizeDeps ?? {};
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Codex ingests per-session instructions via AGENTS.md in the cwd. Write
    // (or refresh) the managed block before we spin up the thread.
    const agentsMdHandle = await writeCodexAgentsMd(config.cwd, config.systemPrompt);

    try {
      // Resolve the model once and thread it through. Claude shortnames map
      // to Codex equivalents; everything else passes through verbatim — the
      // SDK is the source of truth for what's valid.
      const resolvedModel = resolveCodexModel(config.model);

      // Buffer warnings emitted during config-building so they're not lost
      // before `CodexSession.onEvent` attaches a listener. The buffer is
      // replayed into the session's event stream right after construction
      // via the `initialEvents` constructor parameter.
      const preSessionEvents: ProviderEvent[] = [];
      const bufferedEmit = (event: ProviderEvent) => {
        preSessionEvents.push(event);
      };

      const mergedConfig = await buildCodexConfig(config, resolvedModel, bufferedEmit);

      // Auth resolution. `codex_oauth` (in the swarm config store) wins over
      // `OPENAI_API_KEY` so users can keep an OpenAI key set for embeddings
      // without it shadowing their ChatGPT login. The entrypoint already runs
      // this same precedence at boot — this block handles local dev (where
      // the entrypoint didn't run) and any case where auth.json is stale.
      const authMode = await resolveCodexAuthMode(config, bufferedEmit);

      // `CodexOptions.env` does NOT inherit from `process.env`. Construct a
      // minimal env explicitly so the spawned Codex CLI can find its binary
      // (PATH) and HOME (for ~/.codex/auth.json). `OPENAI_API_KEY` is only
      // forwarded when auth.json is NOT in chatgpt mode — otherwise it would
      // override the OAuth login at the Codex CLI layer.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(authMode !== "chatgpt" && process.env.OPENAI_API_KEY
          ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY }
          : {}),
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
        ...(config.env ?? {}),
      };

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
        this.summarizeDeps,
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
