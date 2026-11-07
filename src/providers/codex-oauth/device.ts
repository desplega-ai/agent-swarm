import { _fetchHolder, CLIENT_ID, exchangeAuthorizationCode, getAccountId } from "./flow.js";
import type { CodexOAuthCredentials } from "./types.js";

const DEFAULT_DEVICE_BASE_URL = "https://auth.openai.com";
const UPSTREAM_TIMEOUT_MS = 15_000;

/**
 * Origin of the device login endpoints. Read on every call, so a config reload
 * can point the login at a stand-in (the black-box suite runs one).
 */
/**
 * `CODEX_OAUTH_DEVICE_BASE_URL` is a test knob for the black-box suite. It is an env-only
 * reserved config key (swarm_config writes refuse it) and only a loopback origin is
 * honoured: the device login carries ChatGPT credentials, so a redirect to any other host
 * must be impossible. Anything else falls back to auth.openai.com.
 */
export function resolveCodexDeviceBaseUrl(raw: string | undefined): string {
  const configured = raw?.trim();
  if (!configured) return DEFAULT_DEVICE_BASE_URL;
  try {
    const url = new URL(configured);
    const loopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol === "http:" && loopback) return url.origin;
  } catch {
    // fall through
  }
  console.warn("[codex-oauth] CODEX_OAUTH_DEVICE_BASE_URL must be a loopback http origin; ignored");
  return DEFAULT_DEVICE_BASE_URL;
}

function deviceBaseUrl(): string {
  return resolveCodexDeviceBaseUrl(process.env.CODEX_OAUTH_DEVICE_BASE_URL);
}

/** The page where the user enters the code. Read on every call, like the other URLs. */
export function codexDeviceVerificationUrl(): string {
  return `${deviceBaseUrl()}/codex/device`;
}

export class DeviceCodeNotEnabledError extends Error {}

export type DeviceCode = {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
};

export type DeviceTokenPollResult =
  | { type: "success"; authorizationCode: string; codeVerifier: string }
  | { type: "pending" }
  | { type: "failed"; status: number };

function parseInterval(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 5;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const response = await _fetchHolder.current(
    `${deviceBaseUrl()}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        originator: "agent-swarm",
        "User-Agent": "agent-swarm",
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );

  if (response.status === 404) throw new DeviceCodeNotEnabledError();
  if (!response.ok) throw new Error(`Device code request failed with HTTP ${response.status}`);

  const body = (await response.json()) as Record<string, unknown>;
  const deviceAuthId = body.device_auth_id;
  const userCode = body.user_code ?? body.usercode;
  if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
    throw new Error("Device code response is missing required fields");
  }

  return {
    deviceAuthId,
    userCode,
    intervalSeconds: parseInterval(body.interval),
  };
}

export async function pollDeviceToken(
  deviceAuthId: string,
  userCode: string,
): Promise<DeviceTokenPollResult> {
  const response = await _fetchHolder.current(`${deviceBaseUrl()}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      originator: "agent-swarm",
      "User-Agent": "agent-swarm",
    },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (response.status === 403 || response.status === 404) return { type: "pending" };
  if (!response.ok) return { type: "failed", status: response.status };

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.authorization_code !== "string" || typeof body.code_verifier !== "string") {
    return { type: "failed", status: response.status };
  }
  return {
    type: "success",
    authorizationCode: body.authorization_code,
    codeVerifier: body.code_verifier,
  };
}

export async function exchangeDeviceAuthorizationCode(
  authorizationCode: string,
  codeVerifier: string,
): Promise<CodexOAuthCredentials | null> {
  const token = await exchangeAuthorizationCode(
    authorizationCode,
    codeVerifier,
    `${deviceBaseUrl()}/deviceauth/callback`,
    AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    `${deviceBaseUrl()}/oauth/token`,
  );
  if (token.type !== "success") return null;
  const accountId = getAccountId(token.access);
  if (!accountId) return null;
  return { ...token, accountId };
}
