/**
 * Thin REST client for Devin v3 API endpoints.
 *
 * All functions authenticate via Bearer token and target the organization-scoped
 * v3 routes. The base URL defaults to `https://api.devin.ai` but can be
 * overridden via `DEVIN_API_BASE_URL` for testing or on-prem deployments.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DevinSessionStatus =
  | "new"
  | "creating"
  | "claimed"
  | "running"
  | "exit"
  | "error"
  | "suspended"
  | "resuming";

export type DevinStatusDetail =
  | "working"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "finished"
  | "inactivity"
  | "user_request"
  | "usage_limit_exceeded"
  | "out_of_credits"
  | "out_of_quota"
  | "no_quota_allocation"
  | "payment_declined"
  | "org_usage_limit_exceeded"
  | "error";

export interface DevinSessionCreateRequest {
  prompt: string;
  playbook_id?: string;
  repos?: string[];
  structured_output_schema?: object;
  tags?: string[];
  title?: string;
  max_acu_limit?: number;
  bypass_approval?: boolean;
  session_secrets?: Array<{ key: string; value: string; sensitive?: boolean }>;
}

export interface DevinSessionResponse {
  session_id: string;
  url: string;
  status: DevinSessionStatus;
  status_detail?: DevinStatusDetail;
  structured_output?: unknown;
  pull_requests?: Array<{ pr_url: string; pr_state: string }>;
  acus_consumed?: number;
  title?: string;
  tags?: string[];
  created_at: number;
  updated_at: number;
}

export interface DevinSessionMessage {
  event_id: string;
  source: "devin" | "user";
  message: string;
  created_at: number;
}

export interface DevinMessagesResponse {
  items: DevinSessionMessage[];
  end_cursor: string | null;
  has_next_page: boolean;
  total: number | null;
}

export interface DevinPlaybookCreateRequest {
  title: string;
  body: string;
}

export interface DevinPlaybookResponse {
  playbook_id: string;
  title: string;
  body: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseUrl(): string {
  return process.env.DEVIN_API_BASE_URL ?? "https://api.devin.ai";
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function assertOk(res: Response, label: string): Promise<void> {
  if (!res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      // Ignore read errors.
    }
    throw new Error(`[devin-api] ${label} failed: HTTP ${res.status} — ${body}`);
  }
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/** Create a new Devin session. */
export async function createSession(
  orgId: string,
  apiKey: string,
  request: DevinSessionCreateRequest,
): Promise<DevinSessionResponse> {
  const res = await fetch(`${baseUrl()}/v3/organizations/${orgId}/sessions`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(request),
  });
  await assertOk(res, "createSession");
  return (await res.json()) as DevinSessionResponse;
}

/** Get the current state of a Devin session. */
export async function getSession(
  orgId: string,
  apiKey: string,
  sessionId: string,
): Promise<DevinSessionResponse> {
  const res = await fetch(`${baseUrl()}/v3/organizations/${orgId}/sessions/${sessionId}`, {
    method: "GET",
    headers: headers(apiKey),
  });
  await assertOk(res, "getSession");
  return (await res.json()) as DevinSessionResponse;
}

/** Send a message to a running Devin session. */
export async function sendMessage(
  orgId: string,
  apiKey: string,
  sessionId: string,
  message: string,
): Promise<void> {
  const res = await fetch(`${baseUrl()}/v3/organizations/${orgId}/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ message }),
  });
  await assertOk(res, "sendMessage");
}

/** Archive (terminate) a Devin session. */
export async function archiveSession(
  orgId: string,
  apiKey: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(`${baseUrl()}/v3/organizations/${orgId}/sessions/${sessionId}/archive`, {
    method: "POST",
    headers: headers(apiKey),
  });
  await assertOk(res, "archiveSession");
}

/** Fetch session messages (cursor-based pagination). */
export async function getSessionMessages(
  orgId: string,
  apiKey: string,
  sessionId: string,
  after?: string,
): Promise<DevinMessagesResponse> {
  const params = new URLSearchParams({ first: "200" });
  if (after) params.set("after", after);
  const res = await fetch(
    `${baseUrl()}/v3/organizations/${orgId}/sessions/${sessionId}/messages?${params}`,
    { method: "GET", headers: headers(apiKey) },
  );
  await assertOk(res, "getSessionMessages");
  return (await res.json()) as DevinMessagesResponse;
}

/** Create a new playbook. */
export async function createPlaybook(
  orgId: string,
  apiKey: string,
  request: DevinPlaybookCreateRequest,
): Promise<DevinPlaybookResponse> {
  const res = await fetch(`${baseUrl()}/v3/organizations/${orgId}/playbooks`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(request),
  });
  await assertOk(res, "createPlaybook");
  return (await res.json()) as DevinPlaybookResponse;
}
