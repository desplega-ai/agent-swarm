import { isEnvFlagEnabled } from "../utils/env-flag";

/**
 * Azure DevOps Authentication & Webhook Verification
 *
 * Service hooks authenticate with HTTP Basic auth: the subscription's
 * "Basic authentication password" must equal AZURE_DEVOPS_WEBHOOK_SECRET
 * (the username is ignored). API calls use a Personal Access Token
 * (AZURE_DEVOPS_TOKEN) as the Basic auth password.
 */

let initialized = false;
let webhookSecret: string | null = null;
let apiToken: string | null = null;
let orgUrl: string | null = null;

export function isAzureDevOpsEnabled(): boolean {
  return (
    !!process.env.AZURE_DEVOPS_WEBHOOK_SECRET && !isEnvFlagEnabled("AZURE_DEVOPS_DISABLE", false)
  );
}

export function initAzureDevOps(): void {
  if (initialized) return;
  if (!isAzureDevOpsEnabled()) {
    console.log("[AzureDevOps] Integration disabled (AZURE_DEVOPS_WEBHOOK_SECRET not set)");
    return;
  }

  webhookSecret = process.env.AZURE_DEVOPS_WEBHOOK_SECRET!;
  apiToken = process.env.AZURE_DEVOPS_TOKEN ?? null;
  orgUrl = normalizeOrgUrl(process.env.AZURE_DEVOPS_ORG_URL);
  initialized = true;

  console.log(`[AzureDevOps] Integration initialized (org: ${orgUrl ?? "from payload"})`);
}

/**
 * Verify an Azure DevOps service-hook request from its `Authorization` header.
 * Only the Basic auth password is compared, in constant time.
 */
export function verifyAzureDevOpsWebhook(authorizationHeader: string | undefined): boolean {
  if (!webhookSecret) return false;
  if (!authorizationHeader?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(authorizationHeader.slice("Basic ".length), "base64").toString();
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const password = decoded.slice(separator + 1);
  // timingSafeEqual throws on different lengths, so guard first
  if (password.length !== webhookSecret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(password), Buffer.from(webhookSecret));
}

/** Get the Azure DevOps PAT for API calls. */
export function getAzureDevOpsToken(): string | null {
  return apiToken;
}

/** Get the configured organization URL without a trailing slash, if any. */
export function getAzureDevOpsOrgUrl(): string | null {
  return orgUrl;
}

export function normalizeOrgUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : null;
}

/** Bot name for plain-text `@name` mentions. */
export const AZURE_DEVOPS_BOT_NAME = process.env.AZURE_DEVOPS_BOT_NAME ?? "agent-swarm-bot";

/** Reset state for testing and config reloads. */
export function resetAzureDevOps(): void {
  initialized = false;
  webhookSecret = null;
  apiToken = null;
  orgUrl = null;
}
