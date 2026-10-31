export type HttpCall = { method: string; path: string; status: number; durationMs: number };

export type ApiOptions = {
  body?: unknown;
  agentId?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  /** Raw body (form, multipart, binary). Wins over `body`. */
  rawBody?: string | Uint8Array | FormData | URLSearchParams | Blob;
  /** Follow redirects (default) or return the 3xx as is. */
  redirect?: "follow" | "manual" | "error";
};

export type ApiResponse = {
  status: number;
  json: unknown;
  text: string;
  headers: Headers;
};

export type ApiClient = (
  method: string,
  path: string,
  options?: ApiOptions,
) => Promise<ApiResponse>;

const calls: HttpCall[] = [];

export function recordedHttpCalls(): readonly HttpCall[] {
  return calls;
}

/**
 * Record a call made outside the client (a raw fetch, a WebSocket upgrade, an SSE
 * stream) so it counts toward route coverage. `path` is the request pathname.
 */
export function recordHttpCall(method: string, path: string, status: number, durationMs = 0) {
  calls.push({ method: method.toUpperCase(), path, status, durationMs });
}

export function createApiClient(baseUrl: string, runKey: string): ApiClient {
  return async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.apiKey !== null) {
      headers.Authorization = `Bearer ${options.apiKey ?? runKey}`;
    }
    if (options.agentId) headers["X-Agent-ID"] = options.agentId;
    if (options.body !== undefined && options.rawBody === undefined) {
      headers["Content-Type"] = "application/json";
    }

    const started = performance.now();
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      redirect: options.redirect,
      body:
        options.rawBody !== undefined
          ? options.rawBody
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
    });
    const text = await response.text();
    const durationMs = performance.now() - started;
    const contentType = response.headers.get("content-type") ?? "";
    let json: unknown = null;
    if (contentType.includes("json") && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    calls.push({
      method: method.toUpperCase(),
      path: new URL(path, baseUrl).pathname,
      status: response.status,
      durationMs,
    });
    return { status: response.status, json, text, headers: response.headers };
  };
}

export async function pollUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectStatus(response: ApiResponse, allowed: number[], label: string): void {
  expect(
    allowed.includes(response.status),
    `${label}: expected ${allowed.join(" or ")}, got ${response.status}: ${response.text.slice(0, 300)}`,
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  expect(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "Expected an object",
  );
  return value as Record<string, unknown>;
}

/** `asRecord(value)[field]` as an array of records, or throw. */
export function asRecords(value: unknown, field: string): Record<string, unknown>[] {
  const list = asRecord(value)[field];
  expect(Array.isArray(list), `Expected ${field} to be an array`);
  return list.map(asRecord);
}

/** A string field, or throw with the field name in the message. */
export function asString(value: unknown, label: string): string {
  expect(typeof value === "string" && value.length > 0, `${label} is not a non-empty string`);
  return value;
}
