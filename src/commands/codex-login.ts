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

import { loginCodexOAuth } from "../providers/codex-oauth/flow.js";
import { storeCodexOAuth } from "../providers/codex-oauth/storage.js";

export async function runCodexLogin(args: string[]): Promise<void> {
  // Parse --api-url and --api-key flags
  let apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  let apiKey = process.env.API_KEY || "123123";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--api-url" && args[i + 1]) {
      apiUrl = args[++i]!;
    } else if (arg === "--api-key" && args[i + 1]) {
      apiKey = args[++i]!;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
agent-swarm codex-login — Authenticate Codex via ChatGPT OAuth

Usage:
  agent-swarm codex-login [options]

Options:
  --api-url <url>    Swarm API URL (default: MCP_BASE_URL or http://localhost:3013)
  --api-key <key>   Swarm API key (default: API_KEY or 123123)
  -h, --help        Show this help

This command runs the OpenAI Codex OAuth PKCE flow:
  1. Opens a browser to ChatGPT login
  2. Receives the authorization code via localhost:1455 callback
  3. Exchanges the code for access/refresh tokens
  4. Stores credentials in the swarm API config store

Deployed Codex workers automatically restore these credentials at boot.
`);
      return;
    }
  }

  console.log("Starting Codex ChatGPT OAuth login...\n");

  let browserOpened = false;

  try {
    const creds = await loginCodexOAuth({
      onAuth: ({ url, instructions }) => {
        console.log(`Open this URL in your browser:\n\n  ${url}\n`);
        if (instructions) {
          console.log(instructions);
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
          import("node:child_process")
            .then(({ exec }) => {
              exec(`${cmd} "${url}"`, (err) => {
                if (err) {
                  console.log("(Could not open browser automatically)\n");
                }
              });
            })
            .catch(() => {});
        }
      },
      onPrompt: async ({ message }) => {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return new Promise<string>((resolve) => {
          rl.question(`${message} `, (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      },
      onProgress: (message) => {
        console.log(message);
      },
      onManualCodeInput: async () => {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        return new Promise<string>((resolve) => {
          rl.question("Or paste the authorization code here: ", (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });
      },
    });

    console.log("\nOAuth flow completed successfully!");
    console.log(`  Account ID: ${creds.accountId}`);
    console.log(`  Expires: ${new Date(creds.expires).toISOString()}`);

    // Store credentials in the swarm API config store
    console.log("\nStoring credentials in swarm API config store...");
    await storeCodexOAuth(apiUrl, apiKey, creds);
    console.log("Credentials stored successfully!");

    console.log("\nDeployed Codex workers will automatically restore these credentials at boot.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nError: ${message}`);
    process.exit(1);
  }
}
