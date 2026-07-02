#!/usr/bin/env bun
/**
 * x402 CLI — Test x402 payments from the command line.
 *
 * Usage:
 *   bun src/x402/cli.ts fetch <url>         Make a paid request to a URL
 *   bun src/x402/cli.ts status              Show spending summary
 *   bun src/x402/cli.ts check               Check if x402 is configured
 *
 * Signer backends (auto-detected):
 *   Openfort:  OPENFORT_API_KEY + OPENFORT_WALLET_SECRET
 *   Viem:      EVM_PRIVATE_KEY (0x-prefixed hex)
 *
 * Environment:
 *   X402_SIGNER_TYPE        "openfort" or "viem" (auto-detected if not set)
 *   OPENFORT_API_KEY        Openfort API key (sk_test_ or sk_live_)
 *   OPENFORT_WALLET_SECRET  Openfort wallet secret (base64 P-256 key)
 *   EVM_PRIVATE_KEY         Raw wallet private key (0x-prefixed)
 *   X402_MAX_AUTO_APPROVE   Max USD per request (default: 1.00)
 *   X402_DAILY_LIMIT        Daily USD limit (default: 10.00)
 *   X402_NETWORK            CAIP-2 network ID (default: eip155:84532)
 */

import { createX402Client } from "./client.ts";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "fetch": {
      const url = args[1];
      if (!url) {
        console.error("Usage: x402 fetch <url>");
        process.exit(1);
      }

      const method = (args[2] || "GET").toUpperCase();
      console.log(`Making ${method} request to ${url} with x402 payment support...\n`);

      const client = await createX402Client();
      const summary = client.getSpendingSummary();
      console.log(`Signer: ${client.config.signerType} | Wallet: ${client.walletAddress}`);
      console.log(
        `Spending limits: $${summary.maxPerRequest.toFixed(2)}/request, ` +
          `$${summary.dailyLimit.toFixed(2)}/day ` +
          `($${summary.dailyRemaining.toFixed(2)} remaining)\n`,
      );

      const response = await client.fetch(url, { method });

      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log("Headers:");
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase().startsWith("payment") || key.toLowerCase() === "content-type") {
          console.log(`  ${key}: ${value}`);
        }
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json")) {
        const body = await response.json();
        console.log("\nResponse body:");
        console.log(JSON.stringify(body, null, 2));
      } else {
        const body = await response.text();
        console.log(`\nResponse body (${body.length} chars):`);
        console.log(body.slice(0, 2000));
        if (body.length > 2000) console.log("... (truncated)");
      }

      const updatedSummary = client.getSpendingSummary();
      console.log(
        `\nSpending: $${updatedSummary.todaySpent.toFixed(2)} today ` +
          `(${updatedSummary.todayCount} payments, ` +
          `$${updatedSummary.dailyRemaining.toFixed(2)} remaining)`,
      );
      break;
    }

    case "status": {
      const client = await createX402Client();
      const summary = client.getSpendingSummary();
      console.log("x402 Spending Status");
      console.log("====================");
      console.log(`Signer:            ${client.config.signerType}`);
      console.log(`Wallet:            ${client.walletAddress}`);
      console.log(`Per-request limit: $${summary.maxPerRequest.toFixed(2)}`);
      console.log(`Daily limit:       $${summary.dailyLimit.toFixed(2)}`);
      console.log(`Today spent:       $${summary.todaySpent.toFixed(2)}`);
      console.log(`Today remaining:   $${summary.dailyRemaining.toFixed(2)}`);
      console.log(`Today payments:    ${summary.todayCount}`);
      break;
    }

    case "check": {
      try {
        const client = await createX402Client();
        console.log("x402 Configuration");
        console.log("==================");
        console.log(`Signer type:     ${client.config.signerType}`);
        console.log(`Wallet address:  ${client.walletAddress}`);
        console.log(`Max per request: $${client.config.maxAutoApprove.toFixed(2)}`);
        console.log(`Daily limit:     $${client.config.dailyLimit.toFixed(2)}`);
        console.log(`Network:         ${client.config.network}`);
        console.log("\nx402 is configured and ready.");
      } catch (error) {
        console.error(
          `x402 configuration error: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
      break;
    }

    default:
      console.log("x402 CLI — Test x402 payments\n");
      console.log("Commands:");
      console.log("  fetch <url> [method]  Make a paid request (default: GET)");
      console.log("  status               Show spending summary");
      console.log("  check                Check if x402 is configured");
      console.log("\nSigner backends (auto-detected):");
      console.log("  Openfort:  OPENFORT_API_KEY + OPENFORT_WALLET_SECRET");
      console.log("  Viem:      EVM_PRIVATE_KEY (0x-prefixed hex)");
      console.log("\nEnvironment variables:");
      console.log("  X402_SIGNER_TYPE        'openfort' or 'viem' (auto-detected)");
      console.log("  OPENFORT_API_KEY        Openfort API key");
      console.log("  OPENFORT_WALLET_SECRET  Openfort wallet auth secret");
      console.log("  EVM_PRIVATE_KEY         Raw private key (0x-prefixed)");
      console.log("  X402_MAX_AUTO_APPROVE   Max USD per request (default: 1.00)");
      console.log("  X402_DAILY_LIMIT        Daily USD limit (default: 10.00)");
      console.log("  X402_NETWORK            CAIP-2 network ID (default: eip155:84532)");
      break;
  }
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
