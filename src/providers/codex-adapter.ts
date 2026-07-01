/**
 * Codex provider adapter.
 *
 * Wraps the `@openai/codex-sdk` (which drives the `codex app-server` JSON-RPC
 * protocol via a child process). This file owns:
 *
 *   Phase 1 — factory wiring + skeleton classes.
 *   Phase 2 — event stream normalization, CostData, AbortController, log file,
 *             AGENTS.md system-prompt injection. (Native resume was removed in
 *             the 2026-05-28 deprecate-native-resume plan — see context-preamble.ts.)
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
import { getApiKey } from "../utils/api-key";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  computeContextUsedUnified,
} from "../utils/context-window";
import { SessionErrorTracker } from "../utils/error-tracker";
import { summarizeSession as runSummarize } from "../utils/internal-ai";
import { scrubSecrets } from "../utils/secret-scrubber";
import { type CodexAgentsMdHandle, writeCodexAgentsMd } from "./codex-agents-md";
import { computeCodexCostUsd, getCodexContextWindow, resolveCodexModel } from "./codex-models";
import { credentialsToAuthJson } from "./codex-oauth/auth-json.js";
import { getValidCodexOAuth } from "./codex-oauth/storage.js";
import { resolveCodexPrompt } from "./codex-skill-resolver";
import { createCodexSwarmEventHandler } from "./codex-swarm-events";
import { CTX_MODE_NUDGE_EVERY } from "./ctx-mode-env";
import { readPkgVersion } from "./harness-version";
import { buildOtelTraceparentEnv } from "./otel-env";
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
  // Pool credentials: codex_oauth_0, codex_oauth_1, ... loaded from swarm_config
  // into the resolved env. Runner materialises auth.json per-task from the pool.
  if (Object.keys(env).some((k) => /^codex_oauth_\d+$/.test(k))) {
    return {
      ready: true,
      missing: [],
      satisfiedBy: "side-effect-pending",
      hint: "Codex OAuth credential pool configured; runner will materialise auth.json per-task.",
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
export async function resolveCodexAuthMode(
  config: ProviderSessionConfig,
  emit: (event: ProviderEvent) => void,
  deps: {
    homedir?: () => string;
    fs?: {
      readFile: (path: string, encoding: "utf-8") => Promise<string>;
      mkdir: (
        path: string,
        opts: { recursive: boolean; mode: number },
      ) => Promise<string | undefined>;
      writeFile: (path: string, data: string, opts: { mode: number }) => Promise<void>;
    };
  } = {},
): Promise<string | null> {
  const fsModule = await import("node:fs/promises");
  const homedir = deps.homedir ?? os.homedir.bind(os);
  const fs = deps.fs ?? {
    readFile: (path: string, encoding: "utf-8") => fsModule.readFile(path, encoding),
    mkdir: (path: string, opts: { recursive: boolean; mode: number }) => fsModule.mkdir(path, opts),
    writeFile: (path: string, data: string, opts: { mode: number }) =>
      fsModule.writeFile(path, data, opts),
  };
  const authJsonPath = join(homedir(), ".codex", "auth.json");

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
  // api-key mode, try to restore/upgrade to OAuth.
  //
  // A defined `codexSlot` means the runner materialized auth.json for us via
  // the pool path (`resolveCodexOAuthCredentialInfo` in runner.ts), which
  // writes whatever was in the config store WITHOUT going through the locked
  // refresh in `getValidCodexOAuth`. If that materialized slot is already
  // expired, letting the spawned Codex CLI refresh straight from auth.json
  // would refresh outside `/api/oauth/refresh-locks` entirely, re-opening the
  // exact race the lock exists to prevent. So for pool slots we ALWAYS
  // revalidate/refresh/rewrite through the lock here, even when auth.json is
  // already in chatgpt mode. Non-pool (single-credential/local dev) auth.json
  // is left untouched once it's already chatgpt mode, same as before.
  //
  // Use the slot recorded by the runner for this task so refresh writes back
  // to the correct pool key (codex_oauth_<slot>) instead of always slot 0.
  const slot = config.codexSlot ?? 0;
  const isPoolSlot = config.codexSlot !== undefined;
  if (config.apiUrl && config.apiKey && (currentMode !== "chatgpt" || isPoolSlot)) {
    const oauthCreds = await getValidCodexOAuth(config.apiUrl, config.apiKey, slot);
    if (oauthCreds) {
      try {
        // For pool slots, strip the refresh token from the auth.json handed
        // to the spawned Codex CLI so it can never rotate the shared token
        // family outside the `/api/oauth/refresh-locks` lock. The locked
        // `getValidCodexOAuth` above is the sole refresher; the config store
        // retains the real refresh token. Non-pool auth.json keeps it so
        // local dev / single-credential setups can self-refresh as before.
        const authJson = credentialsToAuthJson(oauthCreds, {
          includeRefreshToken: !isPoolSlot,
        });
        await fs.mkdir(join(homedir(), ".codex"), { recursive: true, mode: 0o700 });
        await fs.writeFile(authJsonPath, JSON.stringify(authJson, null, 2), { mode: 0o600 });
        const verb =
          currentMode === null
            ? "Restored"
            : currentMode === "chatgpt"
              ? "Revalidated"
              : "Upgraded api-key auth.json to";
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

  // (4) context-mode — pre-installed stdio MCP server providing the `ctx_*`
  // context-compression tools. Gated by `CONTEXT_MODE_DISABLED` so builds /
  // deploys without the `context-mode` binary on PATH don't break the session.
  // Same entry shape as the swarm + installed-server stdio entries above.
  if (process.env.CONTEXT_MODE_DISABLED !== "true") {
    mcpServers["context-mode"] = {
      command: "context-mode",
      enabled: true,
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    };
  }

  // (1) Baseline overrides. Keep these aligned with the Dockerfile baseline
  // at `~/.codex/config.toml` (Phase 6). Repeating them here makes local dev
  // (no baseline file) behave identically to the Docker worker.
  //
  // `features.hooks` / `features.plugin_hooks` enable Codex's hook system and
  // the hooks contributed by installed Codex plugins (context-mode's plugin:
  // routing injection, PreToolUse safety blocks, output capture). The SDK
  // flattens these to `--config features.hooks=true` / `features.plugin_hooks=true`.
  return {
    model,
    approval_policy: "never",
    sandbox_mode: "danger-full-access",
    skip_git_repo_check: true,
    show_raw_agent_reasoning: false,
    features: { hooks: true, plugin_hooks: true },
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
export class CodexSession implements ProviderSession {
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
  private readonly errorTracker = new SessionErrorTracker();
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

  async abort(reason?: string): Promise<void> {
    this.aborted = true;
    this.abortController?.abort(reason ?? "cancelled");
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
    // Phase 6: Codex SDK surfaces `reasoning_output_tokens` separately from
    // `output_tokens` for reasoning models (gpt-5.3-codex, gpt-5.4 thinking).
    // Pre-fix this number was read into `lastUsage` but never reached
    // `CostData`, so reasoning-heavy sessions silently under-billed.
    const reasoningOutputTokens = usage?.reasoning_output_tokens ?? 0;
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
      reasoningOutputTokens,
      cacheReadTokens: cachedInputTokens,
      // Phase 6: undefined (NOT 0). Codex SDK can't honestly report cache
      // writes; leaving it undefined preserves that distinction in the DB
      // instead of mixing genuine zeros with "unknown".
      cacheWriteTokens: undefined,
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
        const codexVersion = readPkgVersion("@openai/codex-sdk");
        this.emit({
          type: "session_init",
          sessionId: event.thread_id,
          provider: "codex",
          ...(codexVersion ? { harnessVariantMeta: { version: codexVersion } } : {}),
        });
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
          // Phase 9: switch from the codex-specific "peak proxy" formula
          // (`uncached_input + output`) to the unified
          // `input + cache_read + cache_create + output` so cross-provider
          // percent comparisons are meaningful.
          //
          // Note: Codex's `input_tokens` already includes cached_input_tokens
          // (it's the TOTAL across the turn — see the longer comment that
          // used to live here, preserved in git history). We therefore pass
          // `cacheReadTokens: 0` to avoid double-counting the cached portion.
          // The trade-off the old comment flagged is still real — a chatty
          // turn can over-report because `input_tokens` is the SUM across
          // every model call in the turn — but having the SAME formula
          // everywhere wins over the local optimum. Clamp catches the
          // chatty-turn overshoot at 100%. Old rows tagged 'peak-proxy'
          // remain in `task_context_snapshots`; the UI surfaces both.
          const contextUsed = computeContextUsedUnified({
            inputTokens: event.usage.input_tokens,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            outputTokens: event.usage.output_tokens,
          });
          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: this.contextWindow,
            contextPercent: clampContextPercent(contextUsed, this.contextWindow) ?? 0,
            outputTokens: event.usage.output_tokens,
            contextFormula: CONTEXT_FORMULA,
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
            this.errorTracker.processCodexUsageLimitMessage(event.error.message);
          }
          if (event.type === "error" && !terminalError) {
            terminalError = this.formatTerminalError(event.message);
            this.errorTracker.processCodexUsageLimitMessage(event.message);
          }
        }
      } catch (err) {
        // AbortError from the SDK propagates here when signal.abort() fires.
        if (this.aborted || (err instanceof Error && err.name === "AbortError")) {
          // Prefer the abort reason from the signal (set by the caller of
          // abort()) — this distinguishes tool-loop aborts from cancel-poll
          // and graceful-shutdown aborts that all used to produce a bare
          // "cancelled" failureReason.
          const abortReason =
            typeof this.abortController?.signal.reason === "string"
              ? this.abortController.signal.reason
              : "cancelled";
          const cost = this.buildCostData(this.lastUsage, true);
          this.emit({ type: "result", cost, isError: true, errorCategory: "cancelled" });
          this.settle({
            exitCode: 130,
            sessionId: this._sessionId,
            cost,
            isError: true,
            failureReason: abortReason,
          });
          return;
        }
        // The Codex CLI exits with code 1 after emitting a UsageLimitReached or
        // other terminal error event. The SDK then throws "Codex Exec exited with
        // code 1: Reading prompt from stdin" AFTER the event loop ends, which
        // would overwrite the structured terminalError we already captured above.
        // Preserve the structured error so the [usage-limit] prefix survives to
        // the runner's rate-limit resolver.
        if (terminalError) {
          const cost = this.buildCostData(this.lastUsage, true);
          this.emit({
            type: "result",
            cost,
            isError: true,
            errorCategory: terminalError.category ?? "turn_failed",
          });
          this.settle({
            exitCode: 1,
            sessionId: this._sessionId,
            cost,
            isError: true,
            failureReason: terminalError.message,
            rateLimitResetAt: this.errorTracker.getRateLimitResetAt(),
            rateLimitWindows: this.errorTracker.getRateLimitWindows(),
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
        rateLimitResetAt: this.errorTracker.getRateLimitResetAt(),
        rateLimitWindows: this.errorTracker.getRateLimitWindows(),
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
        rateLimitResetAt: this.errorTracker.getRateLimitResetAt(),
        rateLimitWindows: this.errorTracker.getRateLimitWindows(),
      });
    } finally {
      // Session-end summarization. Pure addition for codex — no behavior to
      // preserve. Wrapped in its own try/catch so summary failure must NOT
      // block the existing log/AGENTS.md cleanup below. Gate `SKIP_SESSION_SUMMARY=1`
      // matches the parity convention used by the claude Stop hook + pi/opencode.
      //
      // Skip the summary entirely when the session was aborted. The transcript
      // is incomplete, the LLM call would retry 3× through openrouter and
      // spam stderr with structured-output failures (red-herring noise we
      // saw in the templates-ui incident, 2026-05-28). Losing the summary
      // on abort is acceptable — it's cleanup, not load-bearing.
      const sessionWasAborted =
        this.aborted ||
        this.abortController?.signal.aborted === true ||
        this.pendingResult?.exitCode === 130;
      if (process.env.SKIP_SESSION_SUMMARY !== "1" && !sessionWasAborted) {
        try {
          await this.summarizeAtEnd();
        } catch (err) {
          console.error("session_summary failed (codex):", err);
        }
      } else if (sessionWasAborted) {
        console.debug("[codex] session aborted — skipping session_summary");
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

/**
 * Build a `CodexSession` running in the *current* process (no subprocess
 * isolation). Production sessions are now spawned through
 * `CodexSubprocessSession` to keep the runner's heap bounded across many
 * task completions (Picateclas spawn-OOM, 2026-05-28). This helper is the
 * core in-process creation logic — used by:
 *
 *   1. `CodexAdapter.createSession` when `bypassSubprocess: true`
 *      (unit tests that monkey-patch the SDK prototype).
 *   2. `runCodexSessionRunner` (the spawned subprocess entry point in
 *      `src/commands/codex-session-runner.ts`).
 *
 * Exported so the subprocess runner — which IS a fresh process — can build
 * its session via the same path the tests exercise.
 */
export async function createInProcessCodexSession(
  config: ProviderSessionConfig,
  opts: { skillsDir?: string; summarizeDeps?: SummarizeSessionForCodexDeps } = {},
): Promise<CodexSession> {
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
      CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY,
      ...(config.env ?? {}),
      // Gated cross-service OTel linking: when SWARM_ENABLE_HARNESS_OTEL (or
      // the deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias) is on, inject
      // TRACEPARENT from the active worker span so Codex's spans nest under
      // our worker.session trace. Codex's Rust OTEL SDK reads W3C trace
      // context from the env via the default tracecontext propagator.
      // Returns {} (no-op) when off; spread last so the computed value wins.
      ...buildOtelTraceparentEnv(config.env ?? process.env),
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

    // Native resume is deprecated. Follow-up continuity is delivered via the
    // context preamble (see src/commands/context-preamble.ts). Any stray
    // resumeSessionId is logged and ignored — we always start a fresh thread.
    if (config.resumeSessionId) {
      console.warn(
        "[codex-adapter] resumeSessionId ignored — native resume is disabled by deprecation plan",
      );
    }
    const thread = codex.startThread(threadOptions);

    return new CodexSession(
      thread,
      config,
      agentsMdHandle,
      resolvedModel,
      preSessionEvents,
      opts.skillsDir,
      opts.summarizeDeps ?? {},
    );
  } catch (err) {
    // If we failed to construct the thread, clean up the managed AGENTS.md
    // block so we don't leak state on the filesystem.
    await agentsMdHandle.cleanup();
    throw err;
  }
}

/**
 * Resolve the argv used to re-launch agent-swarm as a subprocess.
 *
 * The codex subprocess runner (`src/commands/codex-session-runner.ts`) is
 * invoked via the `codex-session-runner` CLI subcommand. Compiled and dev
 * modes differ in how `process.argv` is laid out:
 *
 *   - Compiled (`./agent-swarm worker ...`): argv = ["./agent-swarm", "worker", ...]
 *     → re-launch is just [process.execPath, "codex-session-runner"].
 *   - Dev (`bun src/cli.tsx worker ...`): argv = ["bun", ".../cli.tsx", "worker", ...]
 *     → re-launch is [process.execPath, ".../cli.tsx", "codex-session-runner"].
 *
 * We pick the dev path when argv[1] looks like a .ts/.tsx/.js/.jsx file (i.e.
 * a path the runtime is interpreting); otherwise we assume compiled.
 * `AGENT_SWARM_CODEX_RUNNER_ARGV` lets operators / tests override the prefix
 * (JSON-encoded string array).
 *
 * Exported for unit testing.
 */
export function resolveCodexRunnerArgv(): string[] {
  const override = process.env.AGENT_SWARM_CODEX_RUNNER_ARGV;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        return parsed as string[];
      }
    } catch {
      // fall through to inferred resolution
    }
  }
  const execPath = process.execPath;
  const scriptArg = process.argv[1];
  if (scriptArg && /\.(t|j)sx?$/.test(scriptArg)) {
    return [execPath, scriptArg, "codex-session-runner"];
  }
  return [execPath, "codex-session-runner"];
}

/** JSON payload passed to the codex subprocess runner via stdin. */
interface CodexSubprocessInput {
  config: ProviderSessionConfig;
  skillsDir?: string;
  /**
   * W3C TRACEPARENT for the parent `worker.session.create` span. Captured in
   * the parent (where the OTel span context is live) and forwarded so the
   * subprocess can pass it on to Codex via env. We deliberately do NOT use
   * `buildOtelTraceparentEnv` inside the subprocess — it would build from a
   * fresh tracer with no active span. The runner forwards what the parent
   * captured here back into `config.env` before constructing the SDK.
   */
  parentOtelEnv?: Record<string, string>;
}

/**
 * `ProviderSession` that runs the entire codex session inside a fresh
 * subprocess. This is the Picateclas spawn-OOM permanent fix — every codex
 * session's heap (SDK state, transcript buffer, JSON-RPC parser, listeners)
 * dies with the subprocess. The runner's own VSZ stays bounded across
 * thousands of task completions.
 *
 * Wire protocol over stdout (line-delimited JSON):
 *   {"kind":"event", "event": <ProviderEvent>}
 *   {"kind":"result", "result": <ProviderResult>}
 *
 * stderr is forwarded verbatim into the runner's stdout (for prod logs).
 */
class CodexSubprocessSession implements ProviderSession {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly completionPromise: Promise<ProviderResult>;
  private _sessionId: string | undefined;

  constructor(config: ProviderSessionConfig, skillsDir: string | undefined) {
    const argv = resolveCodexRunnerArgv();
    const payload: CodexSubprocessInput = {
      config,
      skillsDir,
      // Capture the parent's OTel TRACEPARENT here, in the span context the
      // runner established. The subprocess can't reconstruct it on its own
      // since its OTel tracer doesn't share the parent's active-span state.
      parentOtelEnv: buildOtelTraceparentEnv(config.env ?? process.env),
    };

    const apiKey = getApiKey();

    this.proc = Bun.spawn(argv, {
      // Minimal env: forward what the subprocess needs to talk to the API,
      // load the codex CLI binary, and read OAuth tokens. config.env (which
      // already includes the swarm-config overlay) is delivered via stdin
      // — NOT here — so we don't repeat the same string in two places.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.NODE_EXTRA_CA_CERTS
          ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
          : {}),
        ...(process.env.MCP_BASE_URL ? { MCP_BASE_URL: process.env.MCP_BASE_URL } : {}),
        ...(apiKey ? { AGENT_SWARM_API_KEY: apiKey, API_KEY: apiKey } : {}),
        // Embedding / summarization paths read these:
        ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
        ...(process.env.OPENROUTER_API_KEY
          ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
          : {}),
        ...(process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : {}),
        ...(process.env.CODEX_PATH_OVERRIDE
          ? { CODEX_PATH_OVERRIDE: process.env.CODEX_PATH_OVERRIDE }
          : {}),
        ...(process.env.CODEX_SKILLS_DIR ? { CODEX_SKILLS_DIR: process.env.CODEX_SKILLS_DIR } : {}),
        CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY,
        ...(process.env.SKIP_SESSION_SUMMARY
          ? { SKIP_SESSION_SUMMARY: process.env.SKIP_SESSION_SUMMARY }
          : {}),
        ...(process.env.MEMORY_RATERS ? { MEMORY_RATERS: process.env.MEMORY_RATERS } : {}),
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // `Bun.spawn`'s `stdin` is typed as `number | FileSink`; with `stdin:
    // "pipe"` it is always a FileSink. Narrow via assertion.
    const stdin = this.proc.stdin as { write(s: string): void; end(): void };
    stdin.write(JSON.stringify(payload));
    stdin.end();

    this.completionPromise = this.processStreams();
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue.length = 0;
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    this.proc.kill("SIGTERM");
  }

  private emit(event: ProviderEvent): void {
    if (event.type === "session_init" && event.sessionId) {
      this._sessionId = event.sessionId;
    }
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // listener errors must not break the event stream
        }
      }
    } else {
      this.eventQueue.push(event);
    }
  }

  private async processStreams(): Promise<ProviderResult> {
    let result: ProviderResult | null = null;
    let partial = "";
    let stderrTail = "";

    const stdoutPromise = (async () => {
      const stdout = this.proc.stdout as ReadableStream<Uint8Array> | null;
      if (!stdout) return;
      for await (const chunk of stdout) {
        partial += new TextDecoder().decode(chunk);
        const parts = partial.split("\n");
        partial = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.handleLine(trimmed, (r) => {
            result = r;
          });
        }
      }
      if (partial.trim()) {
        this.handleLine(partial.trim(), (r) => {
          result = r;
        });
        partial = "";
      }
    })();

    const stderrPromise = (async () => {
      const stderr = this.proc.stderr as ReadableStream<Uint8Array> | null;
      if (!stderr) return;
      for await (const chunk of stderr) {
        const text = new TextDecoder().decode(chunk);
        stderrTail = (stderrTail + text).slice(-2000);
        // Surface subprocess stderr (codex CLI warnings, auth.json
        // restoration messages) into the parent's event stream so it lands
        // in /workspace/logs/*.jsonl the way the in-process path did.
        this.emit({ type: "raw_stderr", content: text });
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await this.proc.exited;

    if (result) {
      return result;
    }
    // Subprocess exited before sending a structured result — synthesise one
    // so the runner doesn't hang on waitForCompletion. Include stderr tail
    // so the actual error message reaches the task failure reason.
    const stderrHint = stderrTail.trim() ? ` — stderr: ${stderrTail.trim().slice(-500)}` : "";
    return {
      exitCode: exitCode ?? 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: `codex subprocess exited (code=${exitCode ?? "?"}) without a structured result${stderrHint}`,
    };
  }

  private handleLine(line: string, setResult: (r: ProviderResult) => void): void {
    let msg: { kind?: string; event?: ProviderEvent; result?: ProviderResult; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      // Not a valid JSON envelope — treat as raw stderr-equivalent.
      this.emit({ type: "raw_stderr", content: `${line}\n` });
      return;
    }
    if (msg.kind === "event" && msg.event) {
      this.emit(msg.event);
      return;
    }
    if (msg.kind === "result" && msg.result) {
      setResult(msg.result);
      return;
    }
    if (msg.kind === "error" && msg.message) {
      this.emit({ type: "error", message: msg.message });
      setResult({
        exitCode: 1,
        sessionId: this._sessionId,
        isError: true,
        failureReason: msg.message,
      });
      return;
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

  /**
   * When true, run the codex session inside the runner process (no subprocess
   * spawn). Used by:
   *   - Unit tests that monkey-patch `Codex.prototype.startThread` (the patch
   *     would not survive a subprocess boundary).
   *   - The spawned `codex-session-runner` subprocess itself, to avoid
   *     re-spawning recursively.
   *
   * Production callers leave this `false`. Each codex session then runs in a
   * fresh subprocess and its heap dies when the task completes — keeping the
   * runner's VSZ bounded across thousands of task completions (Picateclas
   * spawn-OOM permanent fix, 2026-05-28).
   */
  private readonly bypassSubprocess: boolean;

  constructor(
    opts: {
      skillsDir?: string;
      summarizeDeps?: SummarizeSessionForCodexDeps;
      bypassSubprocess?: boolean;
    } = {},
  ) {
    this.skillsDir = opts.skillsDir;
    this.summarizeDeps = opts.summarizeDeps ?? {};
    this.bypassSubprocess = opts.bypassSubprocess ?? false;
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    if (this.bypassSubprocess) {
      return createInProcessCodexSession(config, {
        skillsDir: this.skillsDir,
        summarizeDeps: this.summarizeDeps,
      });
    }
    return new CodexSubprocessSession(config, this.skillsDir);
  }

  async canResume(_sessionId: string): Promise<boolean> {
    // Native resume is deprecated; runner no longer threads resumeSessionId
    // to adapters. Follow-up continuity flows via the context preamble.
    return false;
  }

  formatCommand(commandName: string): string {
    // Codex has no native slash-command system. Phase 4 adds a skill resolver
    // that inlines the matching SKILL.md content into the turn prompt before
    // it reaches `thread.runStreamed()`. The leading `/<name>` token here is
    // the marker the resolver looks for (mirrors Claude's format).
    return `/${commandName}`;
  }
}
