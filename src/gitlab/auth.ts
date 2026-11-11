import { isEnvFlagEnabled } from "../utils/env-flag";
import { verifyTokenEquality } from "../workflows/triggers";

/**
 * GitLab Authentication & Webhook Verification
 *
 * GitLab uses a simple shared-secret token for webhook verification
 * (X-Gitlab-Token header) and PAT/Group Access Token for API calls.
 */

let initialized = false;
let webhookSecret: string | null = null;
let apiToken: string | null = null;
let gitlabUrl: string = "https://gitlab.com";

export function isGitLabEnabled(): boolean {
  return !!process.env.GITLAB_WEBHOOK_SECRET && !isEnvFlagEnabled("GITLAB_DISABLE", false);
}

export function initGitLab(): void {
  if (initialized) return;
  if (!isGitLabEnabled()) {
    console.log("[GitLab] Integration disabled (GITLAB_WEBHOOK_SECRET not set)");
    return;
  }

  webhookSecret = process.env.GITLAB_WEBHOOK_SECRET!;
  apiToken = process.env.GITLAB_TOKEN ?? null;
  gitlabUrl = process.env.GITLAB_URL ?? "https://gitlab.com";
  initialized = true;

  console.log(`[GitLab] Integration initialized (url: ${gitlabUrl})`);
}

/**
 * Verify a GitLab webhook request.
 * The X-Gitlab-Token header is compared to the configured secret in constant time, by digest.
 */
export function verifyGitLabWebhook(tokenHeader: string | undefined): boolean {
  if (!webhookSecret) return false;
  if (!tokenHeader) return false;
  return verifyTokenEquality(webhookSecret, tokenHeader);
}

/** Get the GitLab API token for making API calls. */
export function getGitLabToken(): string | null {
  return apiToken;
}

/** Get the configured GitLab base URL. */
export function getGitLabUrl(): string {
  return gitlabUrl;
}

/**
 * Bot name for mention detection. Read on every call: a stored swarm_config
 * value reaches process.env after this module loads, and again on each config
 * reload.
 */
export function getGitLabBotName(): string {
  return process.env.GITLAB_BOT_NAME || "agent-swarm-bot";
}

/** Reset state for testing. */
export function resetGitLab(): void {
  initialized = false;
  webhookSecret = null;
  apiToken = null;
  gitlabUrl = "https://gitlab.com";
}
