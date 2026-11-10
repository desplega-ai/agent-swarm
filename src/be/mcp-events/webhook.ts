/**
 * Standard Webhooks signing and SSRF-guarded POSTs for MCP Events webhook
 * delivery (SEP-3415 draft, "Webhook security").
 *
 * Every request to a client-supplied URL goes through `createGuardedFetch`:
 * the hostname is resolved and checked at send time, the request connects to
 * the checked address, and redirects are refused. Failures surface only as a
 * SEP-3415 `lastError` category, never as the endpoint's raw response.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  assertUrlSafe,
  createGuardedFetch,
  EgressDeniedError,
  type GuardedFetchOptions,
} from "@/utils/egress-guard";
import { parseEnvFlag } from "@/utils/env-flag";

export type DeliveryErrorCategory =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

const SECRET_PREFIX = "whsec_";
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const DELIVERY_TIMEOUT_MS = 10_000;
/** SEP-3415 delivery profile: bodies at or under 256 KiB. */
export const MAX_DELIVERY_BODY_BYTES = 256 * 1024;
const MAX_CHALLENGE_RESPONSE_BYTES = 4096;

type WebhookTestOverrides = {
  /** Accept http:// callback URLs (local test receivers only). */
  allowInsecure?: boolean;
  guard?: Partial<GuardedFetchOptions>;
  baseFetch?: typeof fetch;
};

let testOverrides: WebhookTestOverrides | null = null;

/** Tests only: relax the https rule and point the guard at a local receiver. */
export function __setWebhookTestOverrides(overrides: WebhookTestOverrides | null): void {
  testOverrides = overrides;
}

/**
 * MCP_USER_EVENTS_ALLOW_PRIVATE_CALLBACKS=true accepts http:// and loopback or
 * private callback URLs. Off by default; for local development and the
 * black-box e2e suite, which run the receiver on 127.0.0.1.
 */
function allowPrivateCallbacks(): boolean {
  return parseEnvFlag(process.env.MCP_USER_EVENTS_ALLOW_PRIVATE_CALLBACKS, false);
}

/**
 * Decodes a Standard Webhooks `whsec_` secret. Returns null unless the value is
 * `whsec_` followed by base64 of 24 to 64 bytes (SEP-3415 "Secret generation").
 */
export function parseWebhookSecret(secret: unknown): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) return null;
  return bytes;
}

/**
 * Returns an error message when `rawUrl` cannot be a callback URL: not https,
 * malformed, or a loopback/private literal. A public name that resolves to a
 * private address is caught later, at send time, by the guarded fetch.
 */
export function callbackUrlProblem(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return "delivery.url is required";
  if (rawUrl.length > 2048) return "delivery.url is too long";
  let parsed: URL;
  try {
    parsed = assertUrlSafe(rawUrl, {
      allowInsecure: allowPrivateCallbacks() || testOverrides?.allowInsecure === true,
      allowPrivateHosts:
        allowPrivateCallbacks() || testOverrides?.guard?.policy?.allowPrivate === true,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "delivery.url is not allowed";
  }
  if (parsed.username || parsed.password) return "delivery.url must not carry credentials";
  return null;
}

/** `v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>` per secret, space-joined. */
export function signWebhook(
  secrets: Buffer[],
  webhookId: string,
  timestampSec: number,
  body: string,
): string {
  const content = `${webhookId}.${timestampSec}.${body}`;
  return secrets
    .map((secret) => `v1,${createHmac("sha256", secret).update(content).digest("base64")}`)
    .join(" ");
}

export type PostResult =
  | { ok: true; status: number; text: string }
  | { ok: false; status?: number; category: DeliveryErrorCategory };

function guardedFetch(): typeof fetch {
  return createGuardedFetch(testOverrides?.baseFetch ?? fetch, {
    policy: { allowPrivate: allowPrivateCallbacks(), allowlist: null },
    ...testOverrides?.guard,
  });
}

function categorize(error: unknown): DeliveryErrorCategory {
  if (error instanceof EgressDeniedError) return "connection_refused";
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : "";
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return "timeout";
  }
  if (/certificate|tls|ssl|self.signed|handshake/i.test(message)) return "tls_error";
  return "connection_refused";
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

/**
 * POSTs `body` to `url` with Standard Webhooks headers plus
 * `X-MCP-Subscription-Id`. Each call signs with a fresh timestamp, so a retry
 * passes the receiver's freshness window.
 */
export async function postSignedWebhook(input: {
  url: string;
  subscriptionId: string;
  webhookId: string;
  secrets: Buffer[];
  body: string;
  readBody?: boolean;
}): Promise<PostResult> {
  const timestampSec = Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    response = await guardedFetch()(input.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "webhook-id": input.webhookId,
        "webhook-timestamp": String(timestampSec),
        "webhook-signature": signWebhook(input.secrets, input.webhookId, timestampSec, input.body),
        "X-MCP-Subscription-Id": input.subscriptionId,
      },
      body: input.body,
    });
  } catch (error) {
    return { ok: false, category: categorize(error) };
  }
  if (response.status >= 200 && response.status < 300) {
    const text = input.readBody
      ? await readCapped(response, MAX_CHALLENGE_RESPONSE_BYTES).catch(() => "")
      : "";
    if (!input.readBody) await response.body?.cancel().catch(() => {});
    return { ok: true, status: response.status, text };
  }
  await response.body?.cancel().catch(() => {});
  // A 3xx lands here too: redirects are never followed.
  return {
    ok: false,
    status: response.status,
    category: response.status >= 500 ? "http_5xx" : "http_4xx",
  };
}

/**
 * Sends the SEP-3415 `verification` control envelope and checks, in constant
 * time, that the endpoint echoed the single-use challenge. Returns null on
 * success, else the failure category.
 */
export async function verifyCallbackEndpoint(input: {
  url: string;
  subscriptionId: string;
  secret: Buffer;
}): Promise<DeliveryErrorCategory | null> {
  const challenge = randomBytes(24).toString("base64url");
  const result = await postSignedWebhook({
    url: input.url,
    subscriptionId: input.subscriptionId,
    webhookId: `msg_verification_${randomBytes(12).toString("hex")}`,
    secrets: [input.secret],
    body: JSON.stringify({ type: "verification", challenge }),
    readBody: true,
  });
  if (!result.ok) return result.category;
  let echoed: unknown;
  try {
    echoed = (JSON.parse(result.text) as { challenge?: unknown }).challenge;
  } catch {
    return "challenge_failed";
  }
  if (typeof echoed !== "string") return "challenge_failed";
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(echoed);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return "challenge_failed";
  }
  return null;
}
