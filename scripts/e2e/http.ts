export type HttpCall = { method: string; path: string; status: number };

export type ApiOptions = {
  body?: unknown;
  agentId?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
};

export type ApiResponse = {
  status: number;
  json: unknown;
  text: string;
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

export function createApiClient(baseUrl: string, runKey: string): ApiClient {
  return async (method, path, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.apiKey !== null) {
      headers.Authorization = `Bearer ${options.apiKey ?? runKey}`;
    }
    if (options.agentId) headers["X-Agent-ID"] = options.agentId;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
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
    });
    return { status: response.status, json, text };
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
