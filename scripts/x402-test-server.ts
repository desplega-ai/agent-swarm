#!/usr/bin/env bun
/**
 * Dummy x402 Test Server
 *
 * A minimal HTTP server with an x402-protected endpoint for testing the payment flow.
 * Does NOT settle on-chain — just verifies the EIP-712 signature from the payment header.
 *
 * Endpoints:
 *   GET /              — Free endpoint (returns 200)
 *   GET /paid          — x402-protected endpoint (returns 402, then 200 with valid payment)
 *   GET /paid/expensive — x402-protected with higher price ($5 USDC)
 *
 * Usage:
 *   bun scripts/x402-test-server.ts [port]
 *
 * Default port: 4020
 */

import { getAddress, verifyTypedData } from "viem";
import { encodePaymentRequiredHeader } from "@x402/core/http";

const PORT = Number.parseInt(process.argv[2] || "4020", 10);

// A well-known test address to use as payTo (doesn't need to be real for testing)
const PAY_TO = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth

// USDC on Base Sepolia — EIP-712 domain params
const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_NAME = "USD Coin";
const USDC_VERSION = "2";
const CHAIN_ID = 84532; // Base Sepolia

// EIP-3009 TransferWithAuthorization types
const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface PaymentRequired {
  x402Version: number;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }>;
}

function buildPaymentRequired(url: string, amount: string): PaymentRequired {
  return {
    x402Version: 2,
    resource: {
      url,
      description: "Premium test content",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532", // Base Sepolia
        asset: USDC_ADDRESS,
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 86400,
        extra: {
          // EIP-712 domain params required by the x402 exact EVM scheme
          name: USDC_NAME,
          version: USDC_VERSION,
        },
      },
    ],
  };
}

/**
 * Decode a base64-encoded payment payload from the PAYMENT-SIGNATURE header.
 */
function decodePaymentHeader(headerValue: string): Record<string, unknown> | null {
  try {
    const json = atob(headerValue);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Verify the EIP-3009 TransferWithAuthorization signature in the payment payload.
 *
 * The x402 exact EVM scheme creates a payload like:
 *   { authorization: { from, to, value, validAfter, validBefore, nonce }, signature: "0x..." }
 */
async function verifyPayment(paymentPayload: Record<string, unknown>): Promise<{
  valid: boolean;
  payer?: string;
  reason?: string;
}> {
  try {
    const payload = paymentPayload.payload as Record<string, unknown>;
    if (!payload) {
      return { valid: false, reason: "missing payload" };
    }

    const signature = payload.signature as `0x${string}`;
    const authorization = payload.authorization as Record<string, unknown>;

    if (!signature) {
      return { valid: false, reason: "missing signature in payload" };
    }
    if (!authorization) {
      // No authorization data — accept the payment header as-is (basic test mode)
      return { valid: true, payer: "unknown (signature present, no authorization data)" };
    }

    // Reconstruct the EIP-712 typed data and verify the signature
    const domain = {
      name: USDC_NAME,
      version: USDC_VERSION,
      chainId: BigInt(CHAIN_ID),
      verifyingContract: getAddress(USDC_ADDRESS),
    };

    const message = {
      from: getAddress(authorization.from as string),
      to: getAddress(authorization.to as string),
      value: BigInt(authorization.value as string),
      validAfter: BigInt(authorization.validAfter as string),
      validBefore: BigInt(authorization.validBefore as string),
      nonce: authorization.nonce as `0x${string}`,
    };

    const valid = await verifyTypedData({
      address: message.from,
      domain,
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message,
      signature,
    });

    return { valid, payer: message.from };
  } catch (error) {
    return {
      valid: false,
      reason: `verification error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Free endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ status: "ok", message: "x402 test server running" });
    }

    // Paid endpoints
    if (url.pathname.startsWith("/paid")) {
      const isExpensive = url.pathname === "/paid/expensive";
      const amount = isExpensive ? "5000000" : "10000"; // $5.00 or $0.01 USDC (6 decimals)

      // Check for payment header
      const paymentHeader =
        req.headers.get("PAYMENT-SIGNATURE") || req.headers.get("X-PAYMENT");

      if (!paymentHeader) {
        // No payment — return 402 with payment requirements
        const paymentRequired = buildPaymentRequired(
          `${url.origin}${url.pathname}`,
          amount,
        );

        // x402 v2 requires the PAYMENT-REQUIRED header (base64-encoded PaymentRequired)
        const encoded = encodePaymentRequiredHeader(
          paymentRequired as Parameters<typeof encodePaymentRequiredHeader>[0],
        );

        return new Response(JSON.stringify(paymentRequired), {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "PAYMENT-REQUIRED": encoded,
          },
        });
      }

      // Has payment header — decode and verify
      const paymentPayload = decodePaymentHeader(paymentHeader);
      if (!paymentPayload) {
        return Response.json(
          { error: "Invalid payment header (could not decode base64/JSON)" },
          { status: 400 },
        );
      }

      const verification = await verifyPayment(paymentPayload);

      if (!verification.valid) {
        return Response.json(
          { error: `Payment verification failed: ${verification.reason}` },
          { status: 402 },
        );
      }

      // Payment accepted — return the premium content
      return Response.json({
        content: isExpensive ? "This is expensive premium content!" : "This is paid content!",
        paymentAccepted: true,
        payer: verification.payer,
        amount: isExpensive ? "$5.00" : "$0.01",
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`x402 test server running on http://localhost:${server.port}`);
console.log("Endpoints:");
console.log("  GET /              Free endpoint");
console.log("  GET /paid          x402-protected ($0.01 USDC)");
console.log("  GET /paid/expensive  x402-protected ($5.00 USDC)");
console.log("\nPress Ctrl+C to stop.");
