/**
 * ChatGPT subscription credential for a pi session that runs an
 * `openai-codex/<id>` model (see `@desplega/model-catalog`'s
 * `chatgpt-subscription.ts`).
 *
 * The runner picks a `codex_oauth_<n>` pool slot exactly as it does for codex
 * (`resolveCodexOAuthCredentialInfo`, same rate-limit bookkeeping) and passes
 * it as `codexSlot`. This revalidates that slot through the locked
 * `getValidCodexOAuth`, the sole path that ever exchanges a pool refresh
 * token, and returns the credential with the refresh token BLANKED. The
 * harness gets an access token it can use but never a refresh token it could
 * rotate outside `/api/oauth/refresh-locks`: OpenAI revokes the whole token
 * family on replay, which would kill the slot for every worker. Same contract
 * as `credentialsToAuthJson(..., { includeRefreshToken: false })` for codex.
 *
 * Accepted cost: a session that outlives the access token errors instead of
 * refreshing. `getValidCodexOAuth` hands out tokens with at least 12 h left.
 */

import { chatgptSubscriptionModelId } from "@desplega/model-catalog";
import { isCodexRejectedAccessError } from "../../utils/codex-auth-failure";
import { registerVolatileSecret } from "../../utils/secret-scrubber";
import type { ProviderSessionConfig } from "../types";
import { buildPoolRevalidationFailureReason, getValidCodexOAuth } from "./storage.js";
import type { CodexOAuthCredentials } from "./types.js";

export async function loadChatgptSubscriptionCredential(
  config: Pick<ProviderSessionConfig, "apiUrl" | "apiKey" | "codexSlot" | "model">,
  deps: { getValid?: typeof getValidCodexOAuth } = {},
): Promise<CodexOAuthCredentials> {
  const slot = config.codexSlot;
  if (slot === undefined || !config.apiUrl || !config.apiKey) {
    throw new Error(
      `[auth-error] Model "${config.model}" runs on the ChatGPT subscription pool, but no codex_oauth pool slot is configured. Run codex-login to add one, or pick a model with its own API key.`,
    );
  }
  const getValid = deps.getValid ?? getValidCodexOAuth;
  let creds: CodexOAuthCredentials | null;
  try {
    creds = await getValid(config.apiUrl, config.apiKey, slot);
  } catch (err) {
    throw new Error(buildPoolRevalidationFailureReason(err, slot));
  }
  if (!creds) {
    throw new Error(
      `[auth-error] Codex pool slot ${slot} revalidation failed: no credentials found in config store — the slot may have just been quarantined; re-run codex-login for this slot if this persists.`,
    );
  }
  registerVolatileSecret(creds.access, "CODEX_OAUTH_ACCESS_TOKEN");
  return { ...creds, refresh: "" };
}

/**
 * The `[auth-error]` failure reason for a subscription session whose access
 * the ChatGPT backend rejected mid-run (a login revoked while its access
 * token is unexpired), else undefined. The runner counts it toward the
 * slot's auth-failure bench, as it does codex's turn-level 401.
 */
export function chatgptSubscriptionAuthFailure(
  raw: string,
  config: Pick<ProviderSessionConfig, "codexSlot" | "model">,
): string | undefined {
  const slot = config.codexSlot;
  if (slot === undefined || !chatgptSubscriptionModelId(config.model)) return undefined;
  if (!isCodexRejectedAccessError(raw)) return undefined;
  return `[auth-error] Codex pool slot ${slot} authentication failed — re-run agent-swarm codex-login --slot ${slot}. Original error: ${raw}`;
}
