// Browser client for agent-fs. Method names mirror agent-fs
// `live/src/api/client.ts`, so more of `live/` can be ported later.
//
// The human's `af_` key stays inside this class (an ES private field, so it
// never lands in a query key, JSON, or devtools) and is only sent to agent-fs.
// Error messages are scrubbed, so a server that echoes the key cannot leak it
// into the page.

import { scrubSecretText } from "../scrub-secrets";
import type {
  HealthResponse,
  MeResponse,
  RegisterResponse,
  SignedUrlDisposition,
  SignedUrlResult,
} from "./types";

/** An agent-fs request failure. `status` is 0 when no response arrived. */
export class AgentFsError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AgentFsError";
    this.status = status;
    this.code = code;
  }
}

/** True for a 401: the key is unknown to agent-fs (revoked or reset). */
export function isAgentFsAuthError(error: unknown): boolean {
  return error instanceof AgentFsError && error.status === 401;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  apiKey?: string;
  signal?: AbortSignal;
}

function trimEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function redact(text: string, apiKey: string | undefined): string {
  const withoutKey = apiKey ? text.split(apiKey).join("[REDACTED]") : text;
  return scrubSecretText(withoutKey);
}

async function send(url: string, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    // Let react-query see its own cancellation.
    if (opts.signal?.aborted) throw err;
    throw new AgentFsError(0, "NETWORK", `Cannot reach agent-fs at ${originOf(url)}`);
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
    } | null;
    const code = typeof body?.error === "string" ? body.error : "UNKNOWN";
    const message =
      typeof body?.message === "string" ? body.message : `agent-fs request failed: ${res.status}`;
    throw new AgentFsError(res.status, code, redact(message, opts.apiKey));
  }
  return res;
}

export class AgentFsClient {
  readonly endpoint: string;
  readonly #apiKey: string;

  constructor(opts: { endpoint: string; apiKey: string }) {
    this.endpoint = trimEndpoint(opts.endpoint);
    this.#apiKey = opts.apiKey;
  }

  /** Create an agent-fs user. Public route. A taken email answers 409 (`CONFLICT`). */
  static async register(opts: { endpoint: string; email: string }): Promise<RegisterResponse> {
    const res = await send(`${trimEndpoint(opts.endpoint)}/auth/register`, {
      method: "POST",
      body: { email: opts.email },
    });
    return res.json() as Promise<RegisterResponse>;
  }

  /** Public `GET /health`: server version and the `features` it supports. */
  static async health(
    endpoint: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<HealthResponse> {
    const res = await send(`${trimEndpoint(endpoint)}/health`, { signal: opts.signal });
    return res.json() as Promise<HealthResponse>;
  }

  /** Run one op. The body is `{ op, ...params, driveId }`. */
  async callOp<T>(
    orgId: string,
    op: string,
    params: Record<string, unknown> = {},
    driveId?: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const body: Record<string, unknown> = { op, ...params };
    if (driveId) body.driveId = driveId;
    const res = await send(`${this.endpoint}/orgs/${encodeURIComponent(orgId)}/ops`, {
      method: "POST",
      body,
      apiKey: this.#apiKey,
      signal: opts.signal,
    });
    return res.json() as Promise<T>;
  }

  async getMe(opts: { signal?: AbortSignal } = {}): Promise<MeResponse> {
    const res = await send(`${this.endpoint}/auth/me`, {
      apiKey: this.#apiKey,
      signal: opts.signal,
    });
    return res.json() as Promise<MeResponse>;
  }

  /** The Bearer-authenticated raw bytes route. The whole path is one encoded segment. */
  getRawUrl(orgId: string, driveId: string, path: string): string {
    return `${this.endpoint}/orgs/${encodeURIComponent(orgId)}/drives/${encodeURIComponent(driveId)}/files/${encodeURIComponent(path)}/raw`;
  }

  async fetchRaw(
    orgId: string,
    driveId: string,
    path: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Blob> {
    const res = await send(this.getRawUrl(orgId, driveId, path), {
      apiKey: this.#apiKey,
      signal: opts.signal,
    });
    return res.blob();
  }

  /**
   * Mint a download URL for `path`. The server defaults `disposition` to
   * `attachment`. Pass `inline` for a URL the browser renders (a PDF, an image).
   */
  async getSignedUrl(
    orgId: string,
    driveId: string,
    path: string,
    options: { disposition?: SignedUrlDisposition; expiresIn?: number } = {},
  ): Promise<SignedUrlResult> {
    return this.callOp<SignedUrlResult>(orgId, "signed-url", { path, ...options }, driveId);
  }
}
