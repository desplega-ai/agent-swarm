#!/usr/bin/env bun
import "./utils/internal-ai/register-bedrock.ts";

import { Spinner } from "@inkjs/ui";
import { Box, render, Text, useApp } from "ink";
import type { ComponentType } from "react";
import { createElement, useEffect, useState } from "react";
import pkg from "../package.json";
import { getApiKey, setApiKey } from "./utils/api-key.ts";

// Get CLI name from bin field (assumes single key)
const binName = Object.keys(pkg.bin)[0];

// Restore cursor on exit — only when stdout is a TTY.  Non-TTY invocations
// (like the codex-session-runner subprocess whose stdout is a JSON pipe)
// must not inject terminal escape sequences into the byte stream.
const restoreCursor = () => {
  if (process.stdout.isTTY) process.stdout.write("\x1B[?25h");
};
process.on("exit", restoreCursor);
process.on("SIGINT", () => {
  restoreCursor();
  process.exit(0);
});

interface ParsedArgs {
  command: string | undefined;
  port: string;
  key: string;
  msg: string;
  headless: boolean;
  dryRun: boolean;
  restore: boolean;
  yes: boolean;
  yolo: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  additionalArgs: string[];
  preset: string;
  open: boolean;
  showHelp: boolean;
  dbPath: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  let port = process.env.PORT || "3013";
  let key = getApiKey();
  let msg = "";
  let headless = false;
  let dryRun = false;
  let restore = false;
  let yes = false;
  let yolo = false;
  let systemPrompt = "";
  let systemPromptFile = "";
  let additionalArgs: string[] = [];
  let preset = "";
  let open = false;
  let showHelp = false;
  let dbPath = "";

  // Find if there's a "--" separator for additional args
  const separatorIndex = args.indexOf("--");
  const mainArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  additionalArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  for (let i = 0; i < mainArgs.length; i++) {
    const arg = mainArgs[i];
    if (arg === "-p" || arg === "--port") {
      port = mainArgs[i + 1] || port;
      i++;
    } else if (arg === "-k" || arg === "--key") {
      key = mainArgs[i + 1] || key;
      i++;
    } else if (arg === "-m" || arg === "--msg") {
      msg = mainArgs[i + 1] || msg;
      i++;
    } else if (arg === "--headless") {
      headless = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--restore") {
      restore = true;
    } else if (arg === "-y" || arg === "--yes") {
      yes = true;
    } else if (arg === "--yolo") {
      yolo = true;
    } else if (arg === "--system-prompt") {
      systemPrompt = mainArgs[i + 1] || systemPrompt;
      i++;
    } else if (arg === "--system-prompt-file") {
      systemPromptFile = mainArgs[i + 1] || systemPromptFile;
      i++;
    } else if (arg === "--preset") {
      preset = mainArgs[i + 1] || preset;
      i++;
    } else if (arg?.startsWith("--preset=")) {
      preset = arg.slice("--preset=".length);
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--db") {
      dbPath = mainArgs[i + 1] || dbPath;
      i++;
    }
  }

  return {
    command,
    port,
    key,
    msg,
    headless,
    dryRun,
    restore,
    yes,
    yolo,
    systemPrompt,
    systemPromptFile,
    additionalArgs,
    preset,
    open,
    showHelp,
    dbPath,
  };
}

// --- Plain text help (no Ink, no terminal reset) ---

const COMMAND_HELP: Record<
  string,
  { usage: string; description: string; options: string; examples: string }
> = {
  onboard: {
    usage: `${binName} onboard [options]`,
    description:
      "Set up a new swarm from scratch using Docker Compose.\nInteractive wizard that collects credentials, generates docker-compose.yml + .env,\nstarts the stack, and verifies health.",
    options: [
      "  --dry-run              Preview what would be generated without writing",
      "  -y, --yes              Non-interactive mode (reads from env vars)",
      "  --preset <name>        Preset: dev, content, research, solo",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} onboard`,
      `  ${binName} onboard --dry-run`,
      `  ${binName} onboard --yes --preset=dev`,
      `  ANTHROPIC_API_KEY=sk-... ${binName} onboard --yes --preset=solo`,
    ].join("\n"),
  },
  connect: {
    usage: `${binName} connect [options]`,
    description:
      "Connect this project to an existing swarm.\nCreates .mcp.json and .claude/settings.local.json with server URL and API key.\nAuto-reads AGENT_SWARM_API_KEY (or legacy API_KEY) from .env if present.",
    options: [
      "  --dry-run              Show what would be changed without writing",
      "  --restore              Restore files from .bak backups",
      "  -y, --yes              Non-interactive mode (use env vars)",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} connect`,
      `  ${binName} connect --dry-run`,
      `  ${binName} connect -y`,
    ].join("\n"),
  },
  api: {
    usage: `${binName} api [options]`,
    description: "Start the API + MCP HTTP server.",
    options: [
      "  -p, --port <port>      Port to listen on (default: 3013)",
      "  -k, --key <key>        API key for authentication",
      "  --db <path>            Database file path (default: ./agent-swarm-db.sqlite)",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} api`,
      `  ${binName} api --port 8080 --key my-secret`,
      `  ${binName} api --db /data/swarm.sqlite`,
    ].join("\n"),
  },
  claude: {
    usage: `${binName} claude [options] [-- <args...>]`,
    description: "Run Claude CLI with optional message and headless mode.",
    options: [
      "  -m, --msg <message>    Message to send to Claude",
      "  --headless             Run in headless mode (stream JSON output)",
      "  -- <args...>           Additional arguments to pass to Claude CLI",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} claude`,
      `  ${binName} claude --headless -m "Hello"`,
      `  ${binName} claude -- --resume`,
    ].join("\n"),
  },
  worker: {
    usage: `${binName} worker [options] [-- <args...>]`,
    description: "Run Claude in headless loop mode as a worker agent.",
    options: [
      "  -m, --msg <prompt>          Custom prompt (default: /agent-swarm:start-worker)",
      "  --yolo                      Continue on errors instead of stopping",
      "  --system-prompt <text>      Custom system prompt (appended to Claude)",
      "  --system-prompt-file <path> Read system prompt from file",
      "  -- <args...>                Additional arguments to pass to Claude CLI",
      "  -h, --help                  Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} worker`,
      `  ${binName} worker --yolo`,
      `  ${binName} worker -m "Custom prompt"`,
      `  ${binName} worker --system-prompt "You are a Python specialist"`,
    ].join("\n"),
  },
  lead: {
    usage: `${binName} lead [options] [-- <args...>]`,
    description: "Run Claude as lead agent in headless loop mode.\nSame options as worker.",
    options: [
      "  -m, --msg <prompt>          Custom prompt",
      "  --yolo                      Continue on errors instead of stopping",
      "  --system-prompt <text>      Custom system prompt",
      "  --system-prompt-file <path> Read system prompt from file",
      "  -- <args...>                Additional arguments to pass to Claude CLI",
      "  -h, --help                  Show this help",
    ].join("\n"),
    examples: [`  ${binName} lead`, `  ${binName} lead --yolo`].join("\n"),
  },
  docs: {
    usage: `${binName} docs [--open]`,
    description:
      "Show documentation URL.\nAll pages are also available in markdown format by appending .md to the URL.",
    options: [
      "  --open                 Open docs in default browser",
      "  -h, --help             Show this help",
    ].join("\n"),
    examples: [`  ${binName} docs`, `  ${binName} docs --open`].join("\n"),
  },
  hook: {
    usage: `${binName} hook`,
    description:
      "Handle Claude Code hook events from stdin.\nUsed internally by the agent-swarm hooks system.",
    options: "  -h, --help             Show this help",
    examples: `  ${binName} hook`,
  },
  artifact: {
    usage: `${binName} artifact <subcommand> [options]`,
    description: "Manage agent artifacts (serve, list, etc.).",
    options: "  -h, --help             Show this help",
    examples: [`  ${binName} artifact serve`, `  ${binName} artifact help`].join("\n"),
  },
  x: {
    usage: `${binName} x <target> [args]`,
    description:
      "Execute external command routes. Prototype target: composio routes HTTP requests to the Composio REST API using COMPOSIO_API_KEY.",
    options: [
      "  composio <method> <path>       Route to the Composio REST API",
      "  -h, --help                     Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} x composio GET /tools`,
      `  ${binName} x composio POST /tools/execute/GITHUB_CREATE_AN_ISSUE --body '{"arguments":{}}'`,
    ].join("\n"),
  },
  scripts: {
    usage: `${binName} scripts reembed`,
    description: "Maintenance commands for reusable swarm scripts.",
    options: "  -h, --help             Show this help",
    examples: `  ${binName} scripts reembed`,
  },
  rbac: {
    usage: `${binName} rbac bootstrap`,
    description:
      "RBAC role management.\nBootstraps built-in RBAC roles and attaches the default role to users with zero roles.",
    options: "  -h, --help             Show this help",
    examples: `  ${binName} rbac bootstrap`,
  },
  "codex-login": {
    usage: `${binName} codex-login [options]`,
    description:
      "Authenticate Codex via ChatGPT OAuth (browser or manual paste).\nPrompts interactively for the target API URL and a best-effort masked API key, then stores credentials in the swarm API config store for deployed workers.",
    options: [
      "  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)",
      "  --api-key <key>    Swarm API key (default: AGENT_SWARM_API_KEY or API_KEY, falling back to 123123)",
      "  -h, --help         Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} codex-login`,
      `  ${binName} codex-login --api-url https://swarm.example.com`,
      `  ${binName} codex-login --api-url https://swarm.example.com --api-key <api-key>`,
    ].join("\n"),
  },
  "claude-managed-setup": {
    usage: `${binName} claude-managed-setup [options]`,
    description:
      "Bootstrap Anthropic Managed Agents for the swarm: create the cloud environment, upload plugin/commands/*.md skills, create the managed agent, and persist the resulting IDs to swarm_config so deployed workers restore them at boot. Prompts interactively for ANTHROPIC_API_KEY when not set in env. Idempotent — re-run with --force to recreate.",
    options: [
      "  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)",
      "  --api-key <key>    Swarm API key (default: AGENT_SWARM_API_KEY or API_KEY, falling back to 123123)",
      "  --force            Recreate Anthropic-side resources even if already configured",
      "  -h, --help         Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} claude-managed-setup`,
      `  ${binName} claude-managed-setup --force`,
      `  ${binName} claude-managed-setup --api-url https://swarm.example.com`,
    ].join("\n"),
  },
  e2b: {
    usage: `${binName} e2b <subcommand> [options]`,
    description:
      "Build Agent Swarm E2B templates and start API/worker sandboxes on demand for CI or Dockerless environments.",
    options: [
      "  build-template --role api|worker    Build or rebuild an E2B template",
      "  delete-template <template...>        Delete E2B templates",
      "  publish-template <template...>       Publish E2B templates",
      "  unpublish-template <template...>     Make E2B templates private",
      "  start-api --template <name>          Start the API in an E2B sandbox",
      "  start-worker --api-url <url>         Start a worker against a public API URL",
      "  start-stack                          Start API + lead + N workers (wizard on a TTY)",
      "  list                                 List dispatcher sandboxes",
      "  swarms list|info|kill|add|logs       Group/inspect/teardown/grow/tail swarms by slug",
      "  extend <sandbox-id...>               Extend a sandbox TTL (--timeout-sec <s>)",
      "  kill <sandbox-id...> | --all         Clean up sandboxes (--all sweeps the fleet)",
      "",
      "  swarms options:",
      "  swarms list                          Group sandboxes by metadata.swarm slug",
      "  swarms info <slug>                   API URL, key source (masked), roles, TTL, health",
      "  swarms kill <slug> | --all           Tear down a swarm (API last), or every swarm",
      "  swarms add <slug> [--workers <n>]    Add worker(s)/--add-lead to an existing swarm",
      "  swarms logs <slug> [--role r]        Stream a sandbox entrypoint log (--follow to tail)",
      "  --reveal-key                         Embed the swarm key in the dashboard deep-link (raw)",
      "",
      "  start-stack options:",
      "  --swarm <slug>                       Swarm name/slug (wizard + echoed one-shot command)",
      "  --workers <n>                        Worker count (default 1)",
      "  --no-lead                            Legacy topology: API + N workers, no lead",
      "  --lead-agent-id <id>                 Lead agent ID (default e2b-lead-<sandbox-id>)",
      "  --yes / --non-interactive            Skip the wizard; use flags + defaults (headless)",
      "  --integrations <csv>                 Allowlist of integrations to keep on",
      "  --no-slack|github|jira|linear        Disable an integration (sets API <NAME>_DISABLE)",
      "",
      "  --provider <name>                    Harness provider for workers (default claude)",
      "  --timeout-sec <s>                    Sandbox TTL (default 3600)",
      "  --env-file / --secret                Shared env/secrets applied to all roles (repeatable)",
      "  --<api|lead|worker>-env-file <path>  Role-scoped env file, layers on the shared one (repeatable)",
      "  --<api|lead|worker>-secret KEY=VAL   Role-scoped secret, layers on the shared one (repeatable)",
      "  --json                               Machine-readable output",
      "  --dry-run                            Derive planned work without touching E2B",
      "  -h, --help                           Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} e2b build-template --role worker`,
      `  ${binName} e2b start-worker --api-url https://swarm.example.com --api-key "$SWARM_API_KEY"`,
      `  ${binName} e2b start-stack --yes --swarm demo --workers 2 --api-key "$SWARM_API_KEY"`,
      `  ${binName} e2b start-stack --yes --no-lead --workers 2 --swarm demo`,
    ].join("\n"),
  },
};

function printHelp(command?: string) {
  if (command && command !== "help" && COMMAND_HELP[command]) {
    const cmd = COMMAND_HELP[command];
    console.log(`\n${binName} ${command} — v${pkg.version}\n`);
    console.log(cmd.description);
    console.log(`\nUsage:\n  ${cmd.usage}\n`);
    console.log(`Options:\n${cmd.options}\n`);
    console.log(`Examples:\n${cmd.examples}\n`);
    return;
  }

  // General help
  console.log(`\n${binName} v${pkg.version}`);
  console.log(`${pkg.description}\n`);
  console.log(`Usage: ${binName} <command> [options]\n`);
  console.log("Commands:");
  const commands = [
    ["onboard", "Set up a new swarm from scratch (Docker Compose)"],
    ["connect", "Connect this project to an existing swarm"],
    ["worker", "Run Claude in headless loop mode"],
    ["lead", "Run Claude as lead agent in headless loop"],
    ["api", "Start the API + MCP HTTP server"],
    ["claude", "Run Claude CLI"],
    ["hook", "Handle Claude Code hook events (stdin)"],
    ["artifact", "Manage agent artifacts"],
    ["x", "Execute external command routes"],
    ["scripts", "Reusable scripts maintenance"],
    ["rbac", "RBAC role management (bootstrap)"],
    ["docs", "Open documentation (--open to launch in browser)"],
    ["codex-login", "Authenticate Codex via ChatGPT OAuth"],
    ["claude-managed-setup", "Bootstrap Anthropic Managed Agents (agent + env + skills)"],
    ["e2b", "Build templates and start E2B API/worker sandboxes"],
    ["version", "Show version number"],
    ["help", "Show this help message"],
  ];
  for (const entry of commands) {
    console.log(`  ${(entry[0] ?? "").padEnd(22)} ${entry[1] ?? ""}`);
  }
  console.log(`\nRun '${binName} <command> --help' for details on a specific command.\n`);
}

function McpServer({ port, apiKey, dbPath }: { port: string; apiKey: string; dbPath: string }) {
  const [status, setStatus] = useState<"starting" | "running" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    process.env.PORT = port;
    setApiKey(apiKey);
    if (dbPath) {
      process.env.DATABASE_PATH = dbPath;
    }

    import("./http.ts")
      .then(() => {
        setStatus("running");
      })
      .catch((err) => {
        setStatus("error");
        setError(err.message);
      });
  }, [port, apiKey, dbPath]);

  if (status === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">✗ Failed to start API server</Text>
        {error && <Text dimColor>{error}</Text>}
      </Box>
    );
  }

  if (status === "starting") {
    return (
      <Box padding={1}>
        <Spinner label="Starting API server..." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color="green">✓ </Text>
        <Text>API server running on </Text>
        <Text color="cyan" bold>
          http://localhost:{port}/mcp
        </Text>
      </Box>
      {apiKey && <Text dimColor>API key authentication enabled</Text>}
      <Text dimColor>Press Ctrl+C to stop</Text>
    </Box>
  );
}

interface ClaudeRunnerProps {
  msg: string;
  headless: boolean;
  additionalArgs: string[];
}

function ClaudeRunner({ msg, headless, additionalArgs }: ClaudeRunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    import("./claude.ts")
      .then(({ runClaude }) =>
        runClaude({
          msg,
          headless,
          additionalArgs,
        }),
      )
      .then(() => exit())
      .catch((err) => exit(err));
  }, [msg, headless, additionalArgs, exit]);

  return null;
}

interface RunnerProps {
  prompt: string;
  yolo: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  additionalArgs: string[];
}

function WorkerRunner({
  prompt,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
}: RunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    import("./commands/worker.ts")
      .then(({ runWorker }) =>
        runWorker({
          prompt: prompt || undefined,
          yolo,
          systemPrompt: systemPrompt || undefined,
          systemPromptFile: systemPromptFile || undefined,
          additionalArgs,
          logsDir: "./logs",
        }),
      )
      .catch((err) => {
        console.error("[error] Worker encountered an error:", err);
        exit(err);
      });
    // Note: runWorker runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, exit]);

  return null;
}

function LeadRunner({ prompt, yolo, systemPrompt, systemPromptFile, additionalArgs }: RunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    import("./commands/lead.ts")
      .then(({ runLead }) =>
        runLead({
          prompt: prompt || undefined,
          yolo,
          systemPrompt: systemPrompt || undefined,
          systemPromptFile: systemPromptFile || undefined,
          additionalArgs,
          logsDir: "./logs",
        }),
      )
      .catch((err) => {
        console.error("[error] Lead encountered an error:", err);
        exit(err);
      });
    // Note: runLead runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, exit]);

  return null;
}

function LazyComponent<TProps extends object>({
  load,
  props,
}: {
  load: () => Promise<ComponentType<TProps>>;
  props: TProps;
}) {
  const { exit } = useApp();
  const [Component, setComponent] = useState<ComponentType<TProps> | null>(null);

  useEffect(() => {
    let cancelled = false;

    load()
      .then((loaded) => {
        if (!cancelled) setComponent(() => loaded);
      })
      .catch((err) => exit(err));

    return () => {
      cancelled = true;
    };
  }, [load, exit]);

  if (!Component) {
    return (
      <Box padding={1}>
        <Spinner label="Loading..." />
      </Box>
    );
  }

  return createElement(Component, props);
}

const loadOnboard = () => import("./commands/onboard.tsx").then(({ Onboard }) => Onboard);
const loadConnect = () => import("./commands/setup.tsx").then(({ Setup }) => Setup);

function UnknownCommand({ command }: { command: string }) {
  const { exit } = useApp();
  useEffect(() => {
    exit(new Error(`Unknown command: ${command}`));
  }, [exit, command]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">Unknown command: {command}</Text>
      <Text dimColor>Run '{binName} help' for usage information</Text>
    </Box>
  );
}

function App({ args }: { args: ParsedArgs }) {
  const {
    command,
    port,
    key,
    msg,
    headless,
    dryRun,
    restore,
    yes,
    yolo,
    systemPrompt,
    systemPromptFile,
    additionalArgs,
    preset,
  } = args;

  switch (command) {
    case "onboard":
      return (
        <LazyComponent load={loadOnboard} props={{ dryRun, yes, preset: preset || undefined }} />
      );
    case "connect":
      return <LazyComponent load={loadConnect} props={{ dryRun, restore, yes }} />;
    case "api":
      return <McpServer port={port} apiKey={key} dbPath={args.dbPath} />;
    case "claude":
      return <ClaudeRunner msg={msg} headless={headless} additionalArgs={additionalArgs} />;
    case "worker":
      return (
        <WorkerRunner
          prompt={msg}
          yolo={yolo}
          systemPrompt={systemPrompt}
          systemPromptFile={systemPromptFile}
          additionalArgs={additionalArgs}
        />
      );
    case "lead":
      return (
        <LeadRunner
          prompt={msg}
          yolo={yolo}
          systemPrompt={systemPrompt}
          systemPromptFile={systemPromptFile}
          additionalArgs={additionalArgs}
        />
      );
    // version, help, docs handled before render()
    default:
      return <UnknownCommand command={command ?? ""} />;
  }
}

const args = parseArgs(process.argv.slice(2));

// Handle non-UI commands separately (plain stdout, no Ink)
if (args.showHelp || args.command === "help" || args.command === undefined) {
  printHelp(args.showHelp ? args.command : undefined);
  process.exit(0);
} else if (args.command === "version") {
  console.log(`${binName} v${pkg.version}`);
  process.exit(0);
} else if (args.command === "docs") {
  const docsUrl = "https://docs.agent-swarm.dev";
  console.log(`\n${binName} docs — v${pkg.version}\n`);
  console.log(`Documentation: ${docsUrl}\n`);
  console.log("All pages are also available in markdown format by appending .md to the URL.");
  console.log(`Example: ${docsUrl}/getting-started.md\n`);
  if (args.open) {
    await Bun.$`open ${docsUrl}`.quiet().catch(() => {
      console.log(`Could not open browser. Visit: ${docsUrl}`);
    });
  }
  process.exit(0);
} else if (args.command === "hook") {
  const { runHook } = await import("./commands/hook.ts");
  await runHook();
} else if (args.command === "artifact") {
  // Pass all args after "artifact" directly
  const artifactArgs = process.argv.slice(process.argv.indexOf("artifact") + 1);
  const { runArtifact } = await import("./commands/artifact");
  await runArtifact(artifactArgs[0] || "help", {
    additionalArgs: artifactArgs.slice(1),
    port: args.port,
    key: args.key,
  });
} else if (args.command === "x") {
  const xArgs = process.argv.slice(process.argv.indexOf("x") + 1);
  const { runXCommand } = await import("./commands/x");
  await runXCommand(xArgs);
} else if (args.command === "scripts") {
  const scriptsArgs = process.argv.slice(process.argv.indexOf("scripts") + 1);
  if (args.showHelp || scriptsArgs[0] !== "reembed") {
    printHelp("scripts");
    process.exit(scriptsArgs[0] === "reembed" || args.showHelp ? 0 : 1);
  }
  const { runScriptsMaintenanceCommand } = await import("./be/scripts/maintenance");
  await runScriptsMaintenanceCommand(scriptsArgs);
  console.log("Scripts re-embedded.");
} else if (args.command === "rbac") {
  const rbacArgs = process.argv.slice(process.argv.indexOf("rbac") + 1);
  const isValidRbacCommand = rbacArgs.length === 1 && rbacArgs[0] === "bootstrap";
  if (args.showHelp || !isValidRbacCommand) {
    printHelp("rbac");
    process.exit(args.showHelp ? 0 : 1);
  }
  const { runRbacCliCommand } = await import("./be/rbac-roles");
  await runRbacCliCommand(rbacArgs);
} else if (args.command === "codex-login") {
  const { runCodexLogin } = await import("./commands/codex-login");
  const codexLoginArgs = process.argv.slice(process.argv.indexOf("codex-login") + 1);
  await runCodexLogin(codexLoginArgs);
} else if (args.command === "codex-session-runner") {
  // Internal subcommand — invoked by CodexSubprocessSession to host a single
  // codex session in a throwaway subprocess. See src/commands/codex-session-runner.ts
  // for the rationale (Picateclas spawn-OOM permanent fix, 2026-05-28).
  const { runCodexSessionRunner } = await import("./commands/codex-session-runner");
  await runCodexSessionRunner();
} else if (args.command === "claude-managed-setup") {
  const { runClaudeManagedSetup } = await import("./commands/claude-managed-setup");
  const setupArgs = process.argv.slice(process.argv.indexOf("claude-managed-setup") + 1);
  await runClaudeManagedSetup(setupArgs);
} else if (args.command === "e2b") {
  const { runE2BCommand } = await import("./commands/e2b");
  const e2bArgs = process.argv.slice(process.argv.indexOf("e2b") + 1);
  await runE2BCommand(e2bArgs);
} else {
  render(<App args={args} />);
}
