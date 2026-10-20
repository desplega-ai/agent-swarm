import { getOpenRouterAttributionHeaders } from "../../utils/openrouter-base-url";
import {
  type SystemOneCapability,
  type SystemOneHostId,
  systemOneKeyRejectedMessage,
} from "./system-one-providers";
import { cloudflareErrorCode, isRecord } from "./system-one-wire";

/**
 * One POST to a System One host, shared by every capability (`system-one-decision`,
 * `system-one-extraction`): one time budget, transient retries with backoff,
 * `Retry-After`, redirect refusal, a response size cap, and the same error
 * sentences. The credential goes only into the `authorization` header.
 */

export const SYSTEM_ONE_DEFAULT_TIMEOUT_MS = 30_000;
export const SYSTEM_ONE_MIN_TIMEOUT_MS = 1_000;
export const SYSTEM_ONE_MAX_TIMEOUT_MS = 300_000;
export const SYSTEM_ONE_DEFAULT_MAX_RETRIES = 2;
export const SYSTEM_ONE_MAX_RETRIES_LIMIT = 3;

/** Room left before the engine watchdog fires so the executor can report its own failure. */
const DEADLINE_MARGIN_MS = 250;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
const MAX_RESPONSE_CHARS = 1_048_576;
const MAX_ERROR_BODY_CHARS = 65_536;

export interface SystemOneTransportOptions {
  /** Transport. Tests inject a fake; production uses the global `fetch`. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface SystemOneRequest {
  providerId: SystemOneHostId;
  capability: SystemOneCapability;
  endpoint: string;
  apiKey: string;
  /** The secret name the key was read under, named when the host rejects it. */
  keyName: string;
  body: string;
  timeoutMs: number;
  maxRetries: number;
  env: NodeJS.ProcessEnv;
}

export type SystemOneSendResult =
  | { ok: true; text: string; requestId?: string }
  | { ok: false; error: string };

type Attempt =
  | { kind: "ok"; text: string; requestId?: string }
  | { kind: "timeout" }
  | { kind: "fail"; message: string; retryable: boolean; retryAfterMs?: number };

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

function readRequestId(headers: Headers): string | undefined {
  // Cloudflare marks every response with `cf-ray` and sends no request id.
  const value = headers.get("x-request-id") ?? headers.get("request-id") ?? headers.get("cf-ray");
  return value && REQUEST_ID_RE.test(value) ? value : undefined;
}

/** Retry-After as delta-seconds or an HTTP date, in ms. Undefined when absent or unparseable. */
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Only a short identifier from the provider's error envelope. Never its message or echoed request. */
function readErrorCode(text: string): string | undefined {
  if (text.length === 0 || text.length > MAX_ERROR_BODY_CHARS) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const nested = isRecord(parsed.error) ? parsed.error : undefined;
  const detail = isRecord(parsed.detail) ? parsed.detail : undefined;
  for (const candidate of [
    nested?.code,
    nested?.type,
    detail?.error_type,
    parsed.code,
    parsed.type,
  ]) {
    if (typeof candidate === "string" && ERROR_CODE_RE.test(candidate)) return candidate;
  }
  // Cloudflare's envelope: `{ success: false, errors: [{ code: 10000, message }] }`.
  return cloudflareErrorCode(parsed);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * POST once, retrying only transient failures inside one time budget.
 * Retries: connection errors, HTTP 408 / 429 / 5xx (incl. 529). Never: 401, 422,
 * other 4xx, redirects, or a bad success body (the caller validates that).
 */
export async function sendSystemOneRequest(
  request: SystemOneRequest,
  options: SystemOneTransportOptions = {},
): Promise<SystemOneSendResult> {
  const { timeoutMs, maxRetries } = request;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  const deadlineAt = now() + timeoutMs - DEADLINE_MARGIN_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - now()));
  const timedOut = () =>
    ({
      ok: false,
      error: `SystemOne request exceeded its ${timeoutMs}ms time budget`,
    }) as const;

  try {
    for (let attempt = 0; ; attempt++) {
      const result = await attemptOnce(doFetch, request, controller.signal, now);
      if (result.kind === "ok") {
        return { ok: true, text: result.text, requestId: result.requestId };
      }
      if (result.kind === "timeout" || controller.signal.aborted) return timedOut();

      const attempts = attempt + 1;
      const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
      if (!result.retryable || attempt >= maxRetries) {
        return { ok: false, error: `${result.message}${suffix}` };
      }

      const backoff = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      const delay = result.retryAfterMs ?? Math.round(backoff * (0.5 + random() * 0.5));
      if (delay >= deadlineAt - now()) {
        return {
          ok: false,
          error: `${result.message}${suffix}; the ${delay}ms retry delay does not fit the ${timeoutMs}ms time budget`,
        };
      }
      await sleep(delay, controller.signal);
      if (controller.signal.aborted) return timedOut();
    }
  } finally {
    clearTimeout(timer);
  }
}

async function attemptOnce(
  doFetch: typeof fetch,
  request: SystemOneRequest,
  signal: AbortSignal,
  now: () => number,
): Promise<Attempt> {
  const { endpoint, apiKey, body } = request;
  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        ...getOpenRouterAttributionHeaders(endpoint, request.env),
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
      redirect: "manual",
      signal,
    });
  } catch (err) {
    if (signal.aborted) return { kind: "timeout" };
    const code = (err as { code?: unknown })?.code;
    const detail = typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? ` (${code})` : "";
    return {
      kind: "fail",
      message: `SystemOne request failed: network error${detail}`,
      retryable: true,
    };
  }

  const requestId = readRequestId(res.headers);
  const withId = (message: string) => (requestId ? `${message} [request ${requestId}]` : message);

  if (res.status >= 200 && res.status < 300) {
    let text: string;
    try {
      text = await res.text();
    } catch {
      if (signal.aborted) return { kind: "timeout" };
      return {
        kind: "fail",
        message: withId("SystemOne response body could not be read"),
        retryable: true,
      };
    }
    if (text.length > MAX_RESPONSE_CHARS) {
      return {
        kind: "fail",
        message: withId("SystemOne response exceeded the size limit"),
        retryable: false,
      };
    }
    return { kind: "ok", text, requestId };
  }

  if (res.status >= 300 && res.status < 400) {
    return {
      kind: "fail",
      message: withId(
        `SystemOne request was redirected (HTTP ${res.status}); redirects are refused`,
      ),
      retryable: false,
    };
  }

  let errorText = "";
  try {
    errorText = await res.text();
  } catch {
    if (signal.aborted) return { kind: "timeout" };
  }
  const code = readErrorCode(errorText);
  // The host answered but does not accept the key: name it, never retry.
  if (res.status === 401 || res.status === 403) {
    return {
      kind: "fail",
      message: withId(
        systemOneKeyRejectedMessage(request.providerId, res.status, code, {
          keyName: request.keyName,
          capability: request.capability,
        }),
      ),
      retryable: false,
    };
  }
  const detail = code ? ` (${code})` : "";
  const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
  return {
    kind: "fail",
    message: withId(`SystemOne API returned HTTP ${res.status}${detail}`),
    retryable,
    retryAfterMs: retryable ? parseRetryAfter(res.headers.get("retry-after"), now()) : undefined,
  };
}
