/**
 * `agent-swarm codex-login` — authenticate Codex via ChatGPT OAuth.
 *
 * Runs the OAuth PKCE flow (browser redirect to localhost:1455, manual paste
 * fallback), extracts chatgpt_account_id from the JWT, and stores the
 * credentials in the swarm API config store at global scope.
 *
 * This is a non-UI command (plain stdout, no Ink) — it exits immediately
 * after completing or failing the OAuth flow.
 */

import { exec } from "node:child_process";
import { emitKeypressEvents } from "node:readline";

import { loginCodexOAuth } from "../providers/codex-oauth/flow.js";
import { storeCodexOAuth } from "../providers/codex-oauth/storage.js";

type PromptTextFn = (label: string, defaultValue: string) => Promise<string>;
type PromptSecretFn = (label: string, defaultValue: string, helpText?: string) => Promise<string>;

type ResolveCodexLoginConfigDeps = {
  env?: Record<string, string | undefined>;
  isInteractive?: boolean;
  promptText?: PromptTextFn;
  promptSecret?: PromptSecretFn;
};

type RunCodexLoginDeps = {
  resolveConfig?: typeof resolveCodexLoginConfig;
  login?: typeof loginCodexOAuth;
  store?: typeof storeCodexOAuth;
  log?: (message: string) => void;
  error?: (message: string) => void;
  exit?: (code: number) => void;
};

type ParsedCodexLoginArgs = {
  apiUrl?: string;
  apiKey?: string;
  showHelp: boolean;
};

function parseCodexLoginArgs(args: string[]): ParsedCodexLoginArgs {
  const parsed: ParsedCodexLoginArgs = { showHelp: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api-url" && args[i + 1]) {
      parsed.apiUrl = args[++i]!;
    } else if (arg === "--api-key" && args[i + 1]) {
      parsed.apiKey = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      parsed.showHelp = true;
    }
  }

  return parsed;
}

async function promptTextInput(label: string, defaultValue: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise<string>((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    rl.question(`${label}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptHiddenInput(
  label: string,
  _defaultValue: string,
  helpText?: string,
): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return promptTextInput(label, "");
  }

  if (helpText) {
    stdout.write(`${helpText}\n`);
  }
  stdout.write(`${label}: `);

  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.removeListener("keypress", onKeypress);
      stdout.write("\n");
    };

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(value.trim());
        return;
      }

      if (key.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }

      if (!key.ctrl && !key.meta && str) {
        value += str;
        stdout.write("*");
      }
    };

    stdin.on("keypress", onKeypress);
  });
}

export async function resolveCodexLoginConfig(
  args: string[],
  deps: ResolveCodexLoginConfigDeps = {},
): Promise<{ apiUrl: string; apiKey: string }> {
  const env = deps.env ?? process.env;
  const parsed = parseCodexLoginArgs(args);
  const promptText = deps.promptText ?? promptTextInput;
  const promptSecret = deps.promptSecret ?? promptHiddenInput;
  const isInteractive = deps.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const defaultApiUrl = env.MCP_BASE_URL || "http://localhost:3013";
  const defaultApiKey = env.API_KEY || "123123";

  let apiUrl = parsed.apiUrl ?? defaultApiUrl;
  let apiKey = parsed.apiKey ?? defaultApiKey;

  if (!parsed.apiUrl && isInteractive) {
    apiUrl = (await promptText("Swarm API URL", defaultApiUrl)).trim() || defaultApiUrl;
  }

  if (!parsed.apiKey && isInteractive) {
    const apiKeyHelp = env.API_KEY
      ? "Press Enter to use API_KEY from the environment"
      : "Press Enter to use the default local API key";
    apiKey =
      (await promptSecret("Swarm API key", defaultApiKey, apiKeyHelp)).trim() || defaultApiKey;
  }

  return { apiUrl, apiKey };
}

function printHelp() {
  console.log(`
agent-swarm codex-login — Authenticate Codex via ChatGPT OAuth

Usage:
  agent-swarm codex-login [options]

Options:
  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)
  --api-key <key>    Swarm API key (default: API_KEY or 123123)
  -h, --help         Show this help

Without flags, the command prompts interactively for the target API URL and
for the swarm API key using masked input when the terminal supports it.

This command runs the OpenAI Codex OAuth PKCE flow:
  1. Opens a browser to ChatGPT login
  2. Receives the authorization code via localhost:1455 callback
  3. Exchanges the code for access/refresh tokens
  4. Stores credentials in the swarm API config store

Deployed Codex workers automatically restore these credentials at boot.
`);
}

export async function runCodexLogin(args: string[], deps: RunCodexLoginDeps = {}): Promise<void> {
  const resolveConfig = deps.resolveConfig ?? resolveCodexLoginConfig;
  const login = deps.login ?? loginCodexOAuth;
  const store = deps.store ?? storeCodexOAuth;
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  if (parseCodexLoginArgs(args).showHelp) {
    printHelp();
    return;
  }

  let browserOpened = false;

  try {
    const { apiUrl, apiKey } = await resolveConfig(args);

    log("Starting Codex ChatGPT OAuth login...\n");
    log(`Target swarm API: ${apiUrl}\n`);

    const creds = await login({
      onAuth: ({ url, instructions }) => {
        log(`Open this URL in your browser:\n\n  ${url}\n`);
        if (instructions) {
          log(instructions);
        }
        // Try to open the browser (fire-and-forget, non-fatal)
        if (!browserOpened) {
          browserOpened = true;
          const cmd =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "start"
                : "xdg-open";
          exec(`${cmd} "${url}"`, (err) => {
            if (err) {
              log("(Could not open browser automatically)\n");
            }
          });
        }
      },
      onPrompt: async ({ message }) => {
        return promptTextInput(message, "");
      },
      onProgress: (message) => {
        log(message);
      },
      onManualCodeInput: async () => {
        return promptTextInput("Or paste the authorization code here", "");
      },
    });

    log("\nOAuth flow completed successfully!");
    log(`  Account ID: ${creds.accountId}`);
    log(`  Expires: ${new Date(creds.expires).toISOString()}`);

    // Store credentials in the swarm API config store
    log("\nStoring credentials in swarm API config store...");
    await store(apiUrl, apiKey, creds);
    log("Credentials stored successfully!");

    log("\nDeployed Codex workers will automatically restore these credentials at boot.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(`\nError: ${message}`);
    exit(1);
  }
}
