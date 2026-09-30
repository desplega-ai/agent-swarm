/**
 * Codex on the ChatGPT subscription for eval sandboxes.
 *
 * The swarm keeps its ChatGPT OAuth credentials in `codex_oauth_<slot>` config
 * rows (src/providers/codex-oauth/). When `EVALS_SWARM_API_URL` and
 * `EVALS_SWARM_API_KEY` point at that swarm, each codex member boots with a
 * chatgpt-mode `~/.codex/auth.json` built from one slot, and never with
 * OPENAI_API_KEY. Without them, codex falls back to OPENAI_API_KEY and is
 * metered.
 *
 * Refresh-token rotation: a slot is shared with the swarm's own codex workers,
 * and two parties refreshing one refresh token revoke the token family
 * (`refresh_token_reused`). So the sandbox gets the access token only; its
 * `refresh_token` is blank, exactly like the pool auth.json the swarm's runner
 * hands its own Codex CLI. The only refresh happens host-side, through the
 * swarm's lock-guarded `getValidCodexOAuth`, which is the same refresher the
 * swarm's workers use. It refreshes only when the token is within 12 h of
 * expiry, and an eval attempt lives at most 30 min, so a sandbox's token
 * cannot expire mid-attempt.
 *
 * `EVALS_CODEX_OAUTH_SLOT` picks the slot (default 0). Point it at a slot
 * reserved for evals to keep eval usage off the workers' rate window.
 */

import { credentialsToAuthJson } from "../../../../src/providers/codex-oauth/auth-json";
import { getValidCodexOAuth } from "../../../../src/providers/codex-oauth/storage";
import type { CodexAuthJson } from "../../../../src/providers/codex-oauth/types";

type Env = Record<string, string | undefined>;

/** Where the auth.json lands in the worker sandbox (the entrypoint keeps a chatgpt-mode file). */
export const CODEX_AUTH_JSON_PATH = "/home/worker/.codex/auth.json";

/** Refuse a token that expires sooner than this: the attempt TTL (30 min) plus margin. */
export const MIN_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export interface CodexOAuthSource {
  apiUrl: string;
  apiKey: string;
  slot: number;
}

/** The swarm to borrow the ChatGPT credential from; null = codex runs on OPENAI_API_KEY (metered). */
export function codexOAuthSource(env: Env = process.env): CodexOAuthSource | null {
  const apiUrl = env.EVALS_SWARM_API_URL?.trim();
  const apiKey = env.EVALS_SWARM_API_KEY?.trim();
  if (!apiUrl || !apiKey) return null;
  const raw = env.EVALS_CODEX_OAUTH_SLOT?.trim();
  const slot = raw ? Number(raw) : 0;
  if (!Number.isInteger(slot) || slot < 0) {
    throw new Error(`EVALS_CODEX_OAUTH_SLOT must be a non-negative integer, got "${raw}"`);
  }
  return { apiUrl: apiUrl.replace(/\/+$/, ""), apiKey, slot };
}

export interface CodexSubscriptionAuth {
  slot: number;
  /** chatgpt-mode auth.json with a blank refresh token. */
  authJson: CodexAuthJson;
  /** The access token, for log redaction. */
  accessToken: string;
  expiresAt: string;
}

/**
 * Fetch a valid access token for the configured slot. Throws when the slot is
 * missing, its refresh fails, or the token would expire during the attempt:
 * the caller must fail the boot, never fall back to a metered key.
 */
export async function resolveCodexSubscriptionAuth(
  source: CodexOAuthSource,
  deps: { getValid?: typeof getValidCodexOAuth; now?: () => number } = {},
): Promise<CodexSubscriptionAuth> {
  const getValid = deps.getValid ?? getValidCodexOAuth;
  const now = deps.now ?? Date.now;
  const creds = await getValid(source.apiUrl, source.apiKey, source.slot);
  if (!creds) {
    throw new Error(
      `codex subscription: no codex_oauth_${source.slot} credential on ${source.apiUrl}`,
    );
  }
  if (creds.expires - now() < MIN_TOKEN_LIFETIME_MS) {
    throw new Error(
      `codex subscription: codex_oauth_${source.slot} expires at ${new Date(creds.expires).toISOString()}, too soon for an attempt`,
    );
  }
  return {
    slot: source.slot,
    authJson: credentialsToAuthJson(creds, { includeRefreshToken: false }),
    accessToken: creds.access,
    expiresAt: new Date(creds.expires).toISOString(),
  };
}

/**
 * Shell command that installs the auth.json in a worker sandbox before its
 * entrypoint starts. The JSON travels base64-encoded, so no quoting issues.
 */
export function installAuthJsonCommand(authJson: CodexAuthJson): string {
  const b64 = Buffer.from(JSON.stringify(authJson), "utf8").toString("base64");
  const dir = CODEX_AUTH_JSON_PATH.slice(0, CODEX_AUTH_JSON_PATH.lastIndexOf("/"));
  return (
    `install -d -m 700 -o worker -g worker ${dir} && ` +
    `echo ${b64} | base64 -d > ${CODEX_AUTH_JSON_PATH} && ` +
    `chown worker:worker ${CODEX_AUTH_JSON_PATH} && chmod 600 ${CODEX_AUTH_JSON_PATH}`
  );
}
