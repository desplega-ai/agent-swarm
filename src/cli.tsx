#!/usr/bin/env bun
import { Spinner } from "@inkjs/ui";
import { Box, render, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import pkg from "../package.json";
import { runClaude } from "./claude.ts";
import { runHook } from "./commands/hook.ts";
import { runLead } from "./commands/lead.ts";
import { Onboard } from "./commands/onboard.tsx";
import { Setup as Connect } from "./commands/setup.tsx";
import { runWorker } from "./commands/worker.ts";

// Get CLI name from bin field (assumes single key)
const binName = Object.keys(pkg.bin)[0];

// Restore cursor on exit
const restoreCursor = () => process.stdout.write("\x1B[?25h");
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
  aiLoop: boolean;
  preset: string;
  open: boolean;
  showHelp: boolean;
  dbPath: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  let port = process.env.PORT || "3013";
  let key = process.env.API_KEY || "";
  let msg = "";
  let headless = false;
  let dryRun = false;
  let restore = false;
  let yes = false;
  let yolo = false;
  let systemPrompt = "";
  let systemPromptFile = "";
  let additionalArgs: string[] = [];
  let aiLoop = false;
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
    } else if (arg === "--ai-loop") {
      aiLoop = true;
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
    aiLoop,
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
      "Connect this project to an existing swarm.\nCreates .mcp.json and .claude/settings.local.json with server URL and API key.\nAuto-reads API_KEY from .env if present.",
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
      "  --ai-loop                   Use AI-based polling (legacy mode)",
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
      "  --ai-loop                   Use AI-based polling (legacy mode)",
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
  "codex-login": {
    usage: `${binName} codex-login [options]`,
    description:
      "Authenticate Codex via ChatGPT OAuth (browser or manual paste).\nPrompts interactively for the target API URL and a best-effort masked API key, then stores credentials in the swarm API config store for deployed workers.",
    options: [
      "  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)",
      "  --api-key <key>    Swarm API key (default: API_KEY or 123123)",
      "  -h, --help         Show this help",
    ].join("\n"),
    examples: [
      `  ${binName} codex-login`,
      `  ${binName} codex-login --api-url https://swarm.example.com`,
      `  ${binName} codex-login --api-url https://swarm.example.com --api-key <api-key>`,
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
    ["docs", "Open documentation (--open to launch in browser)"],
    ["codex-login", "Authenticate Codex via ChatGPT OAuth"],
    ["version", "Show version number"],
    ["help", "Show this help message"],
  ];
  for (const entry of commands) {
    console.log(`  ${(entry[0] ?? "").padEnd(12)} ${entry[1] ?? ""}`);
  }
  console.log(`\nRun '${binName} <command> --help' for details on a specific command.\n`);
}

function McpServer({ port, apiKey, dbPath }: { port: string; apiKey: string; dbPath: string }) {
  const [status, setStatus] = useState<"starting" | "running" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    process.env.PORT = port;
    process.env.API_KEY = apiKey;
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
    runClaude({
      msg,
      headless,
      additionalArgs,
    })
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
  aiLoop: boolean;
}

function WorkerRunner({
  prompt,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
  aiLoop,
}: RunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    runWorker({
      prompt: prompt || undefined,
      yolo,
      systemPrompt: systemPrompt || undefined,
      systemPromptFile: systemPromptFile || undefined,
      additionalArgs,
      logsDir: "./logs",
      aiLoop,
    }).catch((err) => {
      console.error("[error] Worker encountered an error:", err);
      exit(err);
    });
    // Note: runWorker runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, aiLoop, exit]);

  return null;
}

function LeadRunner({
  prompt,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
  aiLoop,
}: RunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    runLead({
      prompt: prompt || undefined,
      yolo,
      systemPrompt: systemPrompt || undefined,
      systemPromptFile: systemPromptFile || undefined,
      additionalArgs,
      logsDir: "./logs",
      aiLoop,
    }).catch((err) => {
      console.error("[error] Lead encountered an error:", err);
      exit(err);
    });
    // Note: runLead runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, aiLoop, exit]);

  return null;
}

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
    aiLoop,
    preset,
  } = args;

  switch (command) {
    case "onboard":
      return <Onboard dryRun={dryRun} yes={yes} preset={preset || undefined} />;
    case "connect":
      return <Connect dryRun={dryRun} restore={restore} yes={yes} />;
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
          aiLoop={aiLoop}
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
          aiLoop={aiLoop}
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
  runHook();
} else if (args.command === "artifact") {
  // Pass all args after "artifact" directly
  const artifactArgs = process.argv.slice(process.argv.indexOf("artifact") + 1);
  const { runArtifact } = await import("./commands/artifact");
  await runArtifact(artifactArgs[0] || "help", {
    additionalArgs: artifactArgs.slice(1),
    port: args.port,
    key: args.key,
  });
} else if (args.command === "codex-login") {
  const { runCodexLogin } = await import("./commands/codex-login");
  const codexLoginArgs = process.argv.slice(process.argv.indexOf("codex-login") + 1);
  await runCodexLogin(codexLoginArgs);
} else {
  render(<App args={args} />);
}
