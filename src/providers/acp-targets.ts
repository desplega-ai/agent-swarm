import { join } from "node:path";
import type { ProviderSessionConfig } from "./types";

export type AcpTarget = "custom" | "claude-agent-acp";

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

// ─── claude-agent-acp target ────────────────────────────────────────────────
// Wraps Claude Code via @zed-industries/claude-agent-acp. Reads Claude
// credentials from the environment and writes the system prompt to CLAUDE.md
// in the session cwd (the convention Claude Code uses for project instructions).

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

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  switch (target) {
    case "custom":
      return customTargetProfile;
    case "claude-agent-acp":
      return claudeAgentAcpTargetProfile;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP target "${target}". Supported targets: custom, claude-agent-acp.`,
      );
  }
}
