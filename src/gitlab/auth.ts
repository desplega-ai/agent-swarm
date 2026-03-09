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
  return !!process.env.GITLAB_WEBHOOK_SECRET && process.env.GITLAB_DISABLE !== "true";
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
 * GitLab uses simple string comparison of X-Gitlab-Token header against the configured secret.
 */
export function verifyGitLabWebhook(tokenHeader: string | undefined): boolean {
  if (!webhookSecret) return false;
  if (!tokenHeader) return false;
  // timingSafeEqual throws on different lengths, so guard first
  if (tokenHeader.length !== webhookSecret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(webhookSecret));
}

/** Get the GitLab API token for making API calls. */
export function getGitLabToken(): string | null {
  return apiToken;
}

/** Get the configured GitLab base URL. */
export function getGitLabUrl(): string {
  return gitlabUrl;
}

/** Bot name for mention detection. */
export const GITLAB_BOT_NAME = process.env.GITLAB_BOT_NAME ?? "agent-swarm-bot";

/** Reset state for testing. */
export function resetGitLab(): void {
  initialized = false;
  webhookSecret = null;
  apiToken = null;
  gitlabUrl = "https://gitlab.com";
}
