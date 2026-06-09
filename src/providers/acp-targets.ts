import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { writeClaudeMd } from "./claude-md";
import { writeCodexAgentsMd } from "./codex-agents-md";
import type { CostData, ProviderSessionConfig } from "./types";

export type AcpTarget = "custom" | "gemini-cli" | "claude-agent-acp" | "codex-acp";
export type AcpCostProvider = NonNullable<CostData["provider"]>;

export interface AcpArtifactCleanup {
  cleanup(): Promise<void>;
}

const NOOP_CLEANUP: AcpArtifactCleanup = { cleanup: async () => {} };

export interface AcpTargetProfile {
  readonly target: AcpTarget;
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  prompt(config: ProviderSessionConfig): ContentBlock[];
  costProvider(config: ProviderSessionConfig): AcpCostProvider;
  writeSystemPromptArtifact(config: ProviderSessionConfig): Promise<AcpArtifactCleanup>;
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
  "NODE_EXTRA_CA_CERTS",
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

function customTargetEnv(config: ProviderSessionConfig): Record<string, string> {
  const env = baseTargetEnv(config);
  for (const source of [process.env, config.env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (!key.startsWith("ACP_ENV_") || value == null) continue;
      const targetKey = key.slice("ACP_ENV_".length);
      if (!targetKey) {
        throw new AcpTargetResolutionError(
          "Invalid ACP_ENV_ entry. Set variables as ACP_ENV_<TARGET_ENV_NAME>=value.",
        );
      }
      env[targetKey] = value;
    }
  }
  return env;
}

function parseCommand(command: string, args: string | undefined): string[] {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AcpTargetResolutionError(
      "ACP target command is empty. Set ACP_COMMAND to an ACP-compatible executable.",
    );
  }

  if (args?.trim()) {
    const rawArgs = args.trim();
    try {
      const parsed = JSON.parse(rawArgs);
      if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
        return [trimmed, ...parsed];
      }
      throw new AcpTargetResolutionError(
        "Invalid ACP_ARGS. Expected a JSON string array, for example ACP_ARGS='[\"--stdio\"]'.",
      );
    } catch (err) {
      if (err instanceof AcpTargetResolutionError) throw err;
      if (rawArgs.startsWith("[") || rawArgs.startsWith("{")) {
        throw new AcpTargetResolutionError(
          "Invalid ACP_ARGS JSON. Expected a JSON string array, for example ACP_ARGS='[\"--stdio\"]'.",
        );
      }
      // Fall through to whitespace splitting for simple env configuration.
    }
    return [trimmed, ...rawArgs.split(/\s+/).filter(Boolean)];
  }

  return trimmed.split(/\s+/).filter(Boolean);
}

function addEnvIfPresent(
  env: Record<string, string>,
  config: ProviderSessionConfig,
  key: string,
): void {
  const value = readEnv(config, key);
  if (value) env[key] = value;
}

function copyConfiguredEnv(
  config: ProviderSessionConfig,
  env: Record<string, string>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = readEnv(config, key);
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (/^codex_oauth_\d+$/.test(key) && value) {
      env[key] = value;
    }
  }
}

function systemPromptPath(config: ProviderSessionConfig): string | undefined {
  return (
    readEnv(config, "ACP_SYSTEM_PROMPT_ARTIFACT_PATH") ?? readEnv(config, "ACP_SYSTEM_PROMPT_PATH")
  );
}

function systemPromptFallback(config: ProviderSessionConfig): "none" | "user_message" {
  const mode =
    readEnv(config, "ACP_SYSTEM_PROMPT_FALLBACK") ??
    readEnv(config, "ACP_SYSTEM_PROMPT_MODE") ??
    "none";
  if (mode === "none" || mode === "artifact") return "none";
  if (mode === "user_message") return "user_message";
  throw new AcpTargetResolutionError(
    `Unsupported ACP system prompt mode "${mode}". Use "none", "artifact", or "user_message".`,
  );
}

function resolveCostProvider(config: ProviderSessionConfig): AcpCostProvider {
  const provider = readEnv(config, "ACP_COST_PROVIDER") ?? "acp";
  switch (provider) {
    case "claude":
    case "claude-managed":
    case "codex":
    case "pi":
    case "opencode":
    case "devin":
    case "gemini":
    case "acp":
      return provider;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP_COST_PROVIDER "${provider}". Use claude, claude-managed, codex, pi, opencode, devin, gemini, or acp.`,
      );
  }
}

function defaultPrompt(config: ProviderSessionConfig): ContentBlock[] {
  return [{ type: "text", text: config.prompt }];
}

// ─── custom target ──────────────────────────────────────────────────────────

const customTargetProfile: AcpTargetProfile = {
  target: "custom",
  command(config) {
    const command = readEnv(config, "ACP_COMMAND") ?? readEnv(config, "ACP_TARGET_COMMAND");
    if (!command) {
      throw new AcpTargetResolutionError(
        "No ACP target configured. Set ACP_COMMAND to an ACP-compatible executable before using HARNESS_PROVIDER=acp.",
      );
    }
    return parseCommand(command, readEnv(config, "ACP_ARGS") ?? readEnv(config, "ACP_TARGET_ARGS"));
  },
  env(config) {
    return customTargetEnv(config);
  },
  prompt(config) {
    const prompt: ContentBlock[] = [];
    if (systemPromptFallback(config) === "user_message" && config.systemPrompt.trim()) {
      prompt.push({ type: "text", text: config.systemPrompt });
    }
    prompt.push({ type: "text", text: config.prompt });
    return prompt;
  },
  costProvider(config) {
    return resolveCostProvider(config);
  },
  async writeSystemPromptArtifact(config) {
    const relativePath = systemPromptPath(config);
    if (!relativePath) return NOOP_CLEANUP;
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, config.systemPrompt ?? "");
    return NOOP_CLEANUP;
  },
};

// ─── gemini-cli target ──────────────────────────────────────────────────────

const GEMINI_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "GEMINI_TELEMETRY_ENABLED",
  "GEMINI_TELEMETRY_TARGET",
  "GEMINI_TELEMETRY_OUTFILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

const geminiCliTargetProfile: AcpTargetProfile = {
  target: "gemini-cli",
  command(config) {
    const command =
      readEnv(config, "ACP_GEMINI_COMMAND") ??
      readEnv(config, "GEMINI_ACP_COMMAND") ??
      readEnv(config, "GEMINI_COMMAND") ??
      "gemini";
    const args = readEnv(config, "ACP_GEMINI_ARGS") ?? readEnv(config, "GEMINI_ACP_ARGS");
    return parseCommand(command, args ?? JSON.stringify(["--acp"]));
  },
  env(config) {
    const env = baseTargetEnv(config);
    for (const key of GEMINI_ENV_KEYS) {
      addEnvIfPresent(env, config, key);
    }
    return env;
  },
  prompt: defaultPrompt,
  costProvider() {
    return "gemini";
  },
  async writeSystemPromptArtifact(config) {
    const relativePath = readEnv(config, "ACP_GEMINI_SYSTEM_PROMPT_PATH") ?? "GEMINI.md";
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await Bun.write(targetPath, config.systemPrompt ?? "");
    return NOOP_CLEANUP;
  },
};

// ─── claude-agent-acp target ────────────────────────────────────────────────

const CLAUDE_ACP_BINARY = "claude-agent-acp";

const CLAUDE_ACP_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_API_KEY",
] as const;

function resolveClaudeAcpCommand(config: ProviderSessionConfig): string[] {
  const explicit = readEnv(config, "ACP_TARGET_COMMAND") ?? readEnv(config, "ACP_COMMAND");
  if (explicit) {
    return parseCommand(explicit, readEnv(config, "ACP_TARGET_ARGS"));
  }

  const binDir = readEnv(config, "BUN_INSTALL");
  const candidates = binDir
    ? [join(binDir, "bin", CLAUDE_ACP_BINARY), CLAUDE_ACP_BINARY]
    : [CLAUDE_ACP_BINARY];

  for (const candidate of candidates) {
    try {
      const resolved = Bun.which(candidate, { PATH: readEnv(config, "PATH") ?? "" });
      if (resolved) {
        const args = readEnv(config, "ACP_TARGET_ARGS");
        return args ? parseCommand(resolved, args) : [resolved];
      }
    } catch {
      // Bun.which can throw on invalid input; try next candidate.
    }
  }

  throw new AcpTargetResolutionError(
    `Could not resolve "${CLAUDE_ACP_BINARY}" on PATH. Install it with: npm install -g @zed-industries/claude-agent-acp`,
  );
}

const claudeAgentAcpTargetProfile: AcpTargetProfile = {
  target: "claude-agent-acp",
  command(config) {
    return resolveClaudeAcpCommand(config);
  },
  env(config) {
    const env = baseTargetEnv(config);
    for (const key of CLAUDE_ACP_ENV_KEYS) {
      const value = readEnv(config, key);
      if (value) env[key] = value;
    }
    return env;
  },
  prompt: defaultPrompt,
  costProvider() {
    return "claude";
  },
  async writeSystemPromptArtifact(config) {
    return await writeClaudeMd(config.cwd, config.systemPrompt);
  },
};

// ─── codex-acp target ───────────────────────────────────────────────────────

const CODEX_ACP_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_OAUTH",
  "CODEX_HOME",
  "CODEX_PATH_OVERRIDE",
] as const;

const codexAcpTargetProfile: AcpTargetProfile = {
  target: "codex-acp",
  command(config) {
    const command = readEnv(config, "ACP_TARGET_COMMAND") ?? readEnv(config, "ACP_COMMAND");
    if (command) {
      return parseCommand(command, readEnv(config, "ACP_TARGET_ARGS"));
    }
    return ["codex-acp"];
  },
  env(config) {
    const env = baseTargetEnv(config);
    copyConfiguredEnv(config, env, CODEX_ACP_ENV_KEYS);
    return env;
  },
  prompt: defaultPrompt,
  costProvider() {
    return "codex";
  },
  async writeSystemPromptArtifact(config) {
    return await writeCodexAgentsMd(config.cwd, config.systemPrompt);
  },
};

// ─── resolver ───────────────────────────────────────────────────────────────

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  switch (target) {
    case "custom":
      return customTargetProfile;
    case "gemini-cli":
      return geminiCliTargetProfile;
    case "claude-agent-acp":
      return claudeAgentAcpTargetProfile;
    case "codex-acp":
      return codexAcpTargetProfile;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP target "${target}". Supported targets: custom, gemini-cli, claude-agent-acp, codex-acp.`,
      );
  }
}
