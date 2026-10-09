import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGrokModel } from "@desplega/model-catalog";
import type { Config } from "@opencode-ai/sdk";
import { clampContextPercent, getContextWindowSize } from "../utils/context-window";
import {
  ACP_TARGET_IDS,
  type AcpTarget,
  getAcpTargetCatalogEntry,
  isAcpTarget,
} from "./acp-target-catalog";
import { applyOpenRouterBaseUrlOverride } from "./opencode-adapter";
import { applyReasoningEffort } from "./reasoning-effort";
import type { CostData, CostModelUsage, ProviderEvent, ProviderSessionConfig } from "./types";

export interface AcpTargetProfile {
  /** An operator-selectable ACP target, or a first-class harness built on the ACP client. */
  readonly target: AcpTarget | "grok";
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
  /** Rewrites a translated event for display, e.g. unwrapping a tool proxy. */
  rewriteEvent?(event: ProviderEvent): ProviderEvent;
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
  applyOpenRouterBaseUrlOverride(value as Config, env);
  env[key] = JSON.stringify(value);
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
 * COPILOT_CUSTOM_INSTRUCTIONS_DIRS. Verified against 1.0.94: from those extra
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
    case "custom":
      return customTargetProfile;
  }
}
