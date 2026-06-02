import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { CostData, ProviderSessionConfig } from "./types";

export type AcpTarget = "custom";
export type AcpCostProvider = NonNullable<CostData["provider"]>;

export interface AcpTargetProfile {
  readonly target: AcpTarget;
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  prompt(config: ProviderSessionConfig): ContentBlock[];
  costProvider(config: ProviderSessionConfig): AcpCostProvider;
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
    } catch {
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
    if (!relativePath) return;
    const targetPath = relativePath.startsWith("/") ? relativePath : join(config.cwd, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await Bun.write(targetPath, config.systemPrompt ?? "");
  },
};

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  switch (target) {
    case "custom":
      return customTargetProfile;
    default:
      throw new AcpTargetResolutionError(
        `Unsupported ACP target "${target}". Slice 0 only includes the custom target resolver; target-specific profiles are added by later ACPHarness slices.`,
      );
  }
}
