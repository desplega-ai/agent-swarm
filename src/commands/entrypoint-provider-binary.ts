import { access, constants } from "node:fs/promises";

/** Standalone worker boot step: no adapter imports or installed npm packages. */
export interface ProviderBinaryDependencies {
  which: (command: string, path: string | undefined) => string | null;
  isFile: (path: string) => Promise<boolean>;
  isExecutable: (path: string) => Promise<boolean>;
  version: (command: string, env: Record<string, string | undefined>) => Promise<string>;
  log: (message: string) => void;
}

const defaults: ProviderBinaryDependencies = {
  which: (command, path) => Bun.which(command, { PATH: path }),
  isFile: async (path) => {
    try {
      return (await Bun.file(path).stat()).isFile();
    } catch {
      return false;
    }
  },
  isExecutable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  version: async (command, env) => {
    // Like the old echo "$(... --version)": version failure is informational.
    const proc = Bun.spawn([command, "--version"], { env, stdout: "pipe", stderr: "ignore" });
    const [output] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return output.replace(/\n+$/, "");
  },
  log: (message) => console.log(message),
};

const cliProviders: Record<string, { variable: string; label: string; hint: string }> = {
  codex: { variable: "CODEX_BINARY", label: "Codex", hint: "" },
  dsh: {
    variable: "DSH_BINARY",
    label: "dsh",
    hint: ". Use worker-full or install @deepseek-ai/dsh@0.2.2-rc.1 during image provisioning.",
  },
  amp: {
    variable: "AMP_BINARY",
    label: "amp",
    hint: ". Use worker-full or install @ampcode/cli during image provisioning.",
  },
  grok: {
    variable: "GROK_BINARY",
    label: "grok",
    hint: ". Use worker-full or install @xai-official/grok@1.0.77 during image provisioning.",
  },
  fx: {
    variable: "FX_BINARY",
    label: "fx",
    hint: ". Use worker-full, or install the pinned fx release binary (Dockerfile.worker FX_VERSION) during image provisioning.",
  },
};

// Keep these executable names aligned with acp-target-catalog.ts. Importing
// adapters here would require their SDKs before worker setup has run.
const acpTargets: Record<string, { command: string; hint?: string }> = {
  opencode: { command: "opencode" },
  gemini: { command: "gemini" },
  copilot: {
    command: "copilot",
    hint: ". Install GitHub Copilot CLI: npm install -g @github/copilot",
  },
  qwen: { command: "qwen", hint: ". Install it: npm install -g @qwen-code/qwen-code" },
  kiro: {
    command: "kiro-cli",
    hint: ". Install it: curl -fsSL https://cli.kiro.dev/install | bash",
  },
  goose: {
    command: "goose",
    hint: ". Install it: see https://goose-docs.ai/docs/getting-started/installation",
  },
};

export async function verifyProviderBinary(
  provider: string,
  env: Record<string, string | undefined> = process.env,
  dependencies: Partial<ProviderBinaryDependencies> = {},
): Promise<boolean> {
  const { which, isFile, isExecutable, version, log } = { ...defaults, ...dependencies };
  const fatal = (message: string, showPath = false) => {
    log(`FATAL: ${message}`);
    if (showPath) log(`  PATH=${env.PATH ?? ""}`);
    return false;
  };

  const cli = Object.hasOwn(cliProviders, provider) ? cliProviders[provider] : undefined;
  if (cli) {
    const command = env[cli.variable] || provider;
    const resolved = which(command, env.PATH);
    if (!resolved)
      return fatal(`${cli.label} CLI not found: '${command}'${cli.hint}`, provider === "codex");
    let suffix = "";
    if (provider === "grok" || provider === "fx") {
      const flag =
        provider === "grok" ? { GROK_DISABLE_AUTOUPDATER: "1" } : { FX_AUTO_UPGRADE: "0" };
      let output = "";
      try {
        output = await version(resolved, { ...env, ...flag });
      } catch {
        // A failed version display never prevented boot in the shell step.
      }
      suffix = ` (${output})`;
    }
    log(`${cli.label} CLI: ${resolved}${suffix}`);
    return true;
  }
  if (provider === "claude-managed") {
    log("Claude Managed Agents: no local CLI required (sessions run in Anthropic cloud)");
    return true;
  }
  if (provider === "devin") {
    log("Devin: cloud API (no local binary required)");
    return true;
  }
  if (provider === "pi") return true;
  if (provider === "cursor") {
    if (env.CURSOR_RIPGREP_PATH && !(await isExecutable(env.CURSOR_RIPGREP_PATH))) {
      return fatal(`CURSOR_RIPGREP_PATH is not executable: '${env.CURSOR_RIPGREP_PATH}'`);
    }
    log("Cursor SDK: in-process (no CLI binary required)");
    return true;
  }
  if (provider === "opencode") {
    let entry = env.OPENCODE_SDK_PATH || "";
    if (!entry) {
      for (const root of ["/usr/lib/node_modules", "/usr/local/lib/node_modules"]) {
        const candidate = `${root}/@opencode/sdk/dist/index.js`;
        if (await isFile(candidate)) {
          entry = candidate;
          break;
        }
      }
    }
    if (!entry || !(await isFile(entry))) {
      return fatal(
        "@opencode/sdk not found. Install it with 'npm install -g @opencode/sdk' or set OPENCODE_SDK_PATH.",
      );
    }
    log(`OpenCode SDK: ${entry}`);
    return true;
  }
  if (provider === "acp") {
    const target = env.ACP_TARGET ?? "custom";
    const preset = Object.hasOwn(acpTargets, target) ? acpTargets[target] : undefined;
    let command: string;
    if (preset) {
      command = preset.command;
    } else if (target === "custom") {
      const raw = env.ACP_TARGET_COMMAND ?? env.ACP_COMMAND;
      if (raw === undefined) {
        return fatal(
          "no ACP target configured. Set ACP_TARGET_COMMAND to an ACP-compatible executable before using HARNESS_PROVIDER=acp.",
          true,
        );
      }
      command = raw.trim();
      if (!command) {
        return fatal(
          "ACP target command is empty. Set ACP_TARGET_COMMAND to an ACP-compatible executable.",
          true,
        );
      }
      // Match parseCommand: explicit nonblank args preserve a spaced executable.
      if (!env.ACP_TARGET_ARGS?.trim()) command = command.split(/\s+/)[0]!;
    } else {
      return fatal(
        `unsupported ACP target '${target}'. Supported targets: opencode, gemini, copilot, qwen, kiro, goose, custom.`,
        true,
      );
    }
    const resolved = which(command, env.PATH);
    if (!resolved) {
      return fatal(
        `ACP target binary not found: '${command}' (ACP_TARGET='${target}')${preset?.hint ?? ""}`,
        true,
      );
    }
    log(`ACP target: ${resolved} (ACP_TARGET='${target}')`);
    return true;
  }

  // Preserve the shell's Claude fallback, including command strings with argv.
  const raw = env.CLAUDE_BINARY || "claude";
  const command = raw.trim().split(/\s+/)[0]!;
  const resolved = which(command, env.PATH);
  if (!resolved) {
    fatal(`Claude CLI not found: '${command}' (from CLAUDE_BINARY='${raw}')`, true);
    for (const path of ["/usr/local/bin/claude", "/usr/bin/claude"]) {
      if (await isFile(path)) log(`  Found at ${path} (not in PATH) — set CLAUDE_BINARY=${path}`);
    }
    return false;
  }
  log(`Claude CLI: ${resolved} (CLAUDE_BINARY='${raw}')`);
  return true;
}

if (import.meta.main) {
  process.exitCode = (await verifyProviderBinary(Bun.argv[2] || "claude")) ? 0 : 1;
}
