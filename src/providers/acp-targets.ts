import { join } from "node:path";
import { type AcpTarget, getAcpTargetCatalogEntry, isAcpTarget } from "./acp-target-catalog";
import type { ProviderSessionConfig } from "./types";

export interface AcpTargetProfile {
  readonly target: AcpTarget;
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  configuredOptions(config: ProviderSessionConfig): Record<string, string | boolean>;
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

function withModelInJsonEnv(env: Record<string, string>, key: string, model: string): void {
  if (!model.trim()) return;
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
  env[key] = JSON.stringify({ ...value, model: model.trim() });
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
    withModelInJsonEnv(env, "OPENCODE_CONFIG_CONTENT", config.model);
    return env;
  },
  configuredOptions,
  async writeSystemPromptArtifact() {},
};

export function resolveAcpTarget(config: ProviderSessionConfig): AcpTargetProfile {
  const target = readEnv(config, "ACP_TARGET") ?? "custom";
  if (!isAcpTarget(target)) {
    throw new AcpTargetResolutionError(
      `Unsupported ACP target "${target}". Supported targets: opencode, custom.`,
    );
  }
  switch (target) {
    case "opencode":
      return opencodeTargetProfile;
    case "custom":
      return customTargetProfile;
  }
}
