#!/usr/bin/env bun
import { Spinner } from "@inkjs/ui";
import { Box, render, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import pkg from "../package.json";
import { runClaude } from "./claude.ts";
import { runHook } from "./commands/hook.ts";
import { runLead } from "./commands/lead.ts";
import { Setup } from "./commands/setup.tsx";
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
  };
}

function Help() {
  const { exit } = useApp();
  useEffect(() => {
    exit();
  }, [exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text bold color="cyan">
          {binName}
        </Text>
        <Text dimColor> v{pkg.version}</Text>
      </Box>
      <Text dimColor>{pkg.description}</Text>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Usage:</Text>
        <Text>
          {" "}
          {binName} {"<command>"} [options]
        </Text>
        <Text dimColor>
          {" "}
          or: bunx {binName} {"<command>"} [options]
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Commands:</Text>
        <Box>
          <Box width={12}>
            <Text color="green">setup</Text>
          </Box>
          <Text>Set up agent-swarm in your project</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">hook</Text>
          </Box>
          <Text>Handle Claude Code hook events (stdin)</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">mcp</Text>
          </Box>
          <Text>Start the MCP HTTP server</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">claude</Text>
          </Box>
          <Text>Run Claude CLI</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">worker</Text>
          </Box>
          <Text>Run Claude in headless loop mode</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">lead</Text>
          </Box>
          <Text>Run Claude as lead agent in headless loop</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">version</Text>
          </Box>
          <Text>Show version number</Text>
        </Box>
        <Box>
          <Box width={12}>
            <Text color="green">help</Text>
          </Box>
          <Text>Show this help message</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Options for 'setup':</Text>
        <Box>
          <Box width={24}>
            <Text color="yellow">--dry-run</Text>
          </Box>
          <Text>Show what would be changed without writing</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="yellow">--restore</Text>
          </Box>
          <Text>Restore files from .bak backups</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="yellow">-y, --yes</Text>
          </Box>
          <Text>Non-interactive mode (use env vars)</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Options for 'mcp':</Text>
        <Box>
          <Box width={24}>
            <Text color="yellow">-p, --port {"<port>"}</Text>
          </Box>
          <Text>Port to listen on (default: 3013)</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="yellow">-k, --key {"<key>"}</Text>
          </Box>
          <Text>API key for authentication</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Options for 'claude':</Text>
        <Box>
          <Box width={24}>
            <Text color="yellow">-m, --msg {"<message>"}</Text>
          </Box>
          <Text>Message to send to Claude</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="yellow">--headless</Text>
          </Box>
          <Text>Run in headless mode (stream JSON output)</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="yellow">-- {"<args...>"}</Text>
          </Box>
          <Text>Additional arguments to pass to Claude CLI</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Options for 'worker':</Text>
        <Box>
          <Box width={30}>
            <Text color="yellow">-m, --msg {"<prompt>"}</Text>
          </Box>
          <Text>Custom prompt (default: /agent-swarm:start-worker)</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--yolo</Text>
          </Box>
          <Text>Continue on errors instead of stopping</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--system-prompt {"<text>"}</Text>
          </Box>
          <Text>Custom system prompt (appended to Claude)</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--system-prompt-file {"<path>"}</Text>
          </Box>
          <Text>Read system prompt from file</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">-- {"<args...>"}</Text>
          </Box>
          <Text>Additional arguments to pass to Claude CLI</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Options for 'lead':</Text>
        <Box>
          <Box width={30}>
            <Text color="yellow">-m, --msg {"<prompt>"}</Text>
          </Box>
          <Text>Custom prompt (default: /setup-leader)</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--yolo</Text>
          </Box>
          <Text>Continue on errors instead of stopping</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--system-prompt {"<text>"}</Text>
          </Box>
          <Text>Custom system prompt (appended to Claude)</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">--system-prompt-file {"<path>"}</Text>
          </Box>
          <Text>Read system prompt from file</Text>
        </Box>
        <Box>
          <Box width={30}>
            <Text color="yellow">-- {"<args...>"}</Text>
          </Box>
          <Text>Additional arguments to pass to Claude CLI</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Examples:</Text>
        <Text dimColor> {binName} setup</Text>
        <Text dimColor> {binName} setup --dry-run</Text>
        <Text dimColor> {binName} setup -y</Text>
        <Text dimColor> {binName} mcp</Text>
        <Text dimColor> {binName} mcp --port 8080</Text>
        <Text dimColor> {binName} mcp -p 8080 -k my-secret-key</Text>
        <Text dimColor> {binName} claude</Text>
        <Text dimColor> {binName} claude --headless -m "Hello"</Text>
        <Text dimColor> {binName} claude -- --resume</Text>
        <Text dimColor> {binName} worker</Text>
        <Text dimColor> {binName} worker --yolo</Text>
        <Text dimColor> {binName} worker -m "Custom prompt"</Text>
        <Text dimColor> {binName} worker --system-prompt "You are a Python specialist"</Text>
        <Text dimColor> {binName} worker --system-prompt-file ./prompts/specialist.txt</Text>
        <Text dimColor> {binName} lead</Text>
        <Text dimColor> {binName} lead --yolo</Text>
        <Text dimColor> {binName} lead -m "Custom prompt"</Text>
        <Text dimColor> {binName} lead --system-prompt "You are a project coordinator"</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Environment variables:</Text>
        <Box>
          <Box width={24}>
            <Text color="magenta">PORT</Text>
          </Box>
          <Text>Default port for the MCP server</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">API_KEY</Text>
          </Box>
          <Text>API key for authentication (Bearer token)</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">MCP_BASE_URL</Text>
          </Box>
          <Text>Base URL for the MCP server (used by setup)</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">AGENT_ID</Text>
          </Box>
          <Text>UUID for agent identification</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">SESSION_ID</Text>
          </Box>
          <Text>Folder name for worker logs (auto-generated)</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">WORKER_YOLO</Text>
          </Box>
          <Text>If "true", worker continues on errors</Text>
        </Box>
        <Box>
          <Box width={24}>
            <Text color="magenta">LEAD_YOLO</Text>
          </Box>
          <Text>If "true", lead continues on errors</Text>
        </Box>
        <Box>
          <Box width={32}>
            <Text color="magenta">LEAD_LOG_DIR</Text>
          </Box>
          <Text>Directory for lead agent logs</Text>
        </Box>
        <Box>
          <Box width={32}>
            <Text color="magenta">WORKER_SYSTEM_PROMPT</Text>
          </Box>
          <Text>Custom system prompt for worker</Text>
        </Box>
        <Box>
          <Box width={32}>
            <Text color="magenta">WORKER_SYSTEM_PROMPT_FILE</Text>
          </Box>
          <Text>Path to system prompt file for worker</Text>
        </Box>
        <Box>
          <Box width={32}>
            <Text color="magenta">LEAD_SYSTEM_PROMPT</Text>
          </Box>
          <Text>Custom system prompt for lead</Text>
        </Box>
        <Box>
          <Box width={32}>
            <Text color="magenta">LEAD_SYSTEM_PROMPT_FILE</Text>
          </Box>
          <Text>Path to system prompt file for lead</Text>
        </Box>
      </Box>
    </Box>
  );
}

function McpServer({ port, apiKey }: { port: string; apiKey: string }) {
  const [status, setStatus] = useState<"starting" | "running" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    process.env.PORT = port;
    process.env.API_KEY = apiKey;

    import("./http.ts")
      .then(() => {
        setStatus("running");
      })
      .catch((err) => {
        setStatus("error");
        setError(err.message);
      });
  }, [port, apiKey]);

  if (status === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">✗ Failed to start MCP server</Text>
        {error && <Text dimColor>{error}</Text>}
      </Box>
    );
  }

  if (status === "starting") {
    return (
      <Box padding={1}>
        <Spinner label="Starting MCP server..." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        <Text color="green">✓ </Text>
        <Text>MCP HTTP server running on </Text>
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

interface WorkerRunnerProps {
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
}: WorkerRunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    runWorker({
      prompt: prompt || undefined,
      yolo,
      systemPrompt: systemPrompt || undefined,
      systemPromptFile: systemPromptFile || undefined,
      additionalArgs,
    }).catch((err) => exit(err));
    // Note: runWorker runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, exit]);

  return null;
}

interface LeadRunnerProps {
  prompt: string;
  yolo: boolean;
  systemPrompt: string;
  systemPromptFile: string;
  additionalArgs: string[];
}

function LeadRunner({
  prompt,
  yolo,
  systemPrompt,
  systemPromptFile,
  additionalArgs,
}: LeadRunnerProps) {
  const { exit } = useApp();

  useEffect(() => {
    runLead({
      prompt: prompt || undefined,
      yolo,
      systemPrompt: systemPrompt || undefined,
      systemPromptFile: systemPromptFile || undefined,
      additionalArgs,
    }).catch((err) => exit(err));
    // Note: runLead runs indefinitely, so we don't call exit() on success
  }, [prompt, yolo, systemPrompt, systemPromptFile, additionalArgs, exit]);

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

function Version() {
  const { exit } = useApp();
  useEffect(() => {
    exit();
  }, [exit]);

  return (
    <Box padding={1}>
      <Text>
        {binName} v{pkg.version}
      </Text>
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
  } = args;

  switch (command) {
    case "setup":
      return <Setup dryRun={dryRun} restore={restore} yes={yes} />;
    case "mcp":
      return <McpServer port={port} apiKey={key} />;
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
    case "version":
      return <Version />;
    case "help":
    case undefined:
      return <Help />;
    default:
      return <UnknownCommand command={command} />;
  }
}

const args = parseArgs(process.argv.slice(2));

// Handle hook command separately (no UI needed)
if (args.command === "hook") {
  runHook();
} else {
  render(<App args={args} />);
}
