import { join } from "node:path";
import { writeCodexAgentsMd } from "./codex-agents-md";
import type { ProviderSessionConfig } from "./types";

export type AcpTarget = "custom" | "gemini-cli" | "claude-agent-acp" | "codex-acp";

export interface AcpTargetProfile {
  readonly target: AcpTarget;
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  writeSystemPromptArtifact(config: ProviderSessionConfig): Promise<void>;
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

// ─── custom target ──────────────────────────────────────────────────────────

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
    return baseTargetEnv(config);
  },
  async writeSystemPromptArtifact(config) {
    const relativePath = readEnv(config, "ACP_SYSTEM_PROMPT_PATH");
    if (!relativePath) return;
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await Bun.write(targetPath, config.systemPrompt ?? "");
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
  async writeSystemPromptArtifact(config) {
    const relativePath = readEnv(config, "ACP_GEMINI_SYSTEM_PROMPT_PATH") ?? "GEMINI.md";
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await Bun.write(targetPath, config.systemPrompt ?? "");
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
  async writeSystemPromptArtifact(config) {
    if (!config.systemPrompt) return;
    const targetPath = join(config.cwd, "CLAUDE.md");
    await Bun.write(targetPath, config.systemPrompt);
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
  async writeSystemPromptArtifact(config) {
    await writeCodexAgentsMd(config.cwd, config.systemPrompt);
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
