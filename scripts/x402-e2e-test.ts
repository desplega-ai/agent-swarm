#!/usr/bin/env bun
/**
 * x402 End-to-End Test
 *
 * Tests the full x402 payment flow:
 *   1. Starts the dummy x402 test server
 *   2. Creates an x402 client (with viem signer using a test key)
 *   3. Makes a request to the paid endpoint
 *   4. Verifies the 402 → sign → retry → 200 flow works
 *
 * Usage:
 *   bun scripts/x402-e2e-test.ts
 *
 * Environment:
 *   Set EVM_PRIVATE_KEY or OPENFORT_API_KEY + OPENFORT_WALLET_SECRET
 *   If none set, uses a hardcoded test key (viem signer).
 */

import { createX402Client } from "../src/x402/client.ts";
import type { Subprocess } from "bun";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SERVER_PORT = 4021;
const BASE_URL = `http://localhost:${SERVER_PORT}`;

let serverProcess: Subprocess | null = null;

async function startServer(): Promise<void> {
  serverProcess = Bun.spawn(["bun", "scripts/x402-test-server.ts", String(SERVER_PORT)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await Bun.sleep(100);
  }
  throw new Error("Server failed to start within 3 seconds");
}

function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function pass(name: string): void {
  console.log(`  PASS  ${name}`);
}

function fail(name: string, error: unknown): void {
  console.log(`  FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
}

async function runTests(): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  // Determine signer type
  const hasOpenfort = !!process.env.OPENFORT_API_KEY;
  const hasViem = !!process.env.EVM_PRIVATE_KEY;

  if (!hasOpenfort && !hasViem) {
    log(`No signer env vars set. Using test private key (viem signer).`);
    process.env.EVM_PRIVATE_KEY = TEST_PRIVATE_KEY;
  }

  // Test 1: Free endpoint works
  try {
    const res = await fetch(`${BASE_URL}/`);
    const body = await res.json();
    if (res.status !== 200 || body.status !== "ok")
      throw new Error(`Expected 200 ok, got ${res.status}`);
    pass("Free endpoint returns 200");
    passed++;
  } catch (e) {
    fail("Free endpoint returns 200", e);
    failed++;
  }

  // Test 2: Paid endpoint returns 402 without payment
  try {
    const res = await fetch(`${BASE_URL}/paid`);
    if (res.status !== 402) throw new Error(`Expected 402, got ${res.status}`);
    const body = await res.json();
    if (!body.accepts || body.x402Version !== 2)
      throw new Error("Missing x402 payment requirements");
    pass("Paid endpoint returns 402 without payment");
    passed++;
  } catch (e) {
    fail("Paid endpoint returns 402 without payment", e);
    failed++;
  }

  // Test 3: Full x402 flow with viem/openfort signer
  try {
    const client = await createX402Client();
    log(`Using ${client.config.signerType} signer, wallet: ${client.walletAddress}`);

    const res = await client.fetch(`${BASE_URL}/paid`);
    const body = await res.json();

    if (res.status !== 200) {
      throw new Error(`Expected 200 after payment, got ${res.status}: ${JSON.stringify(body)}`);
    }
    if (!body.paymentAccepted) {
      throw new Error("Server did not acknowledge payment acceptance");
    }

    pass(`Full x402 flow (${client.config.signerType} signer) → 200 with payment accepted`);
    log(`  Payer: ${body.payer}`);
    log(`  Amount: ${body.amount}`);
    passed++;
  } catch (e) {
    fail("Full x402 flow", e);
    failed++;
  }

  // Test 4: Spending tracker records payment
  try {
    const client = await createX402Client();
    const summaryBefore = client.getSpendingSummary();
    const countBefore = summaryBefore.todayCount;

    await client.fetch(`${BASE_URL}/paid`);

    const summaryAfter = client.getSpendingSummary();
    if (summaryAfter.todayCount !== countBefore + 1) {
      throw new Error(`Expected ${countBefore + 1} payments, got ${summaryAfter.todayCount}`);
    }

    pass("Spending tracker records payment");
    log(`  Spent today: $${summaryAfter.todaySpent.toFixed(4)}`);
    passed++;
  } catch (e) {
    fail("Spending tracker records payment", e);
    failed++;
  }

  // Test 5: Expensive endpoint blocked by spending limit (default $1.00/request)
  try {
    const client = await createX402Client();

    const res = await client.fetch(`${BASE_URL}/paid/expensive`);
    // The spending tracker should block this since $5 > $1 per-request limit
    // The x402 client will throw or return an error
    // Actually, the abort happens in the hook which throws
    fail("Expensive endpoint should be blocked by spending limit", "No error thrown");
    failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("exceeds per-request limit") ||
      msg.includes("abort") ||
      msg.includes("Failed to create payment")
    ) {
      pass("Expensive endpoint blocked by spending limit ($5 > $1 max)");
      passed++;
    } else {
      fail("Expensive endpoint blocked by spending limit", e);
      failed++;
    }
  }

  return { passed, failed };
}

async function main() {
  console.log("x402 End-to-End Test");
  console.log("====================\n");

  console.log("Starting test server...");
  await startServer();
  console.log(`Server running on ${BASE_URL}\n`);

  try {
    const { passed, failed } = await runTests();
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    stopServer();
    console.log("Server stopped.");
  }
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  stopServer();
  process.exit(1);
});
