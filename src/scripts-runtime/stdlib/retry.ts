/**
 * `retry` for scripts: calls a sync or async function until it succeeds, a
 * retry is not warranted, attempts run out, or the time budget is spent.
 *
 * The quickjs executor has its own copy in `executors/quickjs-prelude.ts`
 * (it sleeps through `__host_sleep`). Keep the two in step; the executor
 * conformance tests run the same scripts against both.
 */

export type RetryOptions = {
  /** Retries after the first call. Default 3, so at most 4 calls. */
  retries?: number;
  /** First backoff delay in ms. Doubles on each retry, with jitter. Default 200. */
  minDelayMs?: number;
  /** Cap on a single wait, including a `Retry-After` wait. Default 5000. */
  maxDelayMs?: number;
  /** Total time across all calls and waits, in ms. Default 30000. */
  budgetMs?: number;
  /**
   * Decides whether to retry. Gets the thrown error or the returned value and
   * the 1-based attempt number. Replaces the default rule.
   */
  retryOn?: (errorOrResult: unknown, attempt: number) => boolean | Promise<boolean>;
  /** Stops the retries: once it aborts, the wait ends and `retry` rejects with its reason. */
  signal?: AbortSignal;
};

/** Statuses the default rule (and the swarm bridge) treat as transient. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const DEFAULTS = { retries: 3, minDelayMs: 200, maxDelayMs: 5_000, budgetMs: 30_000 };

/** Parses a `Retry-After` header (seconds or HTTP date) into ms; undefined if absent or invalid. */
export function retryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === "") return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with equal jitter: a value in [d/2, d], d = min(max, min * 2^(attempt-1)). */
export function backoffMs(attempt: number, minDelayMs: number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, minDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
}

type StatusInfo = { status: number; retryAfter?: string | null };

/**
 * Reads the status of a failed fetch `Response`, a `ctx.api` raw result
 * (`ok: false`), or a `ctx.swarm` envelope (`success: false`).
 */
function failedStatus(value: unknown): StatusInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as {
    status?: unknown;
    ok?: unknown;
    success?: unknown;
    headers?: unknown;
  };
  if (typeof candidate.status !== "number") return undefined;
  if (candidate.ok !== false && candidate.success !== false) return undefined;
  const headers = candidate.headers as
    | { get?: (name: string) => string | null }
    | Record<string, unknown>
    | undefined;
  let retryAfter: string | null | undefined;
  if (headers && typeof headers.get === "function") {
    retryAfter = (headers as { get: (name: string) => string | null }).get("retry-after");
  } else if (headers && typeof headers === "object") {
    const raw = (headers as Record<string, unknown>)["retry-after"];
    retryAfter = typeof raw === "string" ? raw : undefined;
  }
  return { status: candidate.status, retryAfter };
}

/** The default rule for a returned value: a failed response with a transient status. */
export function isRetryableResult(value: unknown): boolean {
  const info = failedStatus(value);
  return info !== undefined && RETRYABLE_STATUSES.has(info.status);
}

function checkNumber(name: string, value: unknown, fallback: number, integer = false): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`retry: \`${name}\` must be a non-negative number`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new TypeError(`retry: \`${name}\` must be a non-negative integer`);
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function retryCall<T>(
  fn: (attempt: number) => T | Promise<T>,
  options: RetryOptions = {},
): Promise<Awaited<T>> {
  if (typeof fn !== "function") throw new TypeError("retry: first argument must be a function");
  const retries = checkNumber("retries", options.retries, DEFAULTS.retries, true);
  const minDelayMs = checkNumber("minDelayMs", options.minDelayMs, DEFAULTS.minDelayMs);
  const maxDelayMs = checkNumber("maxDelayMs", options.maxDelayMs, DEFAULTS.maxDelayMs);
  const budgetMs = checkNumber("budgetMs", options.budgetMs, DEFAULTS.budgetMs);
  const retryOn = options.retryOn;
  if (retryOn !== undefined && typeof retryOn !== "function") {
    throw new TypeError("retry: `retryOn` must be a function");
  }
  const signal = options.signal;
  const started = Date.now();

  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw abortReason(signal);
    let threw = false;
    let value: unknown;
    try {
      // `await` turns a sync throw and an async rejection into the same catch.
      value = await fn(attempt);
    } catch (error) {
      threw = true;
      value = error;
    }
    const settle = (): Awaited<T> => {
      if (threw) throw value;
      return value as Awaited<T>;
    };
    if (attempt > retries) return settle();
    const again = retryOn ? await retryOn(value, attempt) : threw || isRetryableResult(value);
    if (!again) return settle();

    const info = threw ? undefined : failedStatus(value);
    const waitFor = info?.status === 429 ? retryAfterMs(info.retryAfter) : undefined;
    const delay =
      waitFor !== undefined
        ? Math.min(maxDelayMs, waitFor)
        : backoffMs(attempt, minDelayMs, maxDelayMs);
    if (Date.now() - started + delay > budgetMs) return settle();
    await sleep(delay, signal);
  }
}

function wrap<A extends unknown[], T>(
  fn: (...args: A) => T | Promise<T>,
  options?: RetryOptions,
): (...args: A) => Promise<Awaited<T>> {
  if (typeof fn !== "function")
    throw new TypeError("retry.wrap: first argument must be a function");
  return (...args: A) => retryCall(() => fn(...args), options);
}

export const retry = Object.assign(retryCall, { wrap });
