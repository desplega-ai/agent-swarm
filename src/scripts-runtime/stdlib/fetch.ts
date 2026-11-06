import { type RetryOptions, retry } from "./retry";

export type FetchRetryOptions = RetryOptions & {
  /**
   * Sends an `Idempotency-Key` header, the same value on every attempt: `true`
   * generates a UUID per call, a string is used as is. A POST or PATCH with
   * the header also retries 502/503/504 and network errors. The key only
   * prevents a duplicate when the server dedupes by it.
   */
  idempotencyKey?: boolean | string;
};

export type RuntimeFetchOptions = RequestInit & {
  /** `false`: one attempt. `true` or omitted: method-aware defaults. An object tunes them. */
  retry?: boolean | FetchRetryOptions;
  /** @deprecated Use `retry: { retries }`. Total attempts, so `retries: 1` is one attempt. */
  retries?: number;
  /** Per-attempt timeout. Default 30000. */
  timeoutMs?: number;
};

/** Methods a server must treat as idempotent, so a repeat after a 5xx is safe. */
export const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "DELETE",
]);
const TRANSIENT_5XX = new Set([502, 503, 504]);

/**
 * Default fetch retry rule. 429 always retries (the server refused before any
 * work). 502/503/504 and network errors retry only when a repeat is safe: an
 * idempotent method, or a request carrying an `Idempotency-Key`.
 */
export function shouldRetryFetch(value: unknown, repeatSafe: boolean): boolean {
  if (value instanceof Response) {
    return value.status === 429 || (repeatSafe && TRANSIENT_5XX.has(value.status));
  }
  return repeatSafe;
}

/** A body that fetch can send again. A stream or async iterable is read once. */
function isReplayableBody(body: unknown): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof Blob ||
    body instanceof FormData
  );
}

function resolveRetry(
  option: RuntimeFetchOptions["retry"],
  legacyAttempts: number | undefined,
): FetchRetryOptions {
  if (option === false) return { retries: 0 };
  if (option && typeof option === "object") return option;
  if (option === undefined && legacyAttempts !== undefined) {
    return { retries: Math.max(0, legacyAttempts - 1) };
  }
  return {};
}

export async function runtimeFetch(
  input: string | URL | Request,
  options: RuntimeFetchOptions = {},
): Promise<Response> {
  const {
    retry: retryOption,
    retries: legacyAttempts,
    timeoutMs = 30_000,
    signal,
    ...init
  } = options;
  const {
    idempotencyKey,
    retryOn: userRetryOn,
    ...retryOptions
  } = resolveRetry(retryOption, legacyAttempts);
  const inputRequest = input instanceof Request ? input : undefined;

  if (idempotencyKey) {
    const headers = new Headers(init.headers ?? inputRequest?.headers);
    if (!headers.has("idempotency-key")) {
      headers.set(
        "idempotency-key",
        idempotencyKey === true ? crypto.randomUUID() : String(idempotencyKey),
      );
    }
    init.headers = headers;
  }
  const method = (init.method ?? inputRequest?.method ?? "GET").toUpperCase();
  const hasKey = new Headers(init.headers ?? inputRequest?.headers).has("idempotency-key");
  const repeatSafe = IDEMPOTENT_METHODS.has(method) || hasKey;
  const replayable =
    init.body !== undefined
      ? isReplayableBody(init.body)
      : !inputRequest || inputRequest.body === null || !inputRequest.bodyUsed;
  // A Request with an unread body is cloned per attempt; the clone tees it.
  const target = (): string | URL | Request =>
    inputRequest && inputRequest.body !== null ? (inputRequest.clone() as Request) : input;

  const attempt = async (): Promise<Response> => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      return await fetch(target(), { ...init, signal: controller.signal });
    } catch (error) {
      // Caller abort is terminal; the retry rule below sees `signal.aborted`.
      if (signal?.aborted) throw signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  };

  if (!replayable) return attempt();
  return retry(attempt, {
    ...retryOptions,
    signal: signal ?? retryOptions.signal,
    retryOn: async (value, attemptNumber) => {
      if (signal?.aborted) return false;
      if (userRetryOn) return userRetryOn(value, attemptNumber);
      return shouldRetryFetch(value, repeatSafe);
    },
  });
}

export async function runtimeFetchJson(
  input: string | URL | Request,
  options: RuntimeFetchOptions = {},
): Promise<unknown> {
  const res = await runtimeFetch(input, options);
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return await res.json();
  return await res.text();
}
