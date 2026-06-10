/**
 * Opencode provider adapter.
 *
 * Sub-4 added the OpencodeAdapter skeleton; sub-5 added the full session
 * lifecycle (SSE events, cost accumulation, raw_log persistence); sub-6 (DES-300)
 * adds per-task isolation: agent file, OPENCODE_CONFIG, OPENCODE_DATA_HOME.
 * Sub-7 (DES-301) wires the agent-swarm opencode plugin for cancellation,
 * heartbeat, identity sync, system.transform, compacting, and idle hooks.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Config, Event as OpencodeEvent } from "@opencode-ai/sdk";
import { createOpencode } from "@opencode-ai/sdk";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  getContextWindowSize,
} from "../utils/context-window";
import { validateOpencodeCredentials } from "../utils/credentials";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { scrubSecrets } from "../utils/secret-scrubber";
import { CTX_MODE_NUDGE_EVERY } from "./ctx-mode-env";
import { readPkgVersion } from "./harness-version";
import type {
  CostData,
  CredCheckOptions,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

/**
 * Map opencode model strings to the env var that satisfies them. Opencode
 * uses the same `provider/model-id` shape as pi-mono — the prefix tells us
 * which key the user must supply.
 */
function opencodeModelToCredKey(modelStr: string | undefined): string | null {
  if (!modelStr) return null;
  if (modelStr.includes("/")) {
    const provider = modelStr.slice(0, modelStr.indexOf("/")).toLowerCase();
    if (provider === "anthropic") return "ANTHROPIC_API_KEY";
    if (provider === "openrouter") return "OPENROUTER_API_KEY";
    if (provider === "openai") return "OPENAI_API_KEY";
  }
  return null;
}

/**
 * Opencode is satisfied by ANY of:
 *   1. `~/.local/share/opencode/auth.json` exists (the file `opencode auth login`
 *      writes).
 *   2. `MODEL_OVERRIDE` resolves to a provider-prefixed model — only that
 *      provider's key is required.
 *   3. Otherwise any one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY /
 *      OPENAI_API_KEY suffices.
 */
export function checkOpencodeCredentials(
  env: Record<string, string | undefined>,
  opts: CredCheckOptions = {},
): CredStatus {
  const homeDir = opts.homeDir ?? env.HOME ?? "/root";
  const probe = opts.fs?.existsSync ?? existsSync;
  const authFile = `${homeDir}/.local/share/opencode/auth.json`;
  if (probe(authFile)) {
    return { ready: true, missing: [], satisfiedBy: "file" };
  }

  const requiredKey = opencodeModelToCredKey(env.MODEL_OVERRIDE);
  if (requiredKey) {
    if (env[requiredKey]) {
      return { ready: true, missing: [], satisfiedBy: "env" };
    }
    return {
      ready: false,
      missing: [requiredKey, authFile],
      hint: `MODEL_OVERRIDE=${env.MODEL_OVERRIDE} requires ${requiredKey}; or run \`opencode auth login\` to create ${authFile}.`,
    };
  }

  if (env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
    return { ready: true, missing: [], satisfiedBy: "env" };
  }
  return {
    ready: false,
    missing: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", authFile],
    hint: "Set one of OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY (any one suffices), or run `opencode auth login` to create ~/.local/share/opencode/auth.json.",
  };
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as AssistantMessage).role === "assistant" &&
    typeof (msg as AssistantMessage).cost === "number"
  );
}

const DOCKER_PLUGIN_PATH = "/home/worker/.config/opencode/plugins/agent-swarm.ts";
const MODEL_CACHE_REFRESH_TIMEOUT_MS = 15_000;

function isOpenRouterModel(model: string | undefined): boolean {
  return Boolean(model?.toLowerCase().startsWith("openrouter/"));
}

function isModelNotFoundError(message: string): boolean {
  return /model not found:/i.test(message);
}

async function readSpawnOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

function formatUnknownError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function refreshOpenRouterModelCache(
  opencodeConfig: Config & { plugin?: string[] },
  configFilePath: string,
  dataHomePath: string,
): Promise<void> {
  const binary = process.env.OPENCODE_BINARY || "opencode";
  const proc = Bun.spawn([binary, "models", "--refresh", "openrouter"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      OPENCODE_CONFIG: configFilePath,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      OPENCODE_DATA_HOME: dataHomePath,
    },
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, MODEL_CACHE_REFRESH_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    readSpawnOutput(proc.stdout),
    readSpawnOutput(proc.stderr),
    proc.exited,
  ]).finally(() => clearTimeout(timeout));

  if (timedOut) {
    throw new Error(
      `opencode models --refresh openrouter timed out after ${MODEL_CACHE_REFRESH_TIMEOUT_MS}ms`,
    );
  }
  if (exitCode !== 0) {
    const detail = scrubSecrets([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"));
    throw new Error(
      `opencode models --refresh openrouter exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
}

let refreshOpenRouterModelCacheImpl = refreshOpenRouterModelCache;

export function _setOpenRouterModelCacheRefreshForTests(
  fn: typeof refreshOpenRouterModelCache | null,
): void {
  refreshOpenRouterModelCacheImpl = fn ?? refreshOpenRouterModelCache;
}

function resolvePluginPath(): string {
  const override = process.env.OPENCODE_SWARM_PLUGIN_PATH;
  if (override) return override;
  if (existsSync(DOCKER_PLUGIN_PATH)) return DOCKER_PLUGIN_PATH;
  return join(import.meta.dir, "../../plugin/opencode-plugins/agent-swarm.ts");
}

// context-mode is installed globally via `npm install -g` (Dockerfile.worker),
// which places it under the npm global modules dir. opencode resolves bare
// plugin names with `import(await Bun.resolve(name, ...))`, which does NOT walk
// the npm global dir — a bare "context-mode" entry only resolves if Bun
// auto-installs from the registry at runtime, which fails on network-sandboxed
// workers. So we hand opencode the ABSOLUTE path to the package's built
// opencode-plugin entry, which imports cleanly with no network.
const CONTEXT_MODE_GLOBAL_ROOTS = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"];
const CONTEXT_MODE_PLUGIN_SUBPATH = "context-mode/build/adapters/opencode/plugin.js";

/**
 * Resolve the absolute path to context-mode's opencode plugin entry, or `null`
 * if it can't be found on disk. `CONTEXT_MODE_OPENCODE_PLUGIN_PATH` overrides
 * the lookup (and must itself exist). Returning `null` lets the caller skip the
 * plugin gracefully instead of handing opencode an unresolvable entry.
 */
export function resolveContextModePluginPath(): string | null {
  const override = process.env.CONTEXT_MODE_OPENCODE_PLUGIN_PATH;
  if (override) return existsSync(override) ? override : null;
  for (const root of CONTEXT_MODE_GLOBAL_ROOTS) {
    const candidate = join(root, CONTEXT_MODE_PLUGIN_SUBPATH);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class OpencodeSession implements ProviderSession {
  private _sessionId: string;
  private listeners: Array<(event: ProviderEvent) => void> = [];
  // Buffer for events emitted before any listener is attached.
  // The runner attaches its listener after `await adapter.createSession(...)`
  // resolves, but events queued via Promise.resolve().then(...) inside
  // createSession fire on the next microtask — *before* that listener call —
  // so the runner would miss session_init and never PUT /session,
  // leaving agent_tasks.provider/.model NULL. Buffer + flush on first attach.
  private pendingEvents: ProviderEvent[] = [];
  private completionResolve!: (result: ProviderResult) => void;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: reserved for future error-propagation paths; symmetric with completionResolve.
  private completionReject!: (err: Error) => void;
  private completionPromise: Promise<ProviderResult>;
  private server: { url: string; close(): void };
  private aborted = false;
  private completed = false;

  // Running cost accumulators
  private totalCostUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private numTurns = 0;
  private startedAt = Date.now();
  private model: string;
  private agentId: string;
  private taskId: string;

  // Per-task isolation paths (for cleanup)
  private agentFilePath: string;
  private configFilePath: string;
  private dataHomePath: string;
  private retryAfterModelRefresh?: () => Promise<boolean>;
  private modelRefreshRecoveryInFlight = false;

  // Track which tool callIDs have already emitted tool_start, so transitions
  // through pending → running → completed don't fire duplicate events.
  private toolStartsEmitted = new Set<string>();

  constructor(
    sessionId: string,
    server: { url: string; close(): void },
    model: string,
    agentId: string,
    taskId: string,
    agentFilePath: string,
    configFilePath: string,
    dataHomePath: string,
    retryAfterModelRefresh?: () => Promise<boolean>,
  ) {
    this._sessionId = sessionId;
    this.server = server;
    this.model = model;
    this.agentId = agentId;
    this.taskId = taskId;
    this.agentFilePath = agentFilePath;
    this.configFilePath = configFilePath;
    this.dataHomePath = dataHomePath;
    this.retryAfterModelRefresh = retryAfterModelRefresh;
    this.completionPromise = new Promise<ProviderResult>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get isFinished(): boolean {
    return this.completed;
  }

  /** Emit the synthetic session_init event. Called by the adapter immediately
   * after construction; buffers if no listener is attached yet. */
  emitSessionInit(provider: "opencode", harnessVariantMeta?: Record<string, unknown>): void {
    this.emit({
      type: "session_init",
      sessionId: this._sessionId,
      provider,
      harnessVariant: "stock",
      ...(harnessVariantMeta ? { harnessVariantMeta } : {}),
    });
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    const wasEmpty = this.listeners.length === 0;
    this.listeners.push(listener);
    if (wasEmpty && this.pendingEvents.length > 0) {
      const buffered = this.pendingEvents;
      this.pendingEvents = [];
      for (const ev of buffered) listener(ev);
    }
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
    } else {
      for (const l of this.listeners) l(event);
    }
    // Also emit a raw_log for every event (scrubbed)
    if (event.type !== "raw_log") {
      const raw = scrubSecrets(JSON.stringify(event));
      this.emitDirect({ type: "raw_log", content: raw });
    }
  }

  private emitDirect(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const l of this.listeners) l(event);
  }

  emitModelCacheRefreshProgress(): void {
    this.emit({
      type: "progress",
      message: "opencode model cache is stale; refreshing OpenRouter models and retrying once",
    });
  }

  emitModelCacheRefreshFailure(message: string, err: unknown): void {
    this.emitError(`${message}; OpenRouter model cache refresh failed: ${formatUnknownError(err)}`);
  }

  private recoverFromModelNotFound(message: string): void {
    if (!this.retryAfterModelRefresh || this.modelRefreshRecoveryInFlight) {
      this.emitError(message);
      return;
    }
    this.modelRefreshRecoveryInFlight = true;
    this.emitModelCacheRefreshProgress();
    this.retryAfterModelRefresh()
      .then((retried) => {
        if (!retried) this.emitError(message);
      })
      .catch((err: unknown) => {
        this.emitModelCacheRefreshFailure(message, err);
      });
  }

  /** Best-effort cleanup of per-task isolation files and directories. */
  private async cleanupFiles(): Promise<void> {
    try {
      await Bun.$`rm -f ${this.agentFilePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
    try {
      await Bun.$`rm -f ${this.configFilePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
    try {
      await Bun.$`rm -rf ${this.dataHomePath}`.quiet().nothrow();
    } catch {
      // best-effort
    }
  }

  /** Process a single opencode SSE event */
  handleOpencodeEvent(ev: OpencodeEvent): void {
    if (this.aborted || this.completed) return;

    // Always emit the raw event as a scrubbed raw_log
    const rawContent = scrubSecrets(JSON.stringify(ev));
    this.emitDirect({ type: "raw_log", content: rawContent });

    switch (ev.type) {
      case "message.updated": {
        const msg = ev.properties.info;
        if (!isAssistantMessage(msg) || msg.sessionID !== this._sessionId) break;
        // Phase 9 fix: opencode fires `message.updated` repeatedly during a single
        // assistant turn (streaming text deltas, tool transitions, etc.) and only
        // populates `tokens`/`cost` on the FINAL update once `time.completed` is
        // set. Accumulating on every event would either no-op (zero tokens) or —
        // if opencode ever back-fills intermediate snapshots — multi-count. Gate
        // the accumulator AND the context emit on the finalized signal so both
        // paths see the same canonical "this turn is done" moment.
        const messageFinalized = msg.time?.completed != null;
        if (!messageFinalized) break;
        // Accumulate cost from each completed assistant message ("step")
        this.totalCostUsd += msg.cost;
        this.inputTokens += msg.tokens?.input ?? 0;
        this.outputTokens += msg.tokens?.output ?? 0;
        this.cacheReadTokens += msg.tokens?.cache?.read ?? 0;
        this.cacheWriteTokens += msg.tokens?.cache?.write ?? 0;
        this.numTurns += 1;
        if (!this.model && msg.modelID) this.model = msg.modelID;

        // Emit context_usage so the runner can POST /api/tasks/:id/context
        // (drives the dashboard's context-usage progress bar). The runner-side
        // throttle (CONTEXT_THROTTLE_MS = 30s) means the FIRST emit wins for any
        // short task — so this MUST carry real numbers, not the zero-tokens
        // placeholder opencode sends on intermediate streaming updates. The
        // `time.completed` gate above (in the accumulator block) guarantees we
        // only land here for finalized messages.
        const turnInput = msg.tokens?.input ?? 0;
        const turnOutput = msg.tokens?.output ?? 0;
        const turnCacheRead = msg.tokens?.cache?.read ?? 0;
        const turnCacheWrite = msg.tokens?.cache?.write ?? 0;
        // Phase 8 + Phase 9: unified `input + cache + output` formula instead
        // of the previous `input + cache_read + cache_write` (which omitted
        // output and slightly mis-counted vs every other adapter).
        const contextUsed = turnInput + turnCacheRead + turnCacheWrite + turnOutput;
        const contextTotal = getContextWindowSize(this.model || msg.modelID || "default");
        if (contextTotal > 0 && contextUsed > 0) {
          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: contextTotal,
            // Phase 8: clamp so a turn that briefly overshoots (e.g. due to
            // a stale total) doesn't render as a 130% gauge in the UI.
            contextPercent: clampContextPercent(contextUsed, contextTotal) ?? 0,
            outputTokens: turnOutput,
            contextFormula: CONTEXT_FORMULA,
          });
        }
        break;
      }

      case "message.part.updated": {
        // Bridge opencode's part.state lifecycle to swarm's tool_start/tool_end
        // so the dashboard's Activity timeline mirrors what other providers
        // emit. We fire tool_start the first time we see a tool part (any
        // status); tool_end fires once when state transitions to "completed".
        const props = (ev as unknown as { properties: { sessionID?: string; part?: unknown } })
          .properties;
        if (props.sessionID !== this._sessionId) break;
        const part = props.part as
          | {
              type?: string;
              tool?: string;
              callID?: string;
              id?: string;
              state?: { status?: string; input?: unknown; output?: unknown };
            }
          | undefined;
        if (!part || part.type !== "tool") break;
        const callId = part.callID ?? part.id ?? "";
        if (!callId) break;
        const toolName = part.tool ?? "tool";

        if (!this.toolStartsEmitted.has(callId)) {
          this.toolStartsEmitted.add(callId);
          this.emit({
            type: "tool_start",
            toolCallId: callId,
            toolName,
            args: part.state?.input,
          });
        }
        if (part.state?.status === "completed") {
          this.emit({
            type: "tool_end",
            toolCallId: callId,
            toolName,
            result: part.state.output,
          });
        }
        break;
      }

      case "session.idle": {
        if (ev.properties.sessionID !== this._sessionId) break;
        const cost = this.buildCostData(false);
        const resultEvent: ProviderEvent = {
          type: "result",
          cost,
          isError: false,
        };
        // Emit result (raw_log will be auto-emitted via emit())
        for (const l of this.listeners) l(resultEvent);
        const raw = scrubSecrets(JSON.stringify(resultEvent));
        this.emitDirect({ type: "raw_log", content: raw });
        void this.finish({
          exitCode: 0,
          sessionId: this._sessionId,
          cost,
          isError: false,
        });
        break;
      }

      case "session.error": {
        if (ev.properties.sessionID !== undefined && ev.properties.sessionID !== this._sessionId)
          break;
        const errMsg =
          ev.properties.error && "message" in ev.properties.error
            ? String((ev.properties.error as { message?: string }).message ?? "unknown error")
            : "opencode session error";
        if (isModelNotFoundError(errMsg)) {
          this.recoverFromModelNotFound(errMsg);
          break;
        }
        this.emitError(errMsg);
        break;
      }

      case "permission.updated": {
        if (ev.properties.sessionID !== this._sessionId) break;
        // Headless worker cannot interactively approve permissions — treat as error
        this.emitError(
          `Permission request received in headless mode (id=${ev.properties.id}); aborting session`,
        );
        break;
      }

      default:
        break;
    }
  }

  private emitError(message: string): void {
    const errorEvent: ProviderEvent = { type: "error", message };
    for (const l of this.listeners) l(errorEvent);
    const raw = scrubSecrets(JSON.stringify(errorEvent));
    this.emitDirect({ type: "raw_log", content: raw });
    const cost = this.buildCostData(true);
    void this.finish({
      exitCode: 1,
      sessionId: this._sessionId,
      cost,
      isError: true,
      failureReason: message,
    });
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this._sessionId,
      taskId: this.taskId,
      agentId: this.agentId,
      totalCostUsd: this.totalCostUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.numTurns,
      model: this.model,
      isError,
      provider: "opencode",
    };
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  private async finish(result: ProviderResult): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    try {
      this.server.close();
    } catch {
      // best-effort
    }
    await this.cleanupFiles();
    this.completionResolve(result);
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    await this.finish({
      exitCode: 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const taskId = config.taskId;
    const agentName = `swarm-${taskId}`;
    const agentFilePath = join(config.cwd, ".opencode", "agents", `${agentName}.md`);
    const configFilePath = `/tmp/opencode-${taskId}.json`;
    const dataHomePath = `/tmp/opencode-data-${taskId}`;

    // Write per-task agent file (best-effort; contains the system prompt)
    try {
      mkdirSync(join(config.cwd, ".opencode", "agents"), { recursive: true });
      await Bun.write(agentFilePath, config.systemPrompt ?? "");
    } catch {
      // best-effort
    }

    // Build MCP config: swarm endpoint + installed MCP servers
    const installedMcp =
      (await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "opencode")) ??
      {};
    const mcpConfig: Config["mcp"] = {
      swarm: {
        type: "remote",
        url: `${config.apiUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": config.agentId,
        },
      },
      ...installedMcp,
    };

    // Resolve the agent-swarm plugin path. Three layers, in priority order:
    //   1. OPENCODE_SWARM_PLUGIN_PATH env (explicit override)
    //   2. The well-known Docker location (Dockerfile.worker COPYs the plugin
    //      to /home/worker/.config/opencode/plugins/agent-swarm.ts)
    //   3. The dev path relative to this source file
    // The previous one-liner used `import.meta.dir` only, which resolves to
    // `/usr/local/bin` for the bundled binary and produced the non-existent
    // `/plugin/opencode-plugins/agent-swarm.ts`. Docker only worked because
    // opencode auto-discovers plugins from ~/.config/opencode/plugins/ —
    // an accident, not a contract.
    const pluginPath = resolvePluginPath();

    // context-mode ships as an in-process opencode plugin (NOT an MCP server).
    // Its built plugin entry registers both the native ctx_* tools and the 5
    // hook surrogates. It must NOT also appear in the `mcp` block — dual
    // registration yields zero tools. We push the ABSOLUTE path to the globally
    // installed package's opencode plugin entry, not the bare name (see
    // resolveContextModePluginPath for why a bare name fails to resolve offline).
    // Gated by CONTEXT_MODE_DISABLED so builds/deploys without it opt out.
    const plugins = [pluginPath];
    if (process.env.CONTEXT_MODE_DISABLED !== "true") {
      const contextModePluginPath = resolveContextModePluginPath();
      if (contextModePluginPath) {
        plugins.push(contextModePluginPath);
      } else {
        console.warn(
          "[opencode] context-mode is enabled but its opencode plugin entry was not found on disk; " +
            "skipping it for this session. Set CONTEXT_MODE_OPENCODE_PLUGIN_PATH to override, or " +
            "CONTEXT_MODE_DISABLED=true to silence.",
        );
      }
    }

    // Build per-task opencode config (plugin field carries the swarm plugin)
    const opencodeConfig: Config & { plugin?: string[] } = {
      $schema: "https://opencode.ai/config.json",
      model: config.model,
      mcp: mcpConfig,
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        doom_loop: "allow",
        external_directory: "allow",
      },
      plugin: plugins,
    };

    // Write per-task config file
    try {
      await Bun.write(configFilePath, JSON.stringify(opencodeConfig, null, 2));
    } catch {
      // best-effort
    }

    // Set per-task data home before spawning the opencode process
    process.env.OPENCODE_DATA_HOME = dataHomePath;

    // Set SWARM_* env vars so the plugin can read them (inherited by child process)
    const swarmEnvSnapshot = {
      SWARM_API_URL: process.env.SWARM_API_URL,
      SWARM_API_KEY: process.env.SWARM_API_KEY,
      SWARM_AGENT_ID: process.env.SWARM_AGENT_ID,
      SWARM_TASK_ID: process.env.SWARM_TASK_ID,
      SWARM_IS_LEAD: process.env.SWARM_IS_LEAD,
    };
    process.env.SWARM_API_URL = config.apiUrl;
    process.env.SWARM_API_KEY = config.apiKey;
    process.env.SWARM_AGENT_ID = config.agentId;
    process.env.SWARM_TASK_ID = config.taskId;
    process.env.SWARM_IS_LEAD = config.role === "lead" ? "true" : "false";
    process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = CTX_MODE_NUDGE_EVERY;

    // Set OPENCODE_CONFIG scoped to the spawn call (save + restore)
    const prevOpencodeConfig = process.env.OPENCODE_CONFIG;
    process.env.OPENCODE_CONFIG = configFilePath;

    let client: Awaited<ReturnType<typeof createOpencode>>["client"];
    let server: Awaited<ReturnType<typeof createOpencode>>["server"];
    try {
      ({ client, server } = await createOpencode({
        hostname: "127.0.0.1",
        port: 0,
        config: opencodeConfig,
      }));
    } finally {
      // Restore OPENCODE_CONFIG after the process has been spawned
      if (prevOpencodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG;
      } else {
        process.env.OPENCODE_CONFIG = prevOpencodeConfig;
      }
      // Restore SWARM_* env vars
      for (const [key, val] of Object.entries(swarmEnvSnapshot)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    }

    // Create the opencode session (project directory = config.cwd)
    const createResult = await client.session.create({ query: { directory: config.cwd } });
    if (!createResult.data) {
      server.close();
      throw new Error("Failed to create opencode session");
    }
    const opencodeSession = createResult.data;
    const sessionId = opencodeSession.id;

    let promptRefreshAttempted = false;
    let promptRefreshPromise: Promise<boolean> | undefined;
    const sendPrompt = async () => {
      await client.session.prompt({
        path: { id: sessionId },
        query: { directory: config.cwd },
        body: {
          agent: agentName,
          parts: [{ type: "text", text: config.prompt }],
        },
      });
    };
    const refreshOpenRouterAndRetryPrompt = async (): Promise<boolean> => {
      if (promptRefreshPromise) return await promptRefreshPromise;
      if (promptRefreshAttempted || !isOpenRouterModel(config.model)) return false;
      promptRefreshAttempted = true;
      promptRefreshPromise = (async () => {
        await refreshOpenRouterModelCacheImpl(opencodeConfig, configFilePath, dataHomePath);
        await sendPrompt();
        return true;
      })();
      return await promptRefreshPromise;
    };

    const session = new OpencodeSession(
      sessionId,
      server,
      config.model,
      config.agentId,
      config.taskId,
      agentFilePath,
      configFilePath,
      dataHomePath,
      isOpenRouterModel(config.model) ? refreshOpenRouterAndRetryPrompt : undefined,
    );

    // Emit session_init synchronously; the session buffers events until the
    // runner's `onEvent(listener)` call attaches a listener.
    const opcVersion = readPkgVersion("@opencode-ai/sdk");
    session.emitSessionInit("opencode", opcVersion ? { version: opcVersion } : undefined);

    // Subscribe to SSE events and drive the session
    client.event
      .subscribe({ query: { directory: config.cwd } })
      .then(async ({ stream }) => {
        for await (const event of stream) {
          session.handleOpencodeEvent(event as OpencodeEvent);
          if (session.isFinished) break;
        }
        // Stream ended without session.idle — treat as completion
      })
      .catch((err: unknown) => {
        session.handleOpencodeEvent({
          type: "session.error",
          properties: { sessionID: sessionId, error: { message: String(err) } as never },
        });
      });

    // Fire-and-forget: send the prompt using the per-task agent
    sendPrompt().catch((err: unknown) => {
      const message = formatUnknownError(err);
      if (isModelNotFoundError(message) && isOpenRouterModel(config.model)) {
        session.emitModelCacheRefreshProgress();
        refreshOpenRouterAndRetryPrompt()
          .then((retried) => {
            if (retried) return;
            session.handleOpencodeEvent({
              type: "session.error",
              properties: { sessionID: sessionId, error: { message } as never },
            });
          })
          .catch((retryErr: unknown) => {
            session.emitModelCacheRefreshFailure(message, retryErr);
          });
        return;
      }
      session.handleOpencodeEvent({
        type: "session.error",
        properties: { sessionID: sessionId, error: { message } as never },
      });
    });

    return session;
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
