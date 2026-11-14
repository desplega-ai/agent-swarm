import { existsSync } from "node:fs";
import type { ProviderName } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import type { ProviderSessionConfig } from "./types";

interface DependencyProbes {
  which: (command: string, env: Record<string, string | undefined>, cwd: string) => string | null;
  resolveModule: (specifier: string) => string;
}

const probes: DependencyProbes = {
  which: (command, env, cwd) => Bun.which(command, { PATH: env.PATH, cwd }),
  resolveModule: (specifier) => Bun.resolveSync(specifier, import.meta.dir),
};

/** Keep preflight and the app-server on the same override/package fallback. */
export function resolveCodexCommand(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
  dependencies: DependencyProbes = probes,
): string {
  const override = env.CODEX_PATH_OVERRIDE || env.CODEX_BINARY;
  if (override) return override;
  const fromPath = dependencies.which("codex", env, cwd);
  if (fromPath) return fromPath;
  try {
    return dependencies.resolveModule("@openai/codex/bin/codex.js");
  } catch {
    return "codex";
  }
}

/** OpenCode is external in compiled workers; source runs may use node_modules. */
export function resolveOpencodeSdkSpecifier(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.OPENCODE_SDK_PATH) return env.OPENCODE_SDK_PATH;
  for (const root of ["/usr/lib/node_modules", "/usr/local/lib/node_modules"]) {
    const candidate = `${root}/@opencode/sdk/dist/index.js`;
    if (existsSync(candidate)) return candidate;
  }
  return "@opencode/sdk";
}

const acpInstallHints: Record<string, string> = {
  opencode: "Install OpenCode: npm install -g opencode-ai.",
  gemini: "Install Gemini CLI: npm install -g @google/gemini-cli.",
  copilot: "Install GitHub Copilot CLI: npm install -g @github/copilot.",
  qwen: "Install Qwen Code: npm install -g @qwen-code/qwen-code.",
  kiro: "Install Kiro CLI: https://cli.kiro.dev/install.",
  goose: "Install Goose: https://goose-docs.ai/docs/getting-started/installation.",
  custom: "Install the target or set ACP_TARGET_COMMAND to a trusted executable.",
};

/** Runs for every task, including after a live harness/config change. Never spawns a CLI. */
export async function validateProviderDependencies(
  provider: ProviderName,
  config: ProviderSessionConfig,
  dependencies: DependencyProbes = probes,
): Promise<void> {
  const env = config.env ?? process.env;
  const requireExecutable = (command: string, hint: string, pathEnv = env, cwd = config.cwd) => {
    if (!dependencies.which(command, pathEnv, cwd)) {
      throw new Error(
        scrubSecrets(
          `${provider} provider: required executable '${command}' was not found or is not executable. ${hint}`,
        ),
      );
    }
  };

  switch (provider) {
    case "claude": {
      const { resolveClaudeBinaryArgv, withClaudeRouteEnv } = await import("./claude-adapter");
      const sourceEnv = withClaudeRouteEnv(env);
      const { argv, useClaudeBridge } = resolveClaudeBinaryArgv(sourceEnv);
      requireExecutable(
        argv[0]!,
        useClaudeBridge
          ? "Use worker-full or install @desplega.ai/claude-bridge during image provisioning."
          : "Install Claude Code or set CLAUDE_BINARY to a trusted executable on the worker.",
        sourceEnv,
      );
      return;
    }
    case "codex":
      requireExecutable(
        resolveCodexCommand(env, process.cwd(), dependencies),
        "Install @openai/codex or set CODEX_PATH_OVERRIDE (or CODEX_BINARY) to a trusted executable.",
        env,
        process.cwd(),
      );
      return;
    case "dsh":
      requireExecutable(
        env.DSH_BINARY || "dsh",
        "Use worker-full, install @deepseek-ai/dsh@0.2.2-rc.3, or set DSH_BINARY to a trusted executable.",
      );
      return;
    case "amp":
      requireExecutable(
        env.AMP_BINARY || "amp",
        "Use worker-full, install @ampcode/cli, or set AMP_BINARY to a trusted executable.",
      );
      return;
    case "grok":
    case "fx":
    case "acp": {
      const { resolveAcpTarget, grokTargetProfile, fxTargetProfile } = await import(
        "./acp-targets"
      );
      const target =
        provider === "grok"
          ? grokTargetProfile
          : provider === "fx"
            ? fxTargetProfile
            : resolveAcpTarget(config);
      const hint =
        provider === "grok"
          ? "Use worker-full, install @xai-official/grok@1.0.77, or set GROK_BINARY to a trusted executable."
          : provider === "fx"
            ? "Use worker-full, install the pinned fx release (Dockerfile.worker FX_VERSION), or set FX_BINARY."
            : `ACP_TARGET='${target.target}'. ${acpInstallHints[target.target]}`;
      requireExecutable(target.command(config)[0]!, hint, target.env(config));
      return;
    }
    case "opencode": {
      const specifier = resolveOpencodeSdkSpecifier(env);
      try {
        dependencies.resolveModule(specifier);
      } catch {
        throw new Error(
          scrubSecrets(
            `opencode provider: required @opencode/sdk could not be resolved from '${specifier}'. Install it with 'npm install -g @opencode/sdk' or set OPENCODE_SDK_PATH.`,
          ),
        );
      }
      return;
    }
    case "cursor":
      if (env.CURSOR_RIPGREP_PATH) {
        requireExecutable(
          env.CURSOR_RIPGREP_PATH,
          "Set CURSOR_RIPGREP_PATH to an executable ripgrep binary or unset it to use the SDK default.",
        );
      }
      return;
    // Their SDKs are bundled into the worker; they need no external CLI.
    case "pi":
    case "devin":
    case "claude-managed":
      return;
    default: {
      const unsupported: never = provider;
      throw new Error(`No runtime dependency check for provider '${unsupported}'.`);
    }
  }
}
