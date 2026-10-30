import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContentBlock,
  InitializeResponse,
  PromptRequest,
  PromptResponse,
  SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";
import {
  baseUrlOverride,
  normalizeGrokModel,
  providerBaseUrl,
  providerForModel,
} from "@desplega/model-catalog";
import { resolveTemplateAsync, resolveTemplateFromCode } from "../prompts/resolver";
import "../prompts/session-templates";
import { clampContextPercent, getContextWindowSize } from "../utils/context-window";
import { requireFxRoute } from "../utils/fx-models";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  ACP_TARGET_IDS,
  type AcpTarget,
  getAcpTargetCatalogEntry,
  isAcpTarget,
} from "./acp-target-catalog";
import {
  applyOpenRouterBaseUrlOverride,
  buildOpenAICompatibleProviderBlock,
  type OpencodeConfig,
} from "./opencode-adapter";
import { applyReasoningEffort } from "./reasoning-effort";
import type {
  CostData,
  CostModelUsage,
  ProviderEvent,
  ProviderSessionConfig,
  SteerDelivery,
  SteerDeliveryResult,
} from "./types";

/** What a target's `sessionSystemPrompt` hook sends as `session/new` `systemPrompt`. */
export interface AcpSessionSystemPrompt {
  /** Text content blocks, sent as the `systemPrompt` array (append mode). */
  blocks: ContentBlock[];
  /** Set when the blocks carry only part of the prompt and the whole of it is in this file. */
  artifactPath?: string;
}

/** What the adapter hands a target's `steer` hook for one steering message. */
export interface AcpSteerContext {
  sessionId: string;
  delivery: SteerDelivery;
  /** The `initialize` result, for capability gating. */
  initResult: InitializeResponse;
  /** Sends `session/prompt` on the session's ACP connection. */
  prompt(params: PromptRequest): Promise<PromptResponse>;
  /** Observes raw session updates until the returned function is called. */
  onUpdate(listener: (update: SessionUpdate) => void): () => void;
}

/** Native session resume over `session/resume`. */
export interface AcpResumeHook {
  readonly method: "session/resume";
  canResume(sessionId: string): Promise<boolean>;
}

export interface AcpTargetProfile {
  /** An operator-selectable ACP target, or a first-class harness built on the ACP client. */
  readonly target: AcpTarget | "grok" | "fx";
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  configuredOptions(config: ProviderSessionConfig): Record<string, string | boolean>;
  writeSystemPromptArtifact(config: ProviderSessionConfig): Promise<void>;
  /** Removes what writeSystemPromptArtifact wrote. Called once the session ends or fails to start. */
  cleanupSystemPromptArtifact?(config: ProviderSessionConfig): Promise<void>;
  /** Target-specific `session/new` `_meta`. Targets without one send none. */
  sessionMeta?(config: ProviderSessionConfig): Record<string, unknown> | undefined;
  /** A clearer message for a target error whose own text misleads, else undefined. */
  describeError?(message: string): string | undefined;
  /**
   * Rewrites a translated event for display, e.g. unwrapping a tool proxy.
   * `update` is the ACP session update the event was translated from.
   */
  rewriteEvent?(event: ProviderEvent, update?: SessionUpdate): ProviderEvent;
  /** Usage, cost and the model that ran, from the `session/prompt` response `_meta`. */
  promptCost?(
    meta: Record<string, unknown> | null | undefined,
    model: string,
  ): Partial<CostData> | undefined;
  /** A context snapshot from the `session/prompt` response `_meta`, for targets without `usage_update`. */
  promptContext?(
    meta: Record<string, unknown> | null | undefined,
    model: string,
  ): Extract<ProviderEvent, { type: "context_usage" }> | undefined;
  // Opt-in hooks. A target without them behaves exactly as before they existed.
  /**
   * The standard `systemPrompt` for `session/new`. Sent only when the agent
   * advertises `sessionCapabilities.systemPrompt`.
   */
  sessionSystemPrompt?(config: ProviderSessionConfig): Promise<AcpSessionSystemPrompt | undefined>;
  /**
   * The target accepts MCP URLs only over HTTPS or explicit loopback HTTP. A
   * plain-HTTP, non-loopback server URL (the swarm API at `http://api:3013`)
   * goes through a per-session 127.0.0.1 forwarder, and SSE servers are dropped
   * unless the agent advertises `mcpCapabilities.sse`.
   */
  readonly requiresSecureMcpUrl?: boolean;
  /** Live steering. Absent means the session has no `deliverSteering`. */
  steer?(context: AcpSteerContext): Promise<SteerDeliveryResult>;
  /** Native resume: `config.resumeSessionId` is resumed instead of creating a session. */
  readonly resume?: AcpResumeHook;
}

export class AcpTargetResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTargetResolutionError";
  }
}

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "BUN_INSTALL",
  "NODE_PATH",
] as const;

function readEnv(config: ProviderSessionConfig, key: string): string | undefined {
  return config.env?.[key] ?? process.env[key];
}

function baseTargetEnv(config: ProviderSessionConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = readEnv(config, key);
    if (value) env[key] = value;
  }
  return env;
}

function copyEnvKeys(
  config: ProviderSessionConfig,
  env: Record<string, string>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = readEnv(config, key);
    if (value !== undefined) env[key] = value;
  }
}

function parseStringArray(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed;
    }
  } catch {
    // Accept comma-separated values for hand-authored environment config.
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function configuredOptions(config: ProviderSessionConfig): Record<string, string | boolean> {
  let options: Record<string, string | boolean> = {};
  const raw = readEnv(config, "ACP_CONFIG_OPTIONS");
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        options = Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string | boolean] =>
              typeof entry[1] === "string" || typeof entry[1] === "boolean",
          ),
        );
      }
    } catch {
      console.warn("\x1b[33m[acp]\x1b[0m Ignoring invalid ACP_CONFIG_OPTIONS JSON");
    }
  }
  delete options.model;
  if (config.model.trim()) options.model = config.model.trim();
  return options;
}

function withOpencodeConfig(env: Record<string, string>, model: string): void {
  const key = "OPENCODE_CONFIG_CONTENT";
  let value: Record<string, unknown> = {};
  const existing = env[key];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>;
      }
    } catch {
      console.warn(`\x1b[33m[acp]\x1b[0m Replacing invalid ${key} JSON for model fallback`);
    }
  }
  if (model.trim()) value.model = model.trim();
  withCustomProviderBlock(value as OpencodeConfig, model.trim(), env);
  applyOpenRouterBaseUrlOverride(value as OpencodeConfig, env);
  env[key] = JSON.stringify(value);
}

/**
 * OpenCode ships no provider for a registry entry models.dev does not list
 * (`catalog: "registry"`, e.g. `helmcode`), so its models need the custom
 * block. The key stays an `{env:…}` reference: the ACP subprocess env is the
 * forwarded per-task env, where the var holds one picked key, so no literal
 * key lands in `OPENCODE_CONFIG_CONTENT`. A built-in registry provider
 * (`nan`) only gets `options.baseURL` when `<ID>_BASE_URL` is set. Values the
 * operator already set in `OPENCODE_CONFIG_CONTENT` win over the defaults.
 */
function withCustomProviderBlock(
  config: OpencodeConfig,
  model: string,
  env: Record<string, string>,
): void {
  const provider = providerForModel(model);
  if (!provider) return;
  const existing = config.provider?.[provider.id];
  if (provider.catalog !== "registry") {
    const baseURL = baseUrlOverride(provider, env);
    if (!baseURL) return;
    config.provider = {
      ...config.provider,
      [provider.id]: { ...existing, options: { baseURL, ...existing?.options } },
    };
    return;
  }
  const block = buildOpenAICompatibleProviderBlock(
    provider,
    `{env:${provider.envVar}}`,
    model.slice(provider.id.length + 1),
    providerBaseUrl(provider, env),
  );
  config.provider = {
    ...config.provider,
    [provider.id]: {
      ...block,
      ...existing,
      options: { ...block.options, ...existing?.options },
      models: { ...block.models, ...existing?.models },
    },
  };
}

function parseCommand(command: string, args: string | undefined): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AcpTargetResolutionError(
      "ACP target command is empty. Set ACP_TARGET_COMMAND to an ACP-compatible executable.",
    );
  }

  if (args?.trim()) {
    try {
      const parsed = JSON.parse(args);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        return [trimmed, ...parsed];
      }
    } catch {
      // Fall through to whitespace splitting for simple env configuration.
    }
    return [trimmed, ...args.trim().split(/\s+/).filter(Boolean)];
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

const customTargetProfile: AcpTargetProfile = {
  target: "custom",
  command(config) {
    const command = readEnv(config, "ACP_TARGET_COMMAND") ?? readEnv(config, "ACP_COMMAND");
    if (!command) {
      throw new AcpTargetResolutionError(
        "No ACP target configured. Set ACP_TARGET_COMMAND to an ACP-compatible executable before using HARNESS_PROVIDER=acp.",
      );
    }
    return parseCommand(command, readEnv(config, "ACP_TARGET_ARGS"));
  },
  env(config) {
    const env = baseTargetEnv(config);
    copyEnvKeys(config, env, parseStringArray(readEnv(config, "ACP_TARGET_ENV_KEYS")));
    const modelEnvKey = readEnv(config, "ACP_MODEL_ENV_KEY")?.trim();
    if (modelEnvKey && /^[A-Za-z_][A-Za-z0-9_]*$/.test(modelEnvKey) && config.model.trim()) {
      env[modelEnvKey] = config.model.trim();
    }
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact(config) {
    const relativePath = readEnv(config, "ACP_SYSTEM_PROMPT_PATH");
    if (!relativePath) return;
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await Bun.write(targetPath, config.systemPrompt ?? "");
  },
};

const opencodeTargetProfile: AcpTargetProfile = {
  target: "opencode",
  command() {
    const entry = getAcpTargetCatalogEntry("opencode");
    return [entry.command!, ...(entry.args ?? [])];
  },
  env(config) {
    const env = baseTargetEnv(config);
    const entry = getAcpTargetCatalogEntry("opencode");
    copyEnvKeys(config, env, entry.envKeys);
    copyEnvKeys(config, env, ["OPENROUTER_APP_ATTRIBUTION"]);
    withOpencodeConfig(env, config.model);
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact() {},
};

// The prompt file is per session and lives outside the task cwd, so it never
// lands in the repo tree. `env()` runs after `writeSystemPromptArtifact()` and
// reads the path back from here.
const geminiSystemPromptPaths = new WeakMap<ProviderSessionConfig, string>();

const geminiTargetProfile: AcpTargetProfile = {
  target: "gemini",
  command() {
    const entry = getAcpTargetCatalogEntry("gemini");
    return [entry.command!, ...(entry.args ?? [])];
  },
  env(config) {
    const env = baseTargetEnv(config);
    const entry = getAcpTargetCatalogEntry("gemini");
    copyEnvKeys(config, env, entry.envKeys);
    // A worker has no interactive trust prompt; the task cwd is ours.
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
    // Startup fallback when the ACP `model` option is not advertised.
    if (config.model.trim()) env.GEMINI_MODEL = config.model.trim();
    const systemPromptPath = geminiSystemPromptPaths.get(config);
    if (systemPromptPath) env.GEMINI_SYSTEM_MD = systemPromptPath;
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact(config) {
    // GEMINI_SYSTEM_MD replaces Gemini CLI's built-in prompt, so an empty
    // swarm prompt keeps the built-in one instead of blanking it.
    if (!config.systemPrompt?.trim()) return;
    const directory = await mkdtemp(join(tmpdir(), "swarm-acp-gemini-"));
    const path = join(directory, "system.md");
    await Bun.write(path, config.systemPrompt);
    geminiSystemPromptPaths.set(config, path);
  },
};

/**
 * Copilot CLI has no system-prompt flag. Under `--acp` it reads custom
 * instructions from the git root, the cwd, and every directory listed in
 * COPILOT_CUSTOM_INSTRUCTIONS_DIRS. Verified against 1.0.97: from those extra
 * directories it loads `.github/instructions/*.instructions.md`, but not
 * `AGENTS.md`. So the swarm prompt goes into a per-task directory outside the
 * repo, and the repo's own AGENTS.md is never touched.
 */
export function copilotInstructionsDir(config: ProviderSessionConfig): string {
  const key = new Bun.CryptoHasher("sha256")
    .update(`${config.agentId}:${config.taskId}:${config.cwd}`)
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "agent-swarm-copilot-instructions", key);
}

export const COPILOT_INSTRUCTIONS_FILE = join(
  ".github",
  "instructions",
  "agent-swarm.instructions.md",
);

const copilotTargetProfile: AcpTargetProfile = {
  target: "copilot",
  command() {
    const entry = getAcpTargetCatalogEntry("copilot");
    return [entry.command!, ...(entry.args ?? [])];
  },
  env(config) {
    const env = baseTargetEnv(config);
    const entry = getAcpTargetCatalogEntry("copilot");
    copyEnvKeys(config, env, entry.envKeys);
    if (config.model.trim()) env.COPILOT_MODEL = config.model.trim();
    // The image pins the CLI; a self-update would run an unpinned binary.
    env.COPILOT_AUTO_UPDATE = "false";
    const operatorDirs = readEnv(config, "COPILOT_CUSTOM_INSTRUCTIONS_DIRS")?.trim();
    env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = [copilotInstructionsDir(config), operatorDirs]
      .filter(Boolean)
      .join(",");
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact(config) {
    const dir = copilotInstructionsDir(config);
    await rm(dir, { recursive: true, force: true });
    if (!config.systemPrompt) return;
    await mkdir(join(dir, ".github", "instructions"), { recursive: true });
    await Bun.write(
      join(dir, COPILOT_INSTRUCTIONS_FILE),
      `---\napplyTo: "**"\n---\n\n${config.systemPrompt}\n`,
    );
  },
  async cleanupSystemPromptArtifact(config) {
    await rm(copilotInstructionsDir(config), { recursive: true, force: true });
  },
};

/** Qwen Code's `--auth-type` choices (0.26.4). `qwen-oauth` needs a browser, so it is left out. */
const QWEN_AUTH_TYPES = ["openai", "openai-responses", "anthropic", "gemini", "vertex-ai"] as const;

// Qwen Code is a Gemini CLI fork: QWEN_SYSTEM_MD replaces its built-in prompt
// the way GEMINI_SYSTEM_MD does, so the file lives outside the task cwd too.
const qwenSystemPromptPaths = new WeakMap<ProviderSessionConfig, string>();

const qwenTargetProfile: AcpTargetProfile = {
  target: "qwen",
  command(config) {
    const entry = getAcpTargetCatalogEntry("qwen");
    // A fresh worker has no ~/.qwen/settings.json naming an auth type, and
    // without one the CLI waits for an interactive `/auth`.
    const authType = readEnv(config, "QWEN_AUTH_TYPE")?.trim() || "openai";
    if (!(QWEN_AUTH_TYPES as readonly string[]).includes(authType)) {
      throw new AcpTargetResolutionError(
        `Unsupported QWEN_AUTH_TYPE "${authType}". Supported: ${QWEN_AUTH_TYPES.join(", ")}.`,
      );
    }
    const args = [entry.command!, ...(entry.args ?? []), "--auth-type", authType];
    // Startup fallback when the ACP `model` option rejects the id.
    if (config.model.trim()) args.push("--model", config.model.trim());
    return args;
  },
  env(config) {
    const env = baseTargetEnv(config);
    copyEnvKeys(config, env, getAcpTargetCatalogEntry("qwen").envKeys);
    const systemPromptPath = qwenSystemPromptPaths.get(config);
    if (systemPromptPath) env.QWEN_SYSTEM_MD = systemPromptPath;
    return env;
  },
  // `--model` already set it; the ACP option wants a `<id>(<authType>)` value.
  configuredOptions(config) {
    const { model: _, ...options } = configuredOptions(config);
    return options;
  },
  async writeSystemPromptArtifact(config) {
    if (!config.systemPrompt?.trim()) return;
    const directory = await mkdtemp(join(tmpdir(), "swarm-acp-qwen-"));
    const path = join(directory, "system.md");
    await Bun.write(path, config.systemPrompt);
    qwenSystemPromptPaths.set(config, path);
  },
  async cleanupSystemPromptArtifact(config) {
    const path = qwenSystemPromptPaths.get(config);
    if (path) await rm(join(path, ".."), { recursive: true, force: true });
  },
};

/**
 * Kiro CLI reads its prompt from a Kiro agent config, not from a flag or an
 * env var, so the swarm system prompt is not injected (as with OpenCode).
 * Kiro 2.29.1 advertises no ACP config options, so the model rides on argv.
 */
const kiroTargetProfile: AcpTargetProfile = {
  target: "kiro",
  command(config) {
    const entry = getAcpTargetCatalogEntry("kiro");
    const args = [entry.command!, ...(entry.args ?? [])];
    if (config.model.trim()) args.push("--model", config.model.trim());
    return args;
  },
  env(config) {
    const env = baseTargetEnv(config);
    copyEnvKeys(config, env, getAcpTargetCatalogEntry("kiro").envKeys);
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact() {},
};

/**
 * Goose injects GOOSE_MOIM_MESSAGE_FILE into each turn's context, which is how
 * the swarm prompt reaches it without writing `.goosehints` into the repo.
 */
const gooseSystemPromptPaths = new WeakMap<ProviderSessionConfig, string>();

const gooseTargetProfile: AcpTargetProfile = {
  target: "goose",
  command() {
    const entry = getAcpTargetCatalogEntry("goose");
    return [entry.command!, ...(entry.args ?? [])];
  },
  env(config) {
    const env = baseTargetEnv(config);
    copyEnvKeys(config, env, getAcpTargetCatalogEntry("goose").envKeys);
    // A worker has no Secret Service; keys come from the environment.
    env.GOOSE_DISABLE_KEYRING = "1";
    // Startup fallback when the ACP `model` option is not applied.
    if (config.model.trim()) env.GOOSE_MODEL = config.model.trim();
    const systemPromptPath = gooseSystemPromptPaths.get(config);
    if (systemPromptPath) env.GOOSE_MOIM_MESSAGE_FILE = systemPromptPath;
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact(config) {
    if (!config.systemPrompt?.trim()) return;
    const directory = await mkdtemp(join(tmpdir(), "swarm-acp-goose-"));
    const path = join(directory, "system.md");
    await Bun.write(path, config.systemPrompt);
    gooseSystemPromptPaths.set(config, path);
  },
  async cleanupSystemPromptArtifact(config) {
    const path = gooseSystemPromptPaths.get(config);
    if (path) await rm(join(path, ".."), { recursive: true, force: true });
  },
};

/**
 * Grok CLI env keys passed through to `grok agent stdio`. `GROK_HOME` is the
 * per-session state dir the grok adapter creates; the rest switch off the
 * Claude/Cursor compat surfaces that would otherwise load the worker's own
 * Claude hooks, MCP servers, CLAUDE.md and rules into a Grok session.
 * Claude skills stay on so swarm skills remain invocable.
 */
export const GROK_ISOLATION_ENV: Readonly<Record<string, string>> = {
  GROK_DISABLE_AUTOUPDATER: "1",
  GROK_TELEMETRY_ENABLED: "0",
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  GROK_CURSOR_SKILLS_ENABLED: "false",
};

/**
 * The Grok CLI's endpoint overrides for the xAI route (docs.x.ai settings
 * reference): `GROK_MODELS_BASE_URL` points inference and the model list at
 * any OpenAI-compatible gateway, authenticated with XAI_API_KEY.
 */
export const GROK_XAI_ENDPOINT_KEYS = [
  "GROK_MODELS_BASE_URL",
  "GROK_MODELS_LIST_URL",
  "GROK_XAI_API_BASE_URL",
] as const;

/** `openrouter/<vendor>/<id>`: an OpenRouter model the grok adapter registers in `config.toml`. */
export function isGrokOpenRouterModel(model: string): boolean {
  return model.trim().startsWith("openrouter/");
}

/**
 * Grok exposes MCP tools through its `use_tool` proxy (on-demand tool search),
 * so every swarm call arrives as `use_tool {tool_name: "swarm__get-swarm",
 * tool_input}`. Unwrap it to the `mcp__<server>__<tool>` name and its own
 * input, the shape every other harness logs. Grok's in-progress updates
 * repeat the input tagged with a `variant` (`UseTool`, `SearchTool`); the
 * dashboard merges update input into the call, so the tag is dropped and a
 * `UseTool` update carries only the inner input.
 */
function unwrapGrokToolProxy(event: ProviderEvent): ProviderEvent {
  if (event.type === "tool_start" && event.toolName === "use_tool") {
    const args = event.args as { tool_name?: unknown; tool_input?: unknown } | null;
    if (typeof args?.tool_name !== "string" || !args.tool_name) return event;
    return { ...event, toolName: `mcp__${args.tool_name}`, args: args.tool_input ?? {} };
  }
  if (event.type !== "custom" || event.name !== "acp_tool_call_update") return event;
  const data = event.data as { rawInput?: unknown } | null;
  const raw = data?.rawInput as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.variant !== "string") return event;
  const { variant, ...rest } = raw;
  const rawInput = variant === "UseTool" ? (rest.tool_input ?? {}) : rest;
  return { ...event, data: { ...(data as Record<string, unknown>), rawInput } };
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** xAI bills in ticks of 1e-10 USD (`costUsdTicks`). */
const XAI_USD_TICKS = 10_000_000_000;

/**
 * The swarm id of a model Grok reports (`_meta.modelId`, a `modelUsage` key)
 * in a session started on `sessionModel`. An OpenRouter session only reaches
 * OpenRouter, so its ids keep the `openrouter/` namespace pricing and context
 * lookups need; an xAI session's ids are bare xAI ids.
 */
export function grokReportedModel(reported: string, sessionModel: string): string {
  const id = normalizeGrokModel(reported);
  if (!isGrokOpenRouterModel(sessionModel) || isGrokOpenRouterModel(id)) return id;
  return `openrouter/${id}`;
}

/** The model Grok says ran the prompt's last call, else the session's model. */
function grokFinalModel(meta: Record<string, unknown> | null | undefined, model: string): string {
  const reported = typeof meta?.modelId === "string" ? meta.modelId.trim() : "";
  return reported ? grokReportedModel(reported, model) : normalizeGrokModel(model);
}

/**
 * Grok's usage counts in the swarm's shape: its `inputTokens` include cache
 * reads and its `outputTokens` exclude reasoning, so both are converted to the
 * swarm's disjoint input and reasoning-inclusive output.
 */
function grokUsageCounts(usage: Record<string, unknown>) {
  const input = finiteCount(usage.inputTokens) ?? 0;
  const cacheRead = finiteCount(usage.cachedReadTokens) ?? 0;
  const reasoning = finiteCount(usage.reasoningTokens) ?? 0;
  const ticks = finiteCount(usage.costUsdTicks);
  return {
    inputTokens: Math.max(0, input - cacheRead),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: finiteCount(usage.cacheCreationTokens) ?? 0,
    outputTokens: (finiteCount(usage.outputTokens) ?? 0) + reasoning,
    reasoningOutputTokens: reasoning,
    costUsd: ticks ? ticks / XAI_USD_TICKS : undefined,
  };
}

/** `_meta.usage.modelUsage` as per-model rows, keyed by the swarm model id. */
function grokModelUsage(usage: Record<string, unknown>, model: string): CostModelUsage[] {
  const byModel = usage.modelUsage;
  if (!byModel || typeof byModel !== "object" || Array.isArray(byModel)) return [];
  const rows: CostModelUsage[] = [];
  for (const [reported, entry] of Object.entries(byModel as Record<string, unknown>)) {
    if (!reported.trim() || !entry || typeof entry !== "object") continue;
    const {
      costUsd,
      reasoningOutputTokens: _,
      ...counts
    } = grokUsageCounts(entry as Record<string, unknown>);
    rows.push({
      model: grokReportedModel(reported, model),
      ...counts,
      ...(costUsd !== undefined ? { harnessCostUsd: costUsd } : {}),
    });
  }
  return rows;
}

/**
 * Grok answers `session/prompt` with `usage: null` and puts the prompt's
 * cumulative usage in `_meta.usage`, split per model in `modelUsage` (a side
 * model or a fallback shows up as its own entry). `_meta.modelId` names the
 * model that ran, which can differ from the one requested. `costUsdTicks` is
 * what xAI billed; a BYOK model (OpenRouter) reports none and is priced from
 * the table, per model.
 */
export function grokPromptCost(
  meta: Record<string, unknown> | null | undefined,
  model: string,
): Partial<CostData> | undefined {
  const usage = meta?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const { costUsd, ...counts } = grokUsageCounts(usage);
  const turns = finiteCount(usage.numTurns) ?? finiteCount(usage.modelCalls);
  const models = grokModelUsage(usage, model);
  return {
    model: grokFinalModel(meta, model),
    ...counts,
    ...(models.length ? { models } : {}),
    ...(costUsd !== undefined ? { totalCostUsd: costUsd } : {}),
    ...(turns ? { numTurns: turns } : {}),
  };
}

/**
 * Grok sends no `usage_update`. The prompt response's top-level `_meta`
 * describes the last model call: `totalTokens` is its input (cache reads
 * included), output and reasoning, i.e. how full the context was at the end,
 * and `modelId` is the model whose window that is.
 */
export function grokPromptContext(
  meta: Record<string, unknown> | null | undefined,
  model: string,
): Extract<ProviderEvent, { type: "context_usage" }> | undefined {
  const used = finiteCount(meta?.totalTokens);
  if (!used) return undefined;
  const id = grokFinalModel(meta, model);
  const total = getContextWindowSize(isGrokOpenRouterModel(id) ? id : `xai/${id}`);
  return {
    type: "context_usage",
    contextUsedTokens: used,
    contextTotalTokens: total,
    contextPercent: clampContextPercent(used, total),
    outputTokens: finiteCount(meta?.outputTokens) ?? null,
    contextFormula: "harness-reported",
  };
}

/** `-32000 Authentication required` (ACP) or the CLI's "Not signed in" text. */
const GROK_AUTH_ERROR_RE = /authentication required|not signed in/i;

export const grokTargetProfile: AcpTargetProfile = {
  target: "grok",
  command(config) {
    const binary = readEnv(config, "GROK_BINARY")?.trim() || "grok";
    // `--no-leader` keeps each session on its own agent process (the default
    // config may enable a shared leader socket). Flags go before `stdio`.
    const args = [binary, "agent", "--no-leader", "--always-approve"];
    if (config.model.trim()) args.push("--model", config.model.trim());
    const effort = config.reasoningEffort
      ? applyReasoningEffort("grok", config.model.trim(), config.reasoningEffort)
      : null;
    if (effort?.kind === "grok-effort") args.push("--reasoning-effort", effort.reasoningEffort);
    args.push("stdio");
    return args;
  },
  env(config) {
    const env = baseTargetEnv(config);
    // Each route gets only its own key: an OpenRouter session never sees
    // XAI_API_KEY, so no side model (web search, summaries) bills xAI.
    if (isGrokOpenRouterModel(config.model)) {
      copyEnvKeys(config, env, ["OPENROUTER_API_KEY", "GROK_HOME"]);
    } else {
      copyEnvKeys(config, env, ["XAI_API_KEY", "GROK_HOME", ...GROK_XAI_ENDPOINT_KEYS]);
    }
    Object.assign(env, GROK_ISOLATION_ENV);
    return env;
  },
  // Model and effort ride on the command line, which the CLI accepts before auth.
  configuredOptions() {
    return {};
  },
  async writeSystemPromptArtifact() {},
  sessionMeta(config) {
    // `rules` appends to Grok's own system prompt; `systemPromptOverride`
    // would replace it, tool instructions included.
    return {
      ...(config.systemPrompt?.trim() ? { rules: config.systemPrompt } : {}),
      yoloMode: true,
    };
  },
  rewriteEvent: unwrapGrokToolProxy,
  promptCost: grokPromptCost,
  promptContext: grokPromptContext,
  describeError(message) {
    if (!GROK_AUTH_ERROR_RE.test(message)) return undefined;
    return `Grok rejected the credentials (XAI_API_KEY or OPENROUTER_API_KEY invalid or missing): ${message}`;
  },
};

// ---------------------------------------------------------------------------
// fx (Vercel Labs' `fx acp`), measured against fx 0.0.15 on 2026-10-29.
// ---------------------------------------------------------------------------

/** Above this many UTF-8 bytes the prompt goes to a file; fx caps `systemPrompt` at 64 KiB. */
export const FX_SYSTEM_PROMPT_INLINE_MAX_BYTES = 60 * 1024;
/** How much of an oversized prompt is still sent inline, ahead of the pointer line. */
export const FX_SYSTEM_PROMPT_HEAD_BYTES = 56 * 1024;
const FX_SYSTEM_PROMPT_FILE_TEMPLATE = "system.agent.fx.system_prompt_file";
/** fx streams this notice as an assistant message chunk; it is not model output. */
const FX_CONTEXT_NOTICE_PREFIX = "[context] ";
const FX_AUTH_ERROR_RE =
  /authentication is unavailable|credential is unavailable|MissingApiKey|unauthorized|\b401\b/i;

/**
 * Per-task scratch dir for fx: `acp.log` (`--log-file`) and, for an oversized
 * prompt, `SYSTEM.md`. Outside the task cwd, removed when the session ends.
 */
export function fxRunDir(config: Pick<ProviderSessionConfig, "taskId">): string {
  const safe = config.taskId.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
  return join(tmpdir(), `fx-${safe}`);
}

/** The first `max` bytes of `bytes` as text, never ending inside a UTF-8 sequence. */
function utf8Head(bytes: Uint8Array, max: number): string {
  let end = Math.min(max, bytes.length);
  // Back off continuation bytes (10xxxxxx) so a multi-byte character is not split.
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

async function fxSystemPromptPointer(path: string): Promise<string> {
  try {
    const result = await resolveTemplateAsync(FX_SYSTEM_PROMPT_FILE_TEMPLATE, { path });
    if (!result.skipped && result.text.trim()) return result.text;
  } catch {
    // Fall through to the code default.
  }
  // A skipped or blank override must not drop the pointer to the full prompt.
  return resolveTemplateFromCode(FX_SYSTEM_PROMPT_FILE_TEMPLATE, { path }).text;
}

/**
 * The `systemPrompt` fx gets. Up to 60 KiB it is the prompt itself. A larger
 * one is written whole to `<dir>/SYSTEM.md`; fx then gets its first 56 KiB plus
 * a line telling the model to read that file first (fx returns `-32602
 * systemPrompt exceeds the 64 KiB limit` above 65,536 bytes).
 */
export async function fxSystemPrompt(
  systemPrompt: string,
  dir: string,
): Promise<AcpSessionSystemPrompt | undefined> {
  if (!systemPrompt.trim()) return undefined;
  const bytes = new TextEncoder().encode(systemPrompt);
  if (bytes.length <= FX_SYSTEM_PROMPT_INLINE_MAX_BYTES) {
    return { blocks: [{ type: "text", text: systemPrompt }] };
  }
  const artifactPath = join(dir, "SYSTEM.md");
  await mkdir(dir, { recursive: true });
  await Bun.write(artifactPath, systemPrompt);
  await chmod(artifactPath, 0o600);
  const head = utf8Head(bytes, FX_SYSTEM_PROMPT_HEAD_BYTES);
  const pointer = await fxSystemPromptPointer(artifactPath);
  return { blocks: [{ type: "text", text: `${head}\n\n${pointer}` }], artifactPath };
}

/** `~/.fx/sessions/v2/<id>/log.jsonl`: where fx 0.0.15 keeps a saved session. */
export async function fxSessionExists(
  sessionId: string,
  home: string | undefined,
): Promise<boolean> {
  if (!home || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return false;
  return Bun.file(join(home, ".fx", "sessions", "v2", sessionId, "log.jsonl")).exists();
}

type FxToolCallMeta = { fx?: { toolCall?: { mcp?: { server?: unknown; tool?: unknown } } } };

/**
 * fx's display adjustments:
 * - The `[context] … capability_search` notice arrives as its own assistant
 *   chunk. It becomes an `fx_context_notice` custom event, so it never reaches
 *   the task output.
 * - A `tool_call` titles the action ("Running", "Get the agent swarm") and
 *   names the tool in a non-standard `name` field (`shell`, `skill`,
 *   `mcp_swarm_get-swarm`), with the MCP server and tool in
 *   `_meta.fx.toolCall.mcp`. The tool start carries that name, MCP calls as
 *   `mcp__<server>__<tool>` like every other harness.
 */
export function rewriteFxEvent(event: ProviderEvent, update?: SessionUpdate): ProviderEvent {
  if (
    event.type === "message" &&
    event.role === "assistant" &&
    event.content.startsWith(FX_CONTEXT_NOTICE_PREFIX)
  ) {
    return {
      type: "custom",
      name: "fx_context_notice",
      data: { text: event.content, messageId: event.messageId ?? null },
    };
  }
  if (event.type === "tool_start" && update?.sessionUpdate === "tool_call") {
    const mcp = (update._meta as FxToolCallMeta | null | undefined)?.fx?.toolCall?.mcp;
    if (typeof mcp?.server === "string" && typeof mcp.tool === "string" && mcp.server && mcp.tool) {
      return { ...event, toolName: `mcp__${mcp.server}__${mcp.tool}` };
    }
    const name = (update as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return { ...event, toolName: name.trim() };
  }
  return event;
}

/**
 * fx's native steer: a second `session/prompt` with `_meta.fx.steer` during the
 * running turn. fx applies it at the next tool boundary without cancelling and
 * echoes it as a `user_message_chunk` carrying `_meta.fx.steering`; the steer
 * request itself resolves with the turn, `_meta.fx.steering: "absorbed"`.
 * Either one counts as delivered. The echo arrives first, so the row is
 * `delivered` while the turn still runs and `accept-steer` can mark it handled.
 * Any other answer is undeliverable and the runner promotes the message.
 */
export async function steerFx({
  sessionId,
  delivery,
  initResult,
  prompt,
  onUpdate,
}: AcpSteerContext): Promise<SteerDeliveryResult> {
  if (delivery.mode !== "steer") {
    return { delivered: false, reason: `fx supports steer only, not ${delivery.mode}` };
  }
  const meta = initResult.agentCapabilities?._meta as { fx?: { steering?: unknown } } | undefined;
  if (meta?.fx?.steering !== true) {
    return { delivered: false, reason: "fx did not advertise _meta.fx.steering" };
  }
  return new Promise<SteerDeliveryResult>((resolve) => {
    let settled = false;
    let stopListening = () => {};
    const settle = (result: SteerDeliveryResult) => {
      if (settled) return;
      settled = true;
      stopListening();
      resolve(result);
    };
    stopListening = onUpdate((update) => {
      if (update.sessionUpdate !== "user_message_chunk") return;
      const steering = (update._meta as { fx?: { steering?: unknown } } | null | undefined)?.fx
        ?.steering;
      if (!steering || update.content.type !== "text" || update.content.text !== delivery.text) {
        return;
      }
      settle({ delivered: true, mode: "steer" });
    });
    prompt({
      sessionId,
      prompt: [{ type: "text", text: delivery.text }],
      _meta: { fx: { steer: true } },
    }).then(
      (response) => {
        const state = (response._meta as { fx?: { steering?: unknown } } | null | undefined)?.fx
          ?.steering;
        settle(
          state === "absorbed"
            ? { delivered: true, mode: "steer" }
            : {
                delivered: false,
                reason: `fx did not absorb the steer (stopReason ${response.stopReason}, steering ${JSON.stringify(state ?? null)})`,
              },
        );
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        settle({ delivered: false, reason: scrubSecrets(`fx steer failed: ${message}`) });
      },
    );
  });
}

export const fxTargetProfile: AcpTargetProfile = {
  target: "fx",
  command(config) {
    const binary = readEnv(config, "FX_BINARY")?.trim() || "fx";
    const route = requireFxRoute(config.model);
    return [
      binary,
      "acp",
      "--model",
      route.fxModel,
      "--log-file",
      join(fxRunDir(config), "acp.log"),
    ];
  },
  env(config) {
    const route = requireFxRoute(config.model);
    const env = baseTargetEnv(config);
    // Only the route's own key: an OpenRouter session never sees OPENAI_API_KEY.
    copyEnvKeys(config, env, [route.keyVar]);
    // Process-local selection and permissions. `session/set_mode` and the
    // `mode` / `provider` config options persist into ~/.fx/settings.json, so
    // the adapter never sends them. Auto mode's reviewer holds swarm MCP calls
    // headless, so the session runs full-access.
    env.FX_PROVIDER = route.fxProvider;
    env.FX_PERMISSION_MODE = "full-access";
    env.FX_AUTO_UPGRADE = "0";
    env.FX_NO_OPEN_BROWSER = "1";
    return env;
  },
  // The model rides on `--model`. Only fx's AI Gateway provider has an
  // `effort` option; custom connections send no reasoning control.
  configuredOptions(config): Record<string, string | boolean> {
    if (!config.reasoningEffort) return {};
    const effort = applyReasoningEffort("fx", config.model.trim(), config.reasoningEffort);
    return effort.kind === "fx-effort" ? { effort: effort.reasoningEffort } : {};
  },
  async writeSystemPromptArtifact(config) {
    // acp.log can hold session/new params, including the ephemeral MCP bearer.
    await mkdir(fxRunDir(config), { recursive: true, mode: 0o700 });
  },
  async cleanupSystemPromptArtifact(config) {
    await rm(fxRunDir(config), { recursive: true, force: true });
  },
  sessionSystemPrompt(config) {
    return fxSystemPrompt(config.systemPrompt ?? "", fxRunDir(config));
  },
  requiresSecureMcpUrl: true,
  steer: steerFx,
  resume: {
    method: "session/resume",
    canResume: (sessionId) => fxSessionExists(sessionId, process.env.HOME),
  },
  rewriteEvent: rewriteFxEvent,
  describeError(message) {
    if (!FX_AUTH_ERROR_RE.test(message)) return undefined;
    return `fx could not authenticate the model route (OPENROUTER_API_KEY, OPENAI_API_KEY or AI_GATEWAY_API_KEY invalid or missing): ${message}`;
  },
};

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  if (!isAcpTarget(target)) {
    throw new AcpTargetResolutionError(
      `Unsupported ACP target "${target}". Supported targets: ${ACP_TARGET_IDS.join(", ")}.`,
    );
  }
  switch (target) {
    case "opencode":
      return opencodeTargetProfile;
    case "gemini":
      return geminiTargetProfile;
    case "copilot":
      return copilotTargetProfile;
    case "qwen":
      return qwenTargetProfile;
    case "kiro":
      return kiroTargetProfile;
    case "goose":
      return gooseTargetProfile;
    case "custom":
      return customTargetProfile;
  }
}
