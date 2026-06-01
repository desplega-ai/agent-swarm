import { join } from "node:path";
import { writeCodexAgentsMd } from "./codex-agents-md";
import type { ProviderSessionConfig } from "./types";

export type AcpTarget = "custom" | "codex-acp";

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

const CODEX_ACP_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  "CODEX_OAUTH",
  "CODEX_HOME",
  "CODEX_PATH_OVERRIDE",
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

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  switch (target) {
    case "custom":
      return customTargetProfile;
    case "codex-acp":
      return codexAcpTargetProfile;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP target "${target}". Supported ACP targets: custom, codex-acp.`,
      );
  }
}
