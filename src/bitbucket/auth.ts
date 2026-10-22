import { isEnvFlagEnabled } from "../utils/env-flag";
import { verifyHmacSignature } from "../workflows/triggers";

/**
 * Bitbucket Cloud Authentication & Webhook Verification
 *
 * Webhooks are signed with the webhook's secret: `X-Hub-Signature` carries
 * `sha256=<hex HMAC-SHA256 of the raw body>`, checked against
 * BITBUCKET_WEBHOOK_SECRET. API calls send BITBUCKET_TOKEN (an Atlassian API
 * token or a workspace access token) as a Bearer token.
 */

let initialized = false;
let webhookSecret: string | null = null;
let apiToken: string | null = null;

export function isBitbucketEnabled(): boolean {
  return !!process.env.BITBUCKET_WEBHOOK_SECRET && !isEnvFlagEnabled("BITBUCKET_DISABLE", false);
}

export function initBitbucket(): void {
  if (initialized) return;
  if (!isBitbucketEnabled()) {
    console.log("[Bitbucket] Integration disabled (BITBUCKET_WEBHOOK_SECRET not set)");
    return;
  }

  webhookSecret = process.env.BITBUCKET_WEBHOOK_SECRET!;
  apiToken = process.env.BITBUCKET_TOKEN ?? null;
  initialized = true;

  console.log(`[Bitbucket] Integration initialized (API token: ${apiToken ? "set" : "not set"})`);
}

/**
 * Verify a Bitbucket webhook delivery from its raw body and `X-Hub-Signature`
 * header. Only the `sha256=<hex>` form Bitbucket sends is accepted.
 */
export function verifyBitbucketWebhook(rawBody: string, signatureHeader: string | undefined) {
  if (!webhookSecret) return false;
  if (!signatureHeader?.startsWith("sha256=")) return false;
  return verifyHmacSignature(webhookSecret, rawBody, signatureHeader);
}

/** Get the Bitbucket token for API calls. */
export function getBitbucketToken(): string | null {
  return apiToken;
}

/**
 * Bot name for plain-text `@name` mentions. Read on every call: a stored
 * swarm_config value reaches process.env after this module loads, and again
 * on each config reload.
 */
export function getBitbucketBotName(): string {
  return process.env.BITBUCKET_BOT_NAME || "agent-swarm-bot";
}

/** Reset state for testing and config reloads. */
export function resetBitbucket(): void {
  initialized = false;
  webhookSecret = null;
  apiToken = null;
}
