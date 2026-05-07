import { getOAuthTokens } from "../be/db-queries/oauth";
import { ensureToken } from "../oauth/ensure-token";
import { NOTION_API_BASE, NOTION_VERSION } from "./constants";

export class NotionNotConnectedError extends Error {
  readonly kind = "not_connected" as const;
  constructor() {
    super("Notion is not connected — complete OAuth at /api/trackers/notion/authorize.");
    this.name = "NotionNotConnectedError";
  }
}

export class NotionRateLimitedError extends Error {
  readonly kind = "rate_limited" as const;
  readonly retryAfterSeconds: number | null;
  constructor(retryAfterSeconds: number | null, message: string) {
    super(message);
    this.name = "NotionRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class NotionApiError extends Error {
  readonly kind = "api_error" as const;
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Authenticated Notion API call.
 *
 * - Adds `Authorization: Bearer <access_token>`, `Notion-Version`, and
 *   `Content-Type: application/json` automatically.
 * - On 401: refreshes the token once via `ensureToken("notion")` (which is
 *   no-op if no refresh token, swallows refresh errors) and retries.
 * - On 429: surfaces `NotionRateLimitedError` with `Retry-After`. Phase 1
 *   does not auto-retry on rate limits — we let the caller decide.
 * - Other non-2xx: `NotionApiError` with status + parsed code/message.
 *
 * @param path API path under `https://api.notion.com/v1` (must start with `/`).
 * @param init Standard fetch init. `body` should be JSON-serialisable; pass
 *             a string only if you have a reason.
 */
export async function notionFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith("/")) {
    throw new Error(`notionFetch path must start with "/": got ${path}`);
  }

  const tokens = getOAuthTokens("notion");
  if (!tokens) throw new NotionNotConnectedError();

  const url = `${NOTION_API_BASE}${path}`;
  const reqInit = buildRequestInit(init, tokens.accessToken);

  let response = await fetch(url, reqInit);

  if (response.status === 401) {
    // Stale token — refresh and retry once.
    await ensureToken("notion");
    const refreshed = getOAuthTokens("notion");
    if (refreshed && refreshed.accessToken !== tokens.accessToken) {
      response = await fetch(url, buildRequestInit(init, refreshed.accessToken));
    }
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : null;
    let message = `Notion rate-limited (Retry-After: ${retryAfterHeader ?? "unknown"})`;
    try {
      const body = await response.json();
      if (
        body &&
        typeof body === "object" &&
        typeof (body as { message?: unknown }).message === "string"
      ) {
        message = (body as { message: string }).message;
      }
    } catch {
      // Ignore body parse failures
    }
    throw new NotionRateLimitedError(
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      message,
    );
  }

  if (!response.ok) {
    let code: string | null = null;
    let message = `Notion API error (${response.status})`;
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown };
      if (typeof body.code === "string") code = body.code;
      if (typeof body.message === "string") message = body.message;
    } catch {
      // Fall through with default message
    }
    throw new NotionApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

function buildRequestInit(init: RequestInit, accessToken: string): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  return { ...init, headers };
}
