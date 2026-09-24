import { _fetchHolder, CLIENT_ID, exchangeAuthorizationCode, getAccountId } from "./flow.js";
import type { CodexOAuthCredentials } from "./types.js";

const DEVICE_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const UPSTREAM_TIMEOUT_MS = 15_000;

export const CODEX_DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";

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
  const response = await _fetchHolder.current(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      originator: "agent-swarm",
      "User-Agent": "agent-swarm",
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

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
  const response = await _fetchHolder.current(DEVICE_TOKEN_URL, {
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
    DEVICE_REDIRECT_URI,
    AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  );
  if (token.type !== "success") return null;
  const accountId = getAccountId(token.access);
  if (!accountId) return null;
  return { ...token, accountId };
}
