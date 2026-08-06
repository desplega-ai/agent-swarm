import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Span, trace } from "@opentelemetry/api";
import {
  type RunStopHookSessionSummaryOpts,
  runStopHookSessionSummarySubprocess,
} from "../hooks/hook";
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
  ProviderTraits,
  SteerDelivery,
  SteerDeliveryResult,
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

const MIN_CLAUDE_QUEUE_STEERING_VERSION = [2, 1, 205] as const;

/**
 * Operator kill-switch for the stream-json invocation path.
 *
 * Queued steering on the raw CLI requires `--input-format stream-json`, which
 * replaces `-p <prompt>` with a stdin message — a change to how *every* claude
 * task is launched, not just steered ones. `CLAUDE_QUEUE_STEERING=0` forces the
 * long-standing `-p` invocation back without a code change; `=1` forces the
 * stream-json path without probing. Unset (the default) probes `--version`.
 */
function resolveClaudeQueueSteeringOverride(
  env: Record<string, string | undefined>,
): boolean | undefined {
  const raw = env.CLAUDE_QUEUE_STEERING?.trim().toLowerCase();
  if (!raw) return undefined;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  return undefined;
}

function supportsClaudeQueueSteering(versionOutput: string | undefined): boolean {
  const match =
    versionOutput?.match(/claude(?: code)? version:\s*(\d+)\.(\d+)\.(\d+)/i) ??
    versionOutput?.match(/(\d+)\.(\d+)\.(\d+)\s*\(Claude Code\)/i);
  if (!match) return false;

  const detected = match.slice(1, 4).map(Number);
  for (let index = 0; index < MIN_CLAUDE_QUEUE_STEERING_VERSION.length; index++) {
    const actual = detected[index] ?? 0;
    const minimum = MIN_CLAUDE_QUEUE_STEERING_VERSION[index] ?? 0;
    if (actual !== minimum) return actual > minimum;
  }
  return true;
}

function claudeUserMessage(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  })}\n`;
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

const CLAUDE_BRIDGE_BINARY = "claude-bridge";
const CLAUDE_BRIDGE_LOCAL_AUTH_ARG = "--desplega-local-auth";
const LEGACY_CLAUDE_BRIDGE_COMPAT_BINARY = "shan" + "non";
const CLAUDE_BRIDGE_LOCAL_AUTH_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
] as const;

/**
 * Parse a boolean env toggle. Only true/1 enable and false/0 disable; unset
 * and invalid values are treated as disabled.
 *
 * Exported for unit testing.
 */
export function parseClaudeBridgeEnabled(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

/**
 * Resolve the reloadable claude-bridge toggle from the same resolved-env
 * overlay used for `CLAUDE_BINARY`.
 *
 * Exported for unit testing.
 */
export function resolveClaudeBridgeEnabled(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): boolean {
  const candidate =
    resolvedEnv.SWARM_USE_CLAUDE_BRIDGE?.trim() || fallbackEnv.SWARM_USE_CLAUDE_BRIDGE?.trim();
  return parseClaudeBridgeEnabled(candidate);
}

/**
 * Resolve the claude binary argv, gating claude-bridge on an OAuth token.
 *
 * claude-bridge exists to keep subscription/OAuth billing correct by driving
 * the real interactive Claude TUI in tmux. It authenticates the child claude
 * from `CLAUDE_CODE_OAUTH_TOKEN` only — it deliberately strips `ANTHROPIC_*`
 * from the launched process — so it cannot run on an Anthropic API key. And
 * API-key billing is identical headless vs interactive, so there's no reason to
 * pay the bridge's complexity/footguns when only an API key is available.
 *
 * Therefore: only route through claude-bridge when an OAuth token is present.
 * If the bridge is requested (`SWARM_USE_CLAUDE_BRIDGE`) but no OAuth token is
 * set, fall back to stock `claude`, which Claude Code authenticates fine from
 * the API key. `bridgeRequestedWithoutOAuth` lets the caller log why.
 *
 * Exported for unit testing.
 */
export function resolveClaudeBinaryArgv(
  resolvedEnv: Record<string, string | undefined>,
  fallbackEnv: Record<string, string | undefined> = process.env,
): {
  raw: string;
  argv: string[];
  useClaudeBridge: boolean;
  bridgeRequestedWithoutOAuth: boolean;
} {
  const bridgeRequested = resolveClaudeBridgeEnabled(resolvedEnv, fallbackEnv);
  const hasOAuthToken = Boolean(
    (resolvedEnv.CLAUDE_CODE_OAUTH_TOKEN ?? fallbackEnv.CLAUDE_CODE_OAUTH_TOKEN)?.trim(),
  );
  const useClaudeBridge = bridgeRequested && hasOAuthToken;
  const raw = useClaudeBridge
    ? CLAUDE_BRIDGE_BINARY
    : resolveClaudeBinary(resolvedEnv, fallbackEnv);
  return {
    raw,
    argv: parseClaudeBinary(raw),
    useClaudeBridge,
    bridgeRequestedWithoutOAuth: bridgeRequested && !hasOAuthToken,
  };
}

function isLegacyClaudeBridgeCompatBinary(raw: string): boolean {
  return raw.toLowerCase().includes(LEGACY_CLAUDE_BRIDGE_COMPAT_BINARY);
}

function withClaudeBridgeAuthArgs(
  argv: readonly string[],
  sourceEnv: Record<string, string | undefined>,
): string[] {
  if (sourceEnv.CLAUDE_CODE_OAUTH_TOKEN) {
    return [...argv];
  }

  if (CLAUDE_BRIDGE_LOCAL_AUTH_ENV_VARS.some((name) => sourceEnv[name])) {
    return [...argv, CLAUDE_BRIDGE_LOCAL_AUTH_ARG];
  }

  return [...argv];
}

/**
 * Pre-seed `~/.claude.json` so the per-project trust-dialog ("Quick safety
 * check: Is this a project you trust?") doesn't block on first run.
 *
 * Mirrors the onboarding-skip hack in `Dockerfile.worker` (which writes
 * `hasCompletedOnboarding` and `bypassPermissionsModeAccepted`). When the
 * resolved binary runs interactive claude inside tmux, claude does NOT
 * reliably auto-accept the dialog, so the pane can hang forever. Writing
 * `projects[cwd].hasTrustDialogAccepted = true` (and `hasCompletedProjectOnboarding`)
 * tells claude-code the cwd is pre-trusted.
 *
 * Idempotent (no-op when already true), read-merge-write (never clobbers
 * other keys), graceful on missing / malformed file.
 *
 * Exported for unit testing.
 */
export async function preseedClaudeTrustDialog(
  cwd: string,
  // Prefer `$HOME` over `homedir()` so callers in tests / sandboxed envs that
  // override HOME get the override. Bun's `os.homedir()` caches the real
  // passwd entry at process boot and ignores HOME mutations.
  homeDir: string = process.env.HOME ?? homedir(),
): Promise<void> {
  const claudeJsonPath = join(homeDir, ".claude.json");
  let data: Record<string, unknown> = {};
  try {
    const raw = await readFile(claudeJsonPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or malformed — start from {}
    console.warn(
      `\x1b[33m[claude]\x1b[0m Starting with empty .claude.json for trust pre-seed at ${claudeJsonPath}`,
    );
  }

  const projects = (data.projects ?? {}) as Record<string, Record<string, unknown>>;
  const existing = projects[cwd] ?? {};
  if (existing.hasTrustDialogAccepted === true) {
    // Already trusted — no-op, no write.
    return;
  }

  projects[cwd] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  data.projects = projects;

  await writeFile(claudeJsonPath, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `\x1b[2m[claude]\x1b[0m Pre-seeded trust dialog acceptance for ${cwd} in ${claudeJsonPath}`,
  );
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
  private stdinWriter:
    | {
        write(value: string): unknown;
        flush?(): unknown;
        end(): unknown;
      }
    | undefined;
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
  /** Last non-empty assistant text seen; surfaced as ProviderResult.output — same pattern as pi-mono/claude-managed. */
  private lastAssistantText = "";
  /** Per-session stream-json transcript used by the parent-owned session summarizer. */
  private transcript: string[];
  readonly deliverSteering?: (delivery: SteerDelivery) => Promise<SteerDeliveryResult>;

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
    private readonly queueSteeringSupported = false,
    private readonly runSessionSummary: (
      opts: RunStopHookSessionSummaryOpts,
    ) => Promise<void> = runStopHookSessionSummarySubprocess,
  ) {
    this.taskFilePid = taskFilePid;
    this.contextWindowSize = getContextWindowSize(model);
    this.systemPromptFile = systemPromptFile;
    this.transcript = [`User: ${scrubSecrets(config.prompt)}`];
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
    // Phase 4 (reasoning-effort plan): env-only path. `additionalArgs` (pushed
    // after `buildCommand()`'s base argv) naturally wins over this env var per
    // the Claude CLI's own precedence if an operator puts `--effort` there.
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
        // The parent adapter owns a reliable in-memory stream-json transcript.
        // Prevent the child Stop hook from attempting the missing CLI artifact.
        AGENT_SWARM_ADAPTER_SESSION_SUMMARY: "1",
        // claude CLI strips CLAUDE_CODE_OAUTH_TOKEN from hook subprocess env
        // (security: prevents OAuth-token leakage to user-written hooks).
        // Mirror it under a name claude doesn't recognize so the Stop hook
        // can resolve the claude-cli fallback in internal-ai/credentials.ts.
        ...(sourceEnv.CLAUDE_CODE_OAUTH_TOKEN
          ? { AGENT_SWARM_CLAUDE_OAUTH_TOKEN: sourceEnv.CLAUDE_CODE_OAUTH_TOKEN }
          : {}),
        CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY,
      } as Record<string, string>,
      // Only pipe stdin on the stream-json path; on the `-p` path the child
      // has never had a stdin pipe and must not start waiting for one.
      ...(this.queueSteeringSupported ? { stdin: "pipe" as const } : {}),
      stdout: "pipe",
      stderr: "pipe",
    });

    if (this.queueSteeringSupported) {
      const stdin = this.proc.stdin;
      if (stdin && typeof stdin !== "number") {
        this.stdinWriter = stdin as {
          write(value: string): unknown;
          flush?(): unknown;
          end(): unknown;
        };
        void this.writeUserMessage(this.config.prompt).catch((err) => {
          console.warn(
            `\x1b[33m[claude]\x1b[0m Failed to write initial prompt to Claude stdin: ${scrubSecrets(String(err))}`,
          );
          this.closeStdin();
          try {
            this.proc.kill("SIGTERM");
          } catch {
            // The subprocess may already have exited after the broken pipe.
          }
        });
      } else {
        console.warn(
          "\x1b[33m[claude]\x1b[0m Claude stdin was not piped; terminating the session to avoid waiting without a prompt.",
        );
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // The subprocess may already have exited.
        }
      }
    }

    if (this.queueSteeringSupported && this.stdinWriter) {
      this.deliverSteering = async ({
        mode,
        text,
      }: SteerDelivery): Promise<SteerDeliveryResult> => {
        if (mode === "steer") {
          console.warn(
            "[claude-adapter] Interrupt requested; raw Claude CLI supports queued steering only, so the message will run at the next turn boundary.",
          );
        }

        if (!this.stdinWriter) {
          return { delivered: false, reason: "Claude stdin is closed" };
        }

        try {
          this.transcript.push(`User: ${scrubSecrets(text)}`);
          await this.writeUserMessage(text);
          // Interrupt is SDK-only; raw CLI stream-json queues. Always report queue.
          return { delivered: true, mode: "queue" };
        } catch (err) {
          this.closeStdin();
          return {
            delivered: false,
            reason: `Claude stdin write failed: ${String(err)}`,
          };
        }
      };
    }

    this.completionPromise = this.processStreams();
  }

  private async writeUserMessage(text: string): Promise<void> {
    const writer = this.stdinWriter;
    if (!writer) throw new Error("Claude stdin is closed");

    await writer.write(claudeUserMessage(text));
    await writer.flush?.();
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
    ];

    // Queued steering needs `--input-format stream-json`, which is mutually
    // exclusive with `-p <prompt>` — the prompt then arrives as the first
    // stdin message instead. Only take that path when the CLI is new enough
    // to honor it; otherwise keep the long-standing `-p` invocation so an
    // older worker image behaves exactly as it did before steering existed.
    if (this.queueSteeringSupported) {
      cmd.push("--input-format", "stream-json");
    } else {
      cmd.push("-p", this.config.prompt);
    }

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

  private closeStdin(): void {
    const writer = this.stdinWriter;
    this.stdinWriter = undefined;
    if (!writer) return;

    try {
      const result = writer.end();
      void Promise.resolve(result).catch(() => {});
    } catch {
      // Best-effort cleanup: a completed child commonly closes the pipe first.
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

    try {
      await Promise.all([stdoutPromise, stderrPromise]);
    } finally {
      this.closeStdin();
    }
    await logFileHandle.end();
    const exitCode = await this.proc.exited;

    const transcript = this.transcript.join("\n");
    if (transcript.length <= 100) {
      console.warn(
        `session_summary skipped (claude): transcript too short (${transcript.length} chars)`,
      );
    } else {
      try {
        await this.runSessionSummary({
          agentId: this.config.agentId,
          transcript,
          env: {
            ...process.env,
            ...this.config.env,
            AGENT_SWARM_TASK_ID: this.config.taskId,
            MCP_BASE_URL: this.config.apiUrl,
            AGENT_SWARM_API_KEY: this.config.apiKey,
          },
        });
      } catch (err) {
        console.error("session_summary failed (claude):", scrubSecrets(String(err)));
      }
    }

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
      output: this.lastAssistantText || undefined,
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

      // In stream-json input mode Claude waits for EOF even after emitting a
      // successful result. End stdin at that turn boundary so normal tasks can
      // exit; steering messages written during the turn are already buffered
      // ahead of the EOF and are still processed as subsequent turns.
      if (json.type === "result") {
        this.closeStdin();
      }

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
              cache_creation?: {
                ephemeral_5m_input_tokens?: unknown;
                ephemeral_1h_input_tokens?: unknown;
              };
              // Phase 4: claude extended-thinking flows surface this — the
              // CLI emits `thinking_input_tokens` when the model produced
              // thinking content during the turn.
              thinking_input_tokens?: number;
            }
          | undefined;
        // Rejects non-numbers outright: Number(null) is 0, and a null costUSD
        // must surface as "unknown", never "$0".
        const toFiniteNumber = (value: unknown): number | undefined =>
          typeof value === "number" && Number.isFinite(value) ? value : undefined;
        const cacheCreation = usage?.cache_creation;
        const cacheWrite5mTokens = cacheCreation
          ? toFiniteNumber(cacheCreation.ephemeral_5m_input_tokens)
          : undefined;
        const cacheWrite1hTokens = cacheCreation
          ? toFiniteNumber(cacheCreation.ephemeral_1h_input_tokens)
          : undefined;
        // Token counters are load-bearing downstream: the server gives models[]
        // precedence over top-level usage for BOTH row token totals and pricing,
        // so a zero-filled counter would store a fabricated $0 'pricing-table'
        // row. Negative counts would be rejected by the wire schema and void
        // the whole cost write.
        const toTokenCount = (value: unknown): number | undefined => {
          const n = toFiniteNumber(value);
          return n !== undefined && n >= 0 ? n : undefined;
        };
        const mappedModels =
          json.modelUsage && typeof json.modelUsage === "object" && !Array.isArray(json.modelUsage)
            ? Object.entries(json.modelUsage as Record<string, unknown>).map(([model, entry]) => {
                const modelUsage =
                  entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
                if (!modelUsage) return null;
                const inputTokens = toTokenCount(modelUsage.inputTokens);
                const outputTokens = toTokenCount(modelUsage.outputTokens);
                const cacheReadTokens = toTokenCount(modelUsage.cacheReadInputTokens);
                const cacheWriteTokens = toTokenCount(modelUsage.cacheCreationInputTokens);
                if (
                  inputTokens === undefined ||
                  outputTokens === undefined ||
                  cacheReadTokens === undefined ||
                  cacheWriteTokens === undefined
                ) {
                  return null;
                }
                // Advisory fields degrade per-field: a malformed value is
                // omitted without invalidating the entry.
                const webSearchRequests = toTokenCount(modelUsage.webSearchRequests);
                const harnessCostUsd = toFiniteNumber(modelUsage.costUSD);
                return {
                  model,
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheWriteTokens,
                  ...(webSearchRequests === undefined ? {} : { webSearchRequests }),
                  ...(harnessCostUsd === undefined ? {} : { harnessCostUsd }),
                };
              })
            : undefined;
        // One malformed entry poisons the whole breakdown — a partial list
        // would silently undercount the session. Fall back to top-level usage
        // (the pre-breakdown path) instead of manufacturing zeros.
        const models =
          mappedModels && mappedModels.length > 0 && mappedModels.every((m) => m !== null)
            ? (mappedModels as NonNullable<CostData["models"]>)
            : undefined;

        const cost: CostData = {
          sessionId: "", // Set by the runner with the appropriate runner session ID
          taskId: this.config.taskId,
          agentId: this.config.agentId,
          totalCostUsd: json.total_cost_usd || 0,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          cacheWrite5mTokens,
          cacheWrite1hTokens,
          // Phase 4: surface thinking tokens; previously dropped on the floor.
          thinkingTokens: usage?.thinking_input_tokens ?? 0,
          models,
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
        // Subagent (sidechain) frames carry `parent_tool_use_id`; only the
        // main thread's text should win the `ProviderResult.output` fallback.
        if (text && !json.parent_tool_use_id) {
          this.lastAssistantText = text;
          this.transcript.push(`Assistant: ${scrubSecrets(text)}`);
        }

        if (message.content) {
          for (const block of message.content) {
            if (block.type === "tool_use" && block.name) {
              this.transcript.push(
                `Tool[${block.name}] started: ${scrubSecrets(JSON.stringify(block.input ?? {}))}`,
              );
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

      if (json.type === "user" && Array.isArray(json.message?.content)) {
        for (const block of json.message.content) {
          if (block?.type !== "tool_result") continue;
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          this.transcript.push(`Tool result: ${scrubSecrets(content)}`);
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
    this.closeStdin();
    try {
      this.proc.kill("SIGTERM");
    } catch {
      // The subprocess may already have exited.
    }
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";
  readonly traits: ProviderTraits = {
    hasMcp: true,
    // Claude Code reads ~/.claude/skills itself and advertises every skill's
    // name + description natively.
    nativeSkillDiscovery: true,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  };

  constructor(
    private readonly runSessionSummary: (
      opts: RunStopHookSessionSummaryOpts,
    ) => Promise<void> = runStopHookSessionSummarySubprocess,
  ) {}

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
    // alternates; only argv[0..n] changes. Prefer SWARM_USE_CLAUDE_BRIDGE=true
    // for the Desplega-owned bridge. CLAUDE_BINARY remains as the low-level
    // override for custom binaries and the legacy third-party bridge path.
    //
    // `config.env` carries the swarm_config overlay (resolved repo > agent > global
    // by `fetchResolvedEnv` in src/commands/runner.ts), so operators can flip
    // a worker's binary via `set-config CLAUDE_BINARY=...` without a restart.
    // Falls back to process.env, then "claude". See `resolveClaudeBinary` above.
    //
    // See `docs-site/.../claude-bridge-experimental.mdx` for the user-facing guide
    // and `runbooks/harness-providers.md` for engineering notes.
    const {
      raw: claudeBinaryRaw,
      argv: claudeBinaryArgv,
      useClaudeBridge,
      bridgeRequestedWithoutOAuth,
    } = resolveClaudeBinaryArgv(sourceEnv);
    if (bridgeRequestedWithoutOAuth) {
      console.warn(
        `\x1b[33m[claude]\x1b[0m SWARM_USE_CLAUDE_BRIDGE is set but no CLAUDE_CODE_OAUTH_TOKEN is present — falling back to stock 'claude'. claude-bridge requires a subscription/OAuth token (it forwards only the OAuth token to claude and strips ANTHROPIC_*); API-key billing is identical headless vs interactive, so the bridge isn't needed.`,
      );
    }
    const isLegacyBridgeCompat = isLegacyClaudeBridgeCompatBinary(claudeBinaryRaw);
    const effectiveClaudeBinaryArgv = useClaudeBridge
      ? withClaudeBridgeAuthArgs(claudeBinaryArgv, sourceEnv)
      : claudeBinaryArgv;
    const isInteractiveTmuxClaude = isLegacyBridgeCompat || useClaudeBridge;
    const configuredClaudeBinaryRaw = resolveClaudeBinary(sourceEnv);
    if (isLegacyClaudeBridgeCompatBinary(configuredClaudeBinaryRaw)) {
      console.warn(
        `\x1b[33m[claude]\x1b[0m CLAUDE_BINARY=${LEGACY_CLAUDE_BRIDGE_COMPAT_BINARY} is deprecated; set SWARM_USE_CLAUDE_BRIDGE=true to use @desplega.ai/claude-bridge.`,
      );
    }

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m Resolved claude binary: ${effectiveClaudeBinaryArgv.join(" ")} (useClaudeBridge: ${useClaudeBridge}, legacyBridgeCompat: ${isLegacyBridgeCompat})`,
    );

    // Fail fast: claude-bridge and its legacy compatibility path both shell
    // out to tmux. If it's
    // missing, surface a clear error here rather than letting startup fail
    // opaquely.
    if (isInteractiveTmuxClaude && !Bun.which("tmux")) {
      const label = useClaudeBridge
        ? "SWARM_USE_CLAUDE_BRIDGE=true"
        : `CLAUDE_BINARY=${LEGACY_CLAUDE_BRIDGE_COMPAT_BINARY}`;
      throw new Error(
        `${label} requires 'tmux' on PATH (install via apt/brew). See runbooks/harness-providers.md.`,
      );
    }

    // Claude Bridge and its legacy compatibility path drive interactive
    // `claude` in tmux, where the first-run trust dialog can block startup.
    if (isInteractiveTmuxClaude) {
      try {
        await preseedClaudeTrustDialog(config.cwd);
      } catch (err) {
        console.warn(
          `\x1b[33m[claude]\x1b[0m Failed to pre-seed trust dialog for ${config.cwd}: ${err}`,
        );
      }
    }

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

    const harnessVariant = useClaudeBridge ? "bridge" : "stock";
    let harnessVariantMeta: Record<string, unknown> | undefined;
    const queueSteeringOverride = resolveClaudeQueueSteeringOverride(sourceEnv);
    let harnessVersion: string | undefined;
    try {
      const result = Bun.spawnSync([...effectiveClaudeBinaryArgv, "--version"], {
        env: sourceEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.success) {
        const trimmed =
          `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`.trim();
        if (trimmed) {
          harnessVersion = trimmed;
          harnessVariantMeta = { version: trimmed };
        }
      }
    } catch {
      // Harness version detection is best-effort; unknown disables steering.
    }

    // Bridge/tmux wrappers are excluded: they interpose on the CLI's argv and
    // stdio, and prompt-over-stdin has only been verified against the stock
    // binary. A wrapper keeps today's `-p` invocation and simply can't steer.
    const queueSteeringSupported =
      queueSteeringOverride ??
      (!isInteractiveTmuxClaude && supportsClaudeQueueSteering(harnessVersion));
    if (!queueSteeringSupported && queueSteeringOverride === undefined) {
      console.warn(
        `\x1b[33m[claude]\x1b[0m Queued steering requires Claude Code >= ${MIN_CLAUDE_QUEUE_STEERING_VERSION.join(".")}; detected ${harnessVersion ?? "an unknown version"}. Steering messages will be promoted to follow-up tasks.`,
      );
    }

    return new ClaudeSession(
      config,
      model,
      taskFilePath,
      taskFilePid,
      sessionMcpConfig,
      effectiveClaudeBinaryArgv,
      systemPromptFile,
      harnessVariant,
      harnessVariantMeta,
      queueSteeringSupported,
      this.runSessionSummary,
    );
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return true;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
