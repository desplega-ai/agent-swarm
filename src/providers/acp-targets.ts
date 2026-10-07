import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_TARGET_IDS,
  type AcpTarget,
  getAcpTargetCatalogEntry,
  isAcpTarget,
} from "./acp-target-catalog";
import type { ProviderSessionConfig } from "./types";

export interface AcpTargetProfile {
  readonly target: AcpTarget;
  command(config: ProviderSessionConfig): string[];
  env(config: ProviderSessionConfig): Record<string, string>;
  configuredOptions(config: ProviderSessionConfig): Record<string, string | boolean>;
  writeSystemPromptArtifact(config: ProviderSessionConfig): Promise<void>;
  /** Removes what writeSystemPromptArtifact wrote. Called once the session ends or fails to start. */
  cleanupSystemPromptArtifact?(config: ProviderSessionConfig): Promise<void>;
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
 * COPILOT_CUSTOM_INSTRUCTIONS_DIRS. Verified against 1.0.93: from those extra
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
