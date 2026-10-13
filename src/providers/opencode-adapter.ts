/**
 * Opencode provider adapter (OpenCode 2).
 *
 * OpenCode 2 runs in-process through `@opencode/sdk`: one embedded host per
 * task, no `opencode serve` child, no port, no config or data-home files.
 * Config travels as a string, the database is in memory, and the swarm plugin
 * is a plain object (`opencode-swarm-plugin.ts`) passed to `OpenCode.create`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpenCode, OpenCodeEvent } from "@opencode/sdk";
import {
  CONTEXT_FORMULA,
  clampContextPercent,
  getContextWindowSize,
} from "../utils/context-window";
import { validateOpencodeCredentials } from "../utils/credentials";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { fetchInstalledMcpServers } from "../utils/mcp-server-fetcher";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  getOpenRouterAttributionHeaders,
  getOpenRouterBaseUrl,
} from "../utils/openrouter-base-url";
import { scrubSecrets } from "../utils/secret-scrubber";
import { resolveSlashSkillPrompt } from "./codex-skill-resolver";
import { CTX_MODE_NUDGE_EVERY } from "./ctx-mode-env";
import { createOpencodeSwarmPlugin } from "./opencode-swarm-plugin";
import {
  apiHeaders,
  autoIndexMemoryFile,
  fireAndForget,
  type SwarmHooksConfig,
  summarizeTranscript,
  syncIdentityFilesToServer,
} from "./pi-mono-extension";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
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
  SteerDelivery,
  SteerDeliveryResult,
} from "./types";

/**
 * The subset of OpenCode's V1-shaped config we write. OpenCode 2 still reads
 * V1 config (`opencode.json`, `OPENCODE_CONFIG_CONTENT`) and normalizes it in
 * memory, so the ACP target and this adapter share one shape.
 */
export type OpencodeConfig = {
  provider?: Record<
    string,
    {
      options?: Record<string, unknown>;
      models?: Record<string, { options?: Record<string, unknown> }>;
    }
  >;
  [key: string]: unknown;
};

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
 *      writes; OpenCode 2 imports it into its credential store on start).
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

function defaultOpencodeSkillsDir(): string {
  if (process.env.OPENCODE_SKILLS_DIR) {
    return process.env.OPENCODE_SKILLS_DIR;
  }
  return join(process.env.HOME ?? "/home/worker", ".opencode", "skills");
}

// The worker image installs `@opencode/sdk` with `npm install -g`. It stays on
// disk instead of being bundled into the compiled binary because it carries
// native modules (pty, file watcher, tree-sitter).
const OPENCODE_SDK_GLOBAL_ROOTS = ["/usr/lib/node_modules", "/usr/local/lib/node_modules"];
const OPENCODE_SDK_SUBPATH = "@opencode/sdk/dist/index.js";

/**
 * `OPENCODE_SDK_PATH` wins, then the global npm roots, then the bare package
 * name (resolved from the repo's node_modules when running from source).
 */
export function resolveOpencodeSdkSpecifier(): string {
  const override = process.env.OPENCODE_SDK_PATH;
  if (override) return override;
  for (const root of OPENCODE_SDK_GLOBAL_ROOTS) {
    const candidate = join(root, OPENCODE_SDK_SUBPATH);
    if (existsSync(candidate)) return candidate;
  }
  return "@opencode/sdk";
}

type OpencodeSdk = typeof import("@opencode/sdk");
type LoadedOpencodeSdk = { sdk: OpencodeSdk; version?: string };

/** The embedded host reports no version of its own; read the SDK's package.json. */
function readOpencodeSdkVersion(entry: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

// A variable specifier keeps `bun build --compile` from bundling the SDK.
async function loadOpencodeSdk(): Promise<LoadedOpencodeSdk> {
  const specifier = resolveOpencodeSdkSpecifier();
  const sdk = (await import(specifier)) as OpencodeSdk;
  const entry = specifier.startsWith("/") ? specifier : Bun.resolveSync(specifier, import.meta.dir);
  return { sdk, version: readOpencodeSdkVersion(entry) };
}

let loadOpencodeSdkImpl = loadOpencodeSdk;

export function _setOpencodeSdkLoaderForTests(
  fn: (() => Promise<LoadedOpencodeSdk>) | null,
): void {
  loadOpencodeSdkImpl = fn ?? loadOpencodeSdk;
}

/**
 * Route OpenRouter traffic through the configured gateway (see
 * src/utils/openrouter-base-url.ts). opencode's bundled openrouter provider
 * honors `provider.openrouter.options.baseURL`. Mutates `opencodeConfig` in
 * place, and attribute direct OpenRouter requests to Agent Swarm.
 */
export function applyOpenRouterBaseUrlOverride(
  opencodeConfig: OpencodeConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const openRouterBaseUrl = getOpenRouterBaseUrl(env as NodeJS.ProcessEnv);
  const headers = getOpenRouterAttributionHeaders(openRouterBaseUrl, env);
  const overrideBaseUrl = openRouterBaseUrl !== DEFAULT_OPENROUTER_BASE_URL;
  if (!overrideBaseUrl && Object.keys(headers).length === 0) return;
  opencodeConfig.provider = {
    ...opencodeConfig.provider,
    openrouter: {
      ...opencodeConfig.provider?.openrouter,
      options: {
        ...opencodeConfig.provider?.openrouter?.options,
        ...(overrideBaseUrl ? { baseURL: openRouterBaseUrl } : {}),
        ...(Object.keys(headers).length > 0
          ? {
              headers: {
                ...(opencodeConfig.provider?.openrouter?.options?.headers as
                  | Record<string, string>
                  | undefined),
                ...headers,
                "X-Title": "Agent Swarm",
              },
            }
          : {}),
      },
    },
  };
}

const SWARM_AGENT_NAME = "swarm";
const TRANSCRIPT_TAIL_CHARS = 20_000;
const TOOL_RESULT_PREVIEW_CHARS = 500;

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? fallback);
  }
  return error === undefined ? fallback : String(error);
}

function toolResultText(content: ReadonlyArray<{ type: string; text?: string }> | undefined) {
  return (content ?? [])
    .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
    .join("");
}

export class OpencodeSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  // The runner attaches its listener after `createSession` resolves; buffer
  // events (session_init first) until then so none are lost.
  private pendingEvents: ProviderEvent[] = [];
  private completionResolve!: (result: ProviderResult) => void;
  private completionPromise: Promise<ProviderResult>;
  private aborted = false;
  private completed = false;
  private startedAt = Date.now();

  // `session.usage.updated` carries the cumulative session totals.
  private usage = {
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  private steps = 0;
  private toolNames = new Map<string, string>();
  // Assistant text by message, in part order; the runner keeps the last emit.
  private textByMessage = new Map<string, string[]>();
  private transcript: string[] = [];

  constructor(
    private readonly host: OpenCode.Interface,
    private readonly _sessionId: string,
    private model: string,
    private readonly swarm: SwarmHooksConfig,
    private readonly cwd: string,
    private readonly appliedReasoningEffort: ReasoningEffort | null = null,
  ) {
    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.completionResolve = resolve;
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get isFinished(): boolean {
    return this.completed;
  }

  emitSessionInit(harnessVariantMeta?: Record<string, unknown>): void {
    this.emit({
      type: "session_init",
      sessionId: this._sessionId,
      provider: "opencode",
      harnessVariant: "stock",
      ...(harnessVariantMeta ? { harnessVariantMeta } : {}),
    });
  }

  emitProviderEvent(event: ProviderEvent): void {
    this.emit(event);
  }

  recordUserPrompt(text: string): void {
    this.transcript.push(`[user]: ${text}`);
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

  private emitDirect(event: ProviderEvent): void {
    if (this.listeners.length === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const l of this.listeners) l(event);
  }

  /** Emit `event` plus its scrubbed `raw_log` mirror. */
  private emit(event: ProviderEvent): void {
    this.emitDirect(event);
    this.emitDirect({ type: "raw_log", content: scrubSecrets(JSON.stringify(event)) });
  }

  /** Process one OpenCode 2 event. */
  handleOpencodeEvent(ev: OpenCodeEvent): void {
    if (this.aborted || this.completed) return;

    if (ev.type === "filesystem.changed") {
      this.onFileChanged(ev.data.file);
      return;
    }
    const data = (ev as { data?: { sessionID?: string } }).data;
    if (data?.sessionID !== this._sessionId) return;

    this.emitDirect({ type: "raw_log", content: scrubSecrets(JSON.stringify(ev)) });

    switch (ev.type) {
      case "session.tool.input.started":
        this.toolNames.set(ev.data.id, ev.data.name);
        break;

      case "session.tool.called": {
        const toolName = this.toolNames.get(ev.data.id) ?? "tool";
        this.transcript.push(`[tool:${toolName}]: ${JSON.stringify(ev.data.input)}`);
        this.emit({
          type: "tool_start",
          toolCallId: ev.data.id,
          toolName,
          args: ev.data.input,
        });
        break;
      }

      case "session.tool.success":
      case "session.tool.failed": {
        const isError = ev.type === "session.tool.failed";
        const result = isError
          ? errorMessage(ev.data.error, "tool failed")
          : toolResultText(ev.data.content);
        this.transcript.push(`[tool result]: ${result.slice(0, TOOL_RESULT_PREVIEW_CHARS)}`);
        this.emit({
          type: "tool_end",
          toolCallId: ev.data.id,
          toolName: this.toolNames.get(ev.data.id) ?? "tool",
          result,
          isError,
        });
        break;
      }

      case "session.text.ended": {
        const parts = this.textByMessage.get(ev.data.assistantMessageID) ?? [];
        parts[ev.data.ordinal] = ev.data.text;
        this.textByMessage.set(ev.data.assistantMessageID, parts);
        const text = parts.join("").trim();
        if (!text) break;
        this.transcript.push(`[assistant]: ${ev.data.text}`);
        this.emit({
          type: "message",
          role: "assistant",
          content: text,
          messageId: ev.data.assistantMessageID,
        });
        break;
      }

      case "session.step.ended": {
        this.steps++;
        // Per-step usage drives the dashboard's context gauge.
        const t = ev.data.tokens;
        const contextUsed = t.input + t.cache.read + t.cache.write + t.output;
        const contextTotal = getContextWindowSize(this.model || "default");
        if (contextTotal > 0 && contextUsed > 0) {
          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: contextTotal,
            contextPercent: clampContextPercent(contextUsed, contextTotal) ?? 0,
            outputTokens: t.output,
            contextFormula: CONTEXT_FORMULA,
          });
        }
        break;
      }

      case "session.usage.updated":
        this.usage = { cost: ev.data.cost, tokens: ev.data.tokens };
        break;

      case "session.execution.succeeded": {
        const cost = this.buildCostData(false);
        this.emit({ type: "result", cost, isError: false });
        void this.finish({ exitCode: 0, sessionId: this._sessionId, cost, isError: false });
        break;
      }

      case "session.execution.failed":
        this.fail(errorMessage(ev.data.error, "opencode session error"));
        break;

      case "session.execution.interrupted":
        this.fail("opencode session was interrupted");
        break;

      case "permission.asked":
        // A headless worker cannot answer a permission prompt.
        this.fail(
          `Permission request received in headless mode (id=${ev.data.id}); aborting session`,
        );
        break;

      default:
        break;
    }
  }

  /** Same file triggers the claude and pi hooks act on. */
  private onFileChanged(file: string): void {
    const path = file.startsWith("/") ? file : join(this.cwd, file);
    if (
      path === "/workspace/SOUL.md" ||
      path === "/workspace/IDENTITY.md" ||
      path === "/workspace/TOOLS.md" ||
      path === "/workspace/CLAUDE.md"
    ) {
      void syncIdentityFilesToServer(this.swarm, "self_edit");
    }
    if (
      path.startsWith("/workspace/personal/memory/") ||
      path.startsWith("/workspace/shared/memory/")
    ) {
      void autoIndexMemoryFile(this.swarm, path);
    }
  }

  /** Settle the session as failed; also used when the event stream dies. */
  fail(message: string): void {
    if (this.aborted || this.completed) return;
    this.emit({ type: "error", message });
    void this.finish({
      exitCode: 1,
      sessionId: this._sessionId,
      cost: this.buildCostData(true),
      isError: true,
      failureReason: message,
    });
  }

  private buildCostData(isError: boolean): CostData {
    const { cost, tokens } = this.usage;
    return {
      sessionId: this._sessionId,
      taskId: this.swarm.taskId,
      agentId: this.swarm.agentId,
      totalCostUsd: cost,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      reasoningOutputTokens: tokens.reasoning,
      cacheReadTokens: tokens.cache.read,
      cacheWriteTokens: tokens.cache.write,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.steps,
      model: this.model,
      isError,
      provider: "opencode",
    };
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  /** Identity sync, session summary, and session close (Stop-hook parity). */
  private async runSessionEnd(): Promise<void> {
    await syncIdentityFilesToServer(this.swarm);
    if (process.env.SKIP_SESSION_SUMMARY) {
      console.debug("session_summary skipped (opencode): SKIP_SESSION_SUMMARY is set");
    } else {
      const transcript = this.transcript.join("\n").slice(-TRANSCRIPT_TAIL_CHARS);
      void summarizeTranscript(this.swarm, "opencode", transcript);
    }
    fireAndForget(`${this.swarm.apiUrl}/api/sessions/${this._sessionId}/close`, {
      method: "POST",
      headers: apiHeaders(this.swarm),
    });
  }

  private async finish(result: ProviderResult): Promise<void> {
    if (this.completed) return;
    this.completed = true;
    if (!this.aborted) await this.runSessionEnd().catch(() => {});
    await this.host.close().catch(() => {});
    this.completionResolve({ ...result, appliedReasoningEffort: this.appliedReasoningEffort });
  }

  async abort(): Promise<void> {
    if (this.aborted || this.completed) return;
    this.aborted = true;
    await this.host.sessions.interrupt({ sessionID: this._sessionId }).catch(() => {});
    await this.finish({
      exitCode: 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }

  async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
    if (this.completed || this.aborted) {
      // The host is closed; fail closed so the server promotes the message
      // to a follow-up task (same as pi).
      return { delivered: false, reason: "opencode session already completed" };
    }
    try {
      // `steerModes` advertises queue only, so a "steer" request has already
      // been degraded upstream. Say so explicitly: OpenCode 2 defaults to steer.
      void mode;
      await this.host.sessions.prompt({ sessionID: this._sessionId, text, delivery: "queue" });
      this.recordUserPrompt(text);
      return { delivered: true, mode: "queue" };
    } catch (err) {
      return { delivered: false, reason: String(err) };
    }
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasToolSearch: false,
    // Same inline-resolver pattern as codex (`resolveSlashSkillPrompt`) — no
    // ambient skill awareness, so the system prompt enumerates them.
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const taskId = config.taskId;
    const env = config.env ?? process.env;

    // Build MCP config: swarm endpoint + installed MCP servers
    const installedMcp =
      (await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId, "opencode")) ??
      {};
    // Same per-boot runtime identity the runner registers with — dispatch
    // tools require it in multi-runtime mode, and it travels as request
    // context, not as a tool argument.
    const runtimeInstanceId = swarmRuntimeInstanceId();
    const mcp: Record<string, unknown> = {
      swarm: {
        type: "remote",
        url: `${config.apiUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "X-Agent-ID": config.agentId,
          // Per-task identity, same as claude/codex: gives `store-progress` a
          // default task. The host is per task, so this is not shared.
          "X-Source-Task-Id": taskId,
          ...(config.contextKey ? { "X-Context-Key": config.contextKey } : {}),
          ...(runtimeInstanceId ? { "X-Runtime-Instance-ID": runtimeInstanceId } : {}),
        },
      },
      ...installedMcp,
    };
    // context-mode ships only a V1 opencode plugin, which OpenCode 2 cannot
    // load, so wire its stdio MCP server instead (same as codex).
    if (!isEnvFlagEnabled("CONTEXT_MODE_DISABLED", false)) {
      mcp["context-mode"] = {
        type: "local",
        command: ["context-mode"],
        environment: { CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY: CTX_MODE_NUDGE_EVERY },
      };
    }

    const opencodeConfig: OpencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      model: config.model,
      mcp,
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        doom_loop: "allow",
        external_directory: "allow",
      },
      // The system prompt lives on a config-defined agent; nothing is written
      // into the task's working directory.
      agent: {
        [SWARM_AGENT_NAME]: { mode: "primary", prompt: config.systemPrompt ?? "" },
      },
    };

    // Splice the provider-keyed reasoning options into
    // `provider[providerId].models[modelId].options`. `off` (and any
    // capability-rejected level) resolves to `noop`.
    const reasoningApplication = applyReasoningEffort(
      "opencode",
      config.model,
      config.reasoningEffort,
    );
    const appliedReasoningEffort =
      reasoningApplication.kind === "opencode-options" ? (config.reasoningEffort ?? null) : null;
    if (reasoningApplication.kind === "opencode-options") {
      const { providerId, modelId, options } = reasoningApplication;
      const provider = opencodeConfig.provider?.[providerId];
      opencodeConfig.provider = {
        ...opencodeConfig.provider,
        [providerId]: {
          ...provider,
          models: {
            ...provider?.models,
            [modelId]: {
              ...provider?.models?.[modelId],
              options: { ...provider?.models?.[modelId]?.options, ...options },
            },
          },
        },
      };
    }

    applyOpenRouterBaseUrlOverride(opencodeConfig, env);

    const swarm: SwarmHooksConfig = {
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      agentId: config.agentId,
      taskId,
      isLead: config.role === "lead",
      env: config.env,
    };
    const { sdk, version: opencodeVersion } = await loadOpencodeSdkImpl();
    const host = await sdk.OpenCode.create({
      config: { content: JSON.stringify(opencodeConfig) },
      plugins: [createOpencodeSwarmPlugin(swarm)],
      log: {
        level: "warn",
        emit: (entry) => console.warn(scrubSecrets(`[opencode] ${entry.message}`)),
      },
    });

    let sessionId: string;
    try {
      const created = await host.sessions.create({
        location: { directory: config.cwd },
        agent: SWARM_AGENT_NAME,
      });
      sessionId = created.id;
    } catch (err) {
      await host.close().catch(() => {});
      throw err;
    }

    const session = new OpencodeSession(
      host,
      sessionId,
      config.model,
      swarm,
      config.cwd,
      appliedReasoningEffort,
    );
    session.emitSessionInit(opencodeVersion ? { version: opencodeVersion } : undefined);

    // Drive the session from the host's event stream. Closing the host ends
    // the stream; ending without a terminal event means the host died.
    void (async () => {
      try {
        for await (const event of host.events.subscribe()) {
          session.handleOpencodeEvent(event);
          if (session.isFinished) break;
        }
        session.fail("runner exited without result: opencode event stream ended");
      } catch (err) {
        session.fail(String(err));
      }
    })();

    void (async () => {
      const prompt = await resolveSlashSkillPrompt(config.prompt, {
        providerLabel: "opencode",
        skillsDir: defaultOpencodeSkillsDir(),
        emit: (event) => session.emitProviderEvent(event),
        onInline: config.onPromptSkill,
      });
      session.recordUserPrompt(prompt);
      await host.sessions.prompt({ sessionID: sessionId, text: prompt, delivery: "queue" });
    })().catch((err: unknown) => session.fail(errorMessage(err, String(err))));

    return session;
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
