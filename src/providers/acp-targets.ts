import { join } from "node:path";
import type { ProviderSessionConfig } from "./types";

export type AcpTarget = "custom" | "gemini-cli";

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

function addEnvIfPresent(
  env: Record<string, string>,
  config: ProviderSessionConfig,
  key: string,
): void {
  const value = readEnv(config, key);
  if (value) env[key] = value;
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

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  switch (target) {
    case "custom":
      return customTargetProfile;
    case "gemini-cli":
      return geminiCliTargetProfile;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP target "${target}". Supported ACP targets: custom, gemini-cli.`,
      );
  }
}
