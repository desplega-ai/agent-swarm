import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Span, trace } from "@opentelemetry/api";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  computeContextUsedUnified,
  getContextWindowSize,
} from "../utils/context-window";
import { validateClaudeCredentials } from "../utils/credentials";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { scrubSecrets } from "../utils/secret-scrubber";
import { CTX_MODE_NUDGE_EVERY } from "./ctx-mode-env";
import { buildOtelTraceparentEnv, isHarnessOtelEnabled } from "./otel-env";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import type {
  CostData,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/**
 * Predicate used by the worker boot loop and the credential-status endpoint.
 * The claude harness needs EITHER `CLAUDE_CODE_OAUTH_TOKEN` (preferred) or
 * `ANTHROPIC_API_KEY` — both are listed as missing when neither is present.
 */
export function checkClaudeCredentials(env: Record<string, string | undefined>): CredStatus {
  if (env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  return {
    ready: false,
    missing: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    hint: "Set either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (one is enough).",
  };
}

/** Task file data written to /tmp for hook to read */
interface TaskFileData {
  taskId: string;
  agentId: string;
  startedAt: string;
}

function getTaskFilePath(pid: number): string {
  return `/tmp/agent-swarm-task-${pid}.json`;
}

async function writeTaskFile(pid: number, data: TaskFileData): Promise<string> {
  const filePath = getTaskFilePath(pid);
  await writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

async function cleanupTaskFile(pid: number): Promise<void> {
  try {
    await unlink(getTaskFilePath(pid));
  } catch {
    // File might already be deleted or never created
  }
}

/**
 * Parse `CLAUDE_BINARY` into argv prefix tokens.
 *
 * Accepts a single binary name (`"claude"`), an absolute path, or a
 * whitespace-separated command string. Trim + split on `/\s+/`. No shell parsing, no
 * quote handling — keep it tiny and predictable. Empty / missing → `["claude"]`.
 *
 * Exported for unit testing.
 */
export function parseClaudeBinary(raw: string | undefined): string[] {
  const trimmed = (raw ?? "claude").trim();
  if (trimmed === "") return ["claude"];
  return trimmed.split(/\s+/);
}

/**
 * Resolve the effective `CLAUDE_BINARY` for a worker (raw string, pre-parse).
 *
 * Precedence (highest first), mirroring `resolveHarnessProvider`:
 *   1. `resolvedEnv.CLAUDE_BINARY` — overlay from `swarm_config`
 *      (scoped repo > agent > global, applied by `fetchResolvedEnv` in
 *      `src/commands/runner.ts`). Lets operators flip a worker via
 *      `set-config` without a container restart.
 *   2. `fallbackEnv.CLAUDE_BINARY` — raw `process.env` (container env).
 *   3. `"claude"` — final default; no behavior change for users who don't set it.
 *
 * Returns the raw string (caller pipes through `parseClaudeBinary` for argv split).
 *
 * Exported for unit testing.
 */
export function resolveClaudeBinary(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): string {
  const candidate = resolvedEnv.CLAUDE_BINARY?.trim() || fallbackEnv.CLAUDE_BINARY?.trim();
  return candidate || "claude";
}

/**
 * Merge a base MCP config (typically read from `.mcp.json`) with freshly-resolved
 * installed servers from the API, and inject the per-task `X-Source-Task-Id` header
 * into the `agent-swarm` entry.
 *
 * Precedence: installed servers from the API WIN over entries already in `.mcp.json`.
 * This guards against stale credentials from a `.mcp.json` that was written once at
 * container startup and never refreshed (see issue #369). The per-session fetch
 * carries current OAuth tokens / rotated secrets / up-to-date installs.
 *
 * Exported for unit testing.
 */
export function mergeMcpConfig(
  baseConfig: { mcpServers?: Record<string, unknown> } | null,
  installedServers: Record<string, Record<string, unknown>> | null,
  taskId: string,
  contextKey?: string,
): { mcpServers: Record<string, unknown> } {
  const config: { mcpServers: Record<string, unknown> } = {
    mcpServers: { ...(baseConfig?.mcpServers ?? {}) },
  };

  // Installed servers from the API always win — fresh credentials replace stale ones.
  if (installedServers) {
    for (const [name, serverConfig] of Object.entries(installedServers)) {
      config.mcpServers[name] = serverConfig;
    }
  }

  // Find the agent-swarm server entry (could be named "agent-swarm" or similar)
  const serverKey = Object.keys(config.mcpServers).find(
    (k) =>
      k === "agent-swarm" ||
      ((config.mcpServers[k] as Record<string, unknown>)?.headers &&
        ((config.mcpServers[k] as Record<string, Record<string, unknown>>).headers?.[
          "X-Agent-ID"
        ] as unknown)),
  );
  if (serverKey) {
    const server = config.mcpServers[serverKey] as Record<string, unknown>;
    if (!server.headers) server.headers = {};
    (server.headers as Record<string, string>)["X-Source-Task-Id"] = taskId;
    if (contextKey) {
      (server.headers as Record<string, string>)["X-Context-Key"] = contextKey;
    }
  }

  return config;
}

/**
 * Create a per-session MCP config file with X-Source-Task-Id header injected
 * and installed MCP servers merged in. Each session gets its own copy at
 * `/tmp/mcp-<taskId>.json`, passed to Claude via `--mcp-config`, so the shared
 * `.mcp.json` is never modified. Returns the path, or null if there's nothing
 * to write.
 *
 * Exported for unit testing.
 */
export async function createSessionMcpConfig(
  cwd: string,
  taskId: string,
  installedServers?: Record<string, Record<string, unknown>> | null,
  contextKey?: string,
): Promise<string | null> {
  // Collect every .mcp.json from cwd up to filesystem root. Stopping at the first
  // match silently drops the swarm-managed /workspace/.mcp.json when the cloned
  // repo ships its own .mcp.json (e.g. Datadog) — so we merge all layers, with
  // rootmost winning on key conflicts.
  const mcpJsonPaths: string[] = [];
  let searchDir = cwd;
  while (true) {
    const candidate = join(searchDir, ".mcp.json");
    if (await Bun.file(candidate).exists()) {
      mcpJsonPaths.push(candidate);
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  if (mcpJsonPaths.length === 0 && !installedServers) return null;

  // Merge deepest → rootmost so rootmost (swarm) overrides cwd-ward layers.
  const mergedServers: Record<string, unknown> = {};
  for (const path of mcpJsonPaths) {
    try {
      const layer = (await Bun.file(path).json()) as { mcpServers?: Record<string, unknown> };
      if (layer?.mcpServers) Object.assign(mergedServers, layer.mcpServers);
    } catch (err) {
      console.warn(`\x1b[33m[claude]\x1b[0m Skipping malformed ${path}: ${err}`);
    }
  }

  if (Object.keys(mergedServers).length === 0 && !installedServers) return null;

  // Inject the context-mode stdio MCP server so its `ctx_*` tools survive
  // `--strict-mcp-config` (which restricts Claude to this file and structurally
  // excludes plugin-provided MCP servers). The plugin's hooks still fire via the
  // installed Claude plugin — strict-mcp-config only suppresses MCP servers, not
  // hooks. Placed BEFORE mergeMcpConfig so an API-installed server can still
  // override it (unlikely, but safe). Gated by CONTEXT_MODE_DISABLED so builds
  // and deploys without context-mode don't break.
  //
  // Server key uses the plugin naming convention (`plugin_context-mode_context-mode`)
  // so that the resulting tool names (`mcp__plugin_context-mode_context-mode__ctx_*`)
  // match the names the plugin's hooks reference in guidance text. With the bare
  // key `context-mode`, the tools would be `mcp__context-mode__ctx_*` — callable,
  // but invisible to the hook nudges that point agents at the plugin-prefixed name.
  if (process.env.CONTEXT_MODE_DISABLED !== "true") {
    mergedServers["plugin_context-mode_context-mode"] = { command: "context-mode" };
  }

  try {
    const config = mergeMcpConfig(
      { mcpServers: mergedServers },
      installedServers ?? null,
      taskId,
      contextKey,
    );
    const sessionConfigPath = `/tmp/mcp-${taskId}.json`;
    await writeFile(sessionConfigPath, JSON.stringify(config, null, 2));
    return sessionConfigPath;
  } catch (err) {
    console.warn(`\x1b[33m[claude]\x1b[0m Failed to create session MCP config: ${err}`);
    return null;
  }
}

/**
 * Build the OpenTelemetry env additions for a spawned Claude Code subprocess.
 *
 * Gated behind `SWARM_ENABLE_HARNESS_OTEL` (or the deprecated
 * `SWARM_ENABLE_CLAUDE_CODE_OTEL` alias), read per-spawn from the resolved
 * swarm-config env (`config.env`), so flipping the config takes effect on the
 * next session without a container restart. When the gate is off this returns
 * `{}` and spawn behavior is unchanged.
 *
 * When on:
 *  - Injects a W3C `TRACEPARENT` (+ `TRACESTATE` when non-empty) derived from
 *    the active worker span (see `buildOtelTraceparentEnv`). Claude Code reads
 *    `TRACEPARENT` in `-p` mode and parents its `claude_code.interaction` span
 *    to it instead of starting a fresh root — so claude's spans nest inside
 *    our `worker.session` trace.
 *  - Pins privacy-safe defaults (prompt / tool-detail / tool-content logging
 *    off, account UUID off). These are Claude-Code-specific. `scrubSecrets`
 *    does NOT run on Claude Code's exported OTEL payloads, so these stay off.
 *    Idempotent: a value already present in the resolved env (operator
 *    override) is left untouched.
 *
 * This does NOT set `CLAUDE_CODE_ENABLE_TELEMETRY` or the `OTEL_*` exporters —
 * those stay operator-controlled via swarm config, independent of this gate.
 */
export function buildClaudeCodeOtelEnv(
  sourceEnv: Record<string, string | undefined>,
  activeSpan: Span | undefined = trace.getActiveSpan(),
): Record<string, string> {
  if (!isHarnessOtelEnabled(sourceEnv)) {
    return {};
  }

  const otelEnv: Record<string, string> = {};

  const privacyDefaults: Record<string, string> = {
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
  };
  for (const [key, value] of Object.entries(privacyDefaults)) {
    if (sourceEnv[key] === undefined) {
      otelEnv[key] = value;
    }
  }

  Object.assign(otelEnv, buildOtelTraceparentEnv(sourceEnv, activeSpan));

  return otelEnv;
}

/**
 * Claude Code runtime defaults for ephemeral swarm harness sessions.
 *
 * These are plain subprocess env vars, not prompt content. They are injected
 * after the resolved swarm config so the worker enforces the memory/privacy
 * guardrails consistently per spawn. Statsig/DNT opt-out is intentionally
 * separate from our Claude Code OTel export path, which is controlled by
 * buildClaudeCodeOtelEnv.
 */
export function buildClaudeCodeRuntimeEnv(
  _sourceEnv: Record<string, string | undefined>,
): Record<string, string> {
  return {
    ENABLE_TOOL_SEARCH: "true",
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: "1",
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
    CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
    DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    DISABLE_FEEDBACK_COMMAND: "1",
    DISABLE_BUG_COMMAND: "1",
  };
}

/**
 * Resolve the path at which the per-task system prompt is staged on disk.
 *
 * Pushing the prompt as `--append-system-prompt <value>` makes the entire
 * prompt one argv element. Linux's per-arg limit is `MAX_ARG_STRLEN = 131072`
 * bytes — and the system prompt (CLAUDE.md + TOOLS.md + identity files +
 * repo CLAUDE.md) routinely runs 50–80 KB. A few growth nudges push us
 * across the cliff and `posix_spawn` returns E2BIG, killing the worker
 * (Picateclas attempts 4-6, 2026-05-28).
 *
 * `claude --append-system-prompt-file <path>` reads the prompt from disk,
 * so the argv stays bounded by the filename length and the system prompt
 * size is decoupled from the kernel's argv ceiling.
 *
 * Exported for unit testing.
 */
export function getSystemPromptFilePath(taskId: string): string {
  // The taskId is a UUID; safe to embed in a /tmp filename. Mirrors the
  // existing /tmp/agent-swarm-task-${pid}.json + /tmp/mcp-${taskId}.json
  // convention so a janitor sweeping /tmp can find all session-scoped state
  // under the same prefix.
  return `/tmp/agent-swarm-system-prompt-${taskId}.txt`;
}

class ClaudeSession implements ProviderSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private _sessionId: string | undefined;
  private completionPromise: Promise<ProviderResult>;
  private errorTracker = new SessionErrorTracker();
  private taskFilePid: number;
  private contextWindowSize: number;
  /** Path to the system-prompt temp file when one was staged for this session. */
  private systemPromptFile: string | null;
  /** Reasoning/effort level actually applied (Phase 4) — null when `applyReasoningEffort()` returned noop. */
  private appliedReasoningEffort: ReasoningEffort | null;

  constructor(
    private config: ProviderSessionConfig,
    private model: string,
    taskFilePath: string,
    taskFilePid: number,
    private sessionMcpConfig: string | null = null,
    private claudeBinaryArgv: readonly string[] = ["claude"],
    systemPromptFile: string | null = null,
    private harnessVariant?: string,
    private harnessVariantMeta?: Record<string, unknown>,
  ) {
    this.taskFilePid = taskFilePid;
    this.contextWindowSize = getContextWindowSize(model);
    this.systemPromptFile = systemPromptFile;
    const cmd = this.buildCommand();

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[36m▸\x1b[0m Spawning Claude (model: ${model}) for task ${config.taskId.slice(0, 8)}`,
    );

    const sourceEnv = config.env || process.env;
    // Gated cross-service OTel linking: when SWARM_ENABLE_HARNESS_OTEL (or the
    // deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias) is on, inject TRACEPARENT
    // from the active worker span so Claude Code's spans nest under our
    // worker.session trace. Returns {} (no-op) when off. Spread after sourceEnv
    // so the freshly-computed TRACEPARENT wins over any stale value the
    // container env might carry.
    const otelEnv = buildClaudeCodeOtelEnv(sourceEnv);
    const runtimeEnv = buildClaudeCodeRuntimeEnv(sourceEnv);
    // Phase 4 (reasoning-effort plan): env-only path — no CLI flag (`--effort`
    // is buggy in `-p` mode, see research doc). `additionalArgs` (pushed after
    // `buildCommand()`'s base argv) naturally wins over this env var per the
    // Claude CLI's own precedence if an operator puts `--effort` there.
    const reasoningApplication = applyReasoningEffort("claude", model, config.reasoningEffort);
    const reasoningEnv = reasoningApplication.kind === "claude-env" ? reasoningApplication.env : {};
    this.appliedReasoningEffort =
      reasoningApplication.kind === "claude-env" ? (config.reasoningEffort ?? null) : null;
    this.proc = Bun.spawn(cmd, {
      cwd: this.config.cwd,
      env: {
        ENABLE_PROMPT_CACHING_1H: "1",
        ...sourceEnv,
        ...runtimeEnv,
        ...otelEnv,
        ...reasoningEnv,
        TASK_FILE: taskFilePath,
        // Belt-and-braces: TASK_FILE on disk can disappear mid-session (race
        // with task lifecycle), which silently drops the Stop-hook memory
        // rater. The hook prefers these env vars when present. See PR #444.
        AGENT_SWARM_TASK_ID: config.taskId,
        AGENT_SWARM_AGENT_ID: config.agentId,
        // claude CLI strips CLAUDE_CODE_OAUTH_TOKEN from hook subprocess env
        // (security: prevents OAuth-token leakage to user-written hooks).
        // Mirror it under a name claude doesn't recognize so the Stop hook
        // can resolve the claude-cli fallback in internal-ai/credentials.ts.
        ...(sourceEnv.CLAUDE_CODE_OAUTH_TOKEN
          ? { AGENT_SWARM_CLAUDE_OAUTH_TOKEN: sourceEnv.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
        CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY,
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.completionPromise = this.processStreams();
  }

  private buildCommand(): string[] {
    const cmd = [
      ...this.claudeBinaryArgv,
      "--model",
      this.model,
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "-p",
      this.config.prompt,
    ];

    if (this.config.additionalArgs?.length) {
      cmd.push(...this.config.additionalArgs);
    }

    // System prompt is staged on disk and read via the file-flag — see
    // `getSystemPromptFilePath` for the rationale (argv E2BIG hardening,
    // Picateclas spawn-OOM, 2026-05-28). The legacy inline form is kept as
    // a fallback for the (unlikely) case where the file couldn't be staged.
    if (this.systemPromptFile) {
      cmd.push("--append-system-prompt-file", this.systemPromptFile);
    } else if (this.config.systemPrompt) {
      cmd.push("--append-system-prompt", this.config.systemPrompt);
    }

    // Use per-session MCP config to avoid race conditions with concurrent sessions
    if (this.sessionMcpConfig) {
      cmd.push("--mcp-config", this.sessionMcpConfig, "--strict-mcp-config");
    }

    return cmd;
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        listener(event);
      }
    } else {
      this.eventQueue.push(event);
    }
  }

  private async processStreams(): Promise<ProviderResult> {
    const logFileHandle = Bun.file(this.config.logFile).writer();
    let stderrOutput = "";
    let stdoutChunks = 0;
    let stderrChunks = 0;
    let lastCost: CostData | undefined;
    let partialLine = "";

    const stdoutPromise = (async () => {
      const stdout = this.proc.stdout as ReadableStream<Uint8Array> | null;
      if (!stdout) return;

      for await (const chunk of stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        // Scrub before every log-egress point: file write, listener emit, and
        // downstream pretty-print / session-logs push (all consume event.content).
        logFileHandle.write(scrubSecrets(text));

        const combined = partialLine + text;
        const parts = combined.split("\n");
        partialLine = parts.pop() || "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          this.emit({ type: "raw_log", content: scrubSecrets(trimmed) });
          this.processJsonLine(trimmed, (cost) => {
            lastCost = cost;
          });
        }
      }

      // Handle remaining partial line
      if (partialLine.trim()) {
        this.emit({ type: "raw_log", content: scrubSecrets(partialLine.trim()) });
        this.processJsonLine(partialLine.trim(), (cost) => {
          lastCost = cost;
        });
        partialLine = "";
      }
    })();

    const stderrPromise = (async () => {
      const stderr = this.proc.stderr as ReadableStream<Uint8Array> | null;
      if (!stderr) return;

      for await (const chunk of stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        parseStderrForErrors(text, this.errorTracker);
        const scrubbedText = scrubSecrets(text);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: scrubbedText, timestamp: new Date().toISOString() })}\n`,
        );
        this.emit({ type: "raw_stderr", content: scrubbedText });
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    await logFileHandle.end();
    const exitCode = await this.proc.exited;

    // Cleanup task file, per-session MCP config, and per-task system prompt
    await cleanupTaskFile(this.taskFilePid);
    if (this.sessionMcpConfig) {
      try {
        await unlink(this.sessionMcpConfig);
      } catch {
        // ignore — temp file may already be gone
      }
    }
    if (this.systemPromptFile) {
      try {
        await unlink(this.systemPromptFile);
      } catch {
        // ignore — temp file may already be gone
      }
    }

    if (exitCode !== 0 && stderrOutput) {
      console.error(
        `\x1b[31m[${this.config.role}] Full stderr for task ${this.config.taskId.slice(0, 8)}:\x1b[0m\n${scrubSecrets(stderrOutput)}`,
      );
    }

    if (stdoutChunks === 0 && stderrChunks === 0) {
      console.warn(
        `\x1b[33m[${this.config.role}] WARNING: No output from Claude for task ${this.config.taskId.slice(0, 8)} - check auth/startup\x1b[0m`,
      );
    }

    let failureReason: string | undefined;
    if (exitCode !== 0 && this.errorTracker.hasErrors()) {
      failureReason = this.errorTracker.buildFailureReason(exitCode ?? 1);
    }

    return {
      exitCode: exitCode ?? 1,
      sessionId: this._sessionId,
      cost: lastCost,
      isError: (exitCode ?? 1) !== 0,
      failureReason,
      rateLimitResetAt: this.errorTracker.getRateLimitResetAt(),
      rateLimitWindows: this.errorTracker.getRateLimitWindows(),
      appliedReasoningEffort: this.appliedReasoningEffort,
    };
  }

  private processJsonLine(trimmed: string, setCost: (cost: CostData) => void): void {
    try {
      const json = JSON.parse(trimmed);

      // Session ID from init message
      if (json.type === "system" && json.subtype === "init" && json.session_id) {
        this._sessionId = json.session_id;
        this.emit({
          type: "session_init",
          sessionId: json.session_id,
          provider: "claude",
          ...(this.harnessVariant ? { harnessVariant: this.harnessVariant } : {}),
          ...(this.harnessVariantMeta ? { harnessVariantMeta: this.harnessVariantMeta } : {}),
        });
        if (json.model) {
          // Phase 4: the CLI's `init.model` reflects the actual model after any
          // backoff/fallback. Update `this.model` so subsequent CostData rows
          // (and the pricing lookup the API runs) use the right rate.
          this.model = json.model;
          this.contextWindowSize = getContextWindowSize(json.model);
        }
      }

      // Compaction detection
      if (json.type === "system" && json.subtype === "compact_boundary" && json.compact_metadata) {
        this.emit({
          type: "compaction",
          preCompactTokens: json.compact_metadata.pre_tokens ?? 0,
          compactTrigger: json.compact_metadata.trigger ?? "auto",
          contextTotalTokens: this.contextWindowSize,
        });
      }

      // Cost data from result
      if (json.type === "result" && json.total_cost_usd !== undefined) {
        const usage = json.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
              // Phase 4: claude extended-thinking flows surface this — the
              // CLI emits `thinking_input_tokens` when the model produced
              // thinking content during the turn.
              thinking_input_tokens?: number;
            }
          | undefined;

        const cost: CostData = {
          sessionId: "", // Set by the runner with the appropriate runner session ID
          taskId: this.config.taskId,
          agentId: this.config.agentId,
          totalCostUsd: json.total_cost_usd || 0,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          // Phase 4: surface thinking tokens; previously dropped on the floor.
          thinkingTokens: usage?.thinking_input_tokens ?? 0,
          durationMs: json.duration_ms || 0,
          // Phase 4: honest null when the CLI omits num_turns instead of a
          // faked `1` (would have under-counted in dashboards).
          numTurns: json.num_turns ?? null,
          model: this.model,
          isError: json.is_error || false,
          provider: "claude",
        };
        setCost(cost);
        this.emit({
          type: "result",
          cost,
          isError: json.is_error || false,
        });

        // Update context window size from modelUsage if available
        if (json.modelUsage) {
          const modelKey = Object.keys(json.modelUsage)[0];
          if (modelKey && json.modelUsage[modelKey]?.contextWindow) {
            this.contextWindowSize = json.modelUsage[modelKey].contextWindow;
          }
        }
      }

      // Tool use from assistant messages — emit tool_start for auto-progress
      if (json.type === "assistant" && json.message) {
        const message = json.message as {
          content?: Array<{
            type: string;
            name?: string;
            id?: string;
            input?: unknown;
            text?: string;
          }>;
        };

        // Emit a `message` event BEFORE any tool_start events for this turn.
        // The runner uses this as an "assistant turn boundary" to implicit-close
        // any worker.tool spans left open by the previous turn (the Claude CLI
        // doesn't emit per-tool completion events for harness-side tools like
        // Bash/Read/Edit, so without this boundary their spans would stay open
        // until session shutdown and report inflated duration_ms).
        const text = Array.isArray(message.content)
          ? message.content
              .filter((b) => b.type === "text" && typeof b.text === "string")
              .map((b) => b.text as string)
              .join("")
          : "";
        this.emit({ type: "message", role: "assistant", content: text });

        if (message.content) {
          for (const block of message.content) {
            if (block.type === "tool_use" && block.name) {
              this.emit({
                type: "tool_start",
                toolCallId: block.id || "",
                toolName: block.name,
                args: block.input || {},
              });
            }
          }
        }

        // Context usage extraction from assistant message usage.
        // Phase 9: unified `input + cache + output` formula across every
        // provider so cross-provider percent comparisons are meaningful.
        if (json.message.usage) {
          const usage = json.message.usage;
          const contextUsed = computeContextUsedUnified({
            inputTokens: usage.input_tokens,
            cacheReadTokens: usage.cache_read_input_tokens,
            cacheCreateTokens: usage.cache_creation_input_tokens,
            outputTokens: usage.output_tokens,
          });
          const contextTotal = this.contextWindowSize;

          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: contextTotal,
            contextPercent: clampContextPercent(contextUsed, contextTotal) ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            contextFormula: CONTEXT_FORMULA,
          });
        }
      }

      trackErrorFromJson(json, this.errorTracker);
    } catch {
      // Not JSON — ignore
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush queued events
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue = [];
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    this.proc.kill("SIGTERM");
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";
  readonly traits = { hasMcp: true, hasLocalEnvironment: true };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Native resume is deprecated. Follow-up continuity is delivered via the
    // context preamble (see src/commands/context-preamble.ts). Any stray
    // resumeSessionId is logged and ignored — we always spawn a fresh session.
    if (config.resumeSessionId) {
      console.warn(
        "[claude-adapter] resumeSessionId ignored — native resume is disabled by deprecation plan",
      );
    }

    const model = config.model || "opus";

    const sourceEnv = config.env || process.env;
    const credType = validateClaudeCredentials(sourceEnv);
    console.log(`\x1b[2m[claude]\x1b[0m Using credential: ${credType}`);

    // Resolve the argv prefix. Same flags (`-p`, `--model`, ...) work across
    // alternates; only argv[0..n] changes. CLAUDE_BINARY is the low-level
    // override for custom binaries.
    //
    // `config.env` carries the swarm_config overlay (resolved repo > agent > global
    // by `fetchResolvedEnv` in src/commands/runner.ts), so operators can flip
    // a worker's binary via `set-config CLAUDE_BINARY=...` without a restart.
    // Falls back to process.env, then "claude". See `resolveClaudeBinary` above.
    const claudeBinaryRaw = resolveClaudeBinary(sourceEnv);
    const claudeBinaryArgv = parseClaudeBinary(claudeBinaryRaw);

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m Resolved claude binary: ${claudeBinaryArgv.join(" ")}`,
    );

    const taskFilePid = process.pid;
    const taskFilePath = await writeTaskFile(taskFilePid, {
      taskId: config.taskId,
      agentId: config.agentId,
      startedAt: new Date().toISOString(),
    });

    console.log(`\x1b[2m[${config.role}]\x1b[0m Task file written: ${taskFilePath}`);

    // Fetch installed MCP servers from API for this agent
    const installedServers =
      config.apiUrl && config.apiKey && config.agentId
        ? await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "claude")
        : null;
    if (installedServers) {
      console.log(
        `\x1b[2m[${config.role}]\x1b[0m Merging ${Object.keys(installedServers).length} installed MCP server(s) into session config`,
      );
    }

    // Create per-session MCP config with X-Source-Task-Id + X-Context-Key headers + installed servers (no shared-file race condition)
    const sessionMcpConfig = await createSessionMcpConfig(
      config.cwd,
      config.taskId,
      installedServers,
      config.contextKey,
    );

    // Stage the system prompt on disk so it can be passed as a file path
    // instead of one giant argv element. This is the structural fix for
    // posix_spawn E2BIG once the prompt grows past MAX_ARG_STRLEN (131,072
    // bytes) — see `getSystemPromptFilePath` and PR description for the
    // Picateclas spawn-OOM saga. Soft-fail (`systemPromptFile = null`) makes
    // the session fall back to the inline `--append-system-prompt` argv;
    // good enough since `BOOTSTRAP_TOTAL_MAX_CHARS` (now 120,000) already
    // caps the worst-case argv element below the kernel limit even without
    // the file path.
    let systemPromptFile: string | null = null;
    if (config.systemPrompt) {
      const candidate = getSystemPromptFilePath(config.taskId);
      try {
        await writeFile(candidate, config.systemPrompt);
        systemPromptFile = candidate;
      } catch (err) {
        console.warn(
          `\x1b[33m[claude]\x1b[0m Failed to stage system prompt to ${candidate} (${err}); falling back to --append-system-prompt argv. Argv may approach MAX_ARG_STRLEN if the prompt is large.`,
        );
      }
    }

    const harnessVariant = "stock";
    let harnessVariantMeta: Record<string, unknown> | undefined;
    try {
      const bin = claudeBinaryArgv[0] ?? "claude";
      const result = await Bun.$`${bin} --version`.quiet();
      const trimmed = result.text().trim();
      if (trimmed) harnessVariantMeta = { version: trimmed };
    } catch {
      // version is best-effort
    }

    return new ClaudeSession(
      config,
      model,
      taskFilePath,
      taskFilePid,
      sessionMcpConfig,
      claudeBinaryArgv,
      systemPromptFile,
      harnessVariant,
      harnessVariantMeta,
    );
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return true;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
