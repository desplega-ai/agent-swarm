import { useQuery } from "@tanstack/react-query";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Jira tracker status hook
//
// Wraps `GET /api/trackers/jira/status`. Response shape (from
// `src/http/trackers/jira.ts`):
//
//   {
//     provider: "jira",
//     connected: boolean,
//     cloudId: string | null,
//     siteUrl: string | null,
//     tokenExpiresAt: string | null,    // ISO-8601
//     scope: string | null,             // space-separated by Atlassian
//     hasManageWebhookScope: boolean,
//     webhookTokenConfigured: boolean,  // is JIRA_WEBHOOK_TOKEN set?
//     webhookUrl: string,               // <MCP_BASE_URL>/api/trackers/jira/webhook/<token>
//     webhookIds: { id: number; expiresAt: string; jql: string }[],
//     manualWebhookInstructions?: string,
//   }
//
// Returns 503 when JIRA_DISABLE=true or required Jira env vars aren't set —
// surface as a soft `notConfigured: true` so the UI can render an explainer
// instead of throwing.
// ---------------------------------------------------------------------------

export interface JiraWebhookEntry {
  id: number;
  expiresAt: string;
  jql: string;
}

export interface JiraTrackerStatus {
  provider: "jira";
  connected: boolean;
  cloudId: string | null;
  siteUrl: string | null;
  tokenExpiresAt: string | null;
  scope: string | null;
  hasManageWebhookScope: boolean;
  webhookTokenConfigured: boolean;
  webhookUrl: string;
  webhookIds: JiraWebhookEntry[];
  manualWebhookInstructions?: string;
  /** True when GET /status returned 503 — Jira isn't enabled on the server. */
  notConfigured?: boolean;
}

function getBaseUrl(): string {
  const config = getConfig();
  if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") {
    return "";
  }
  return config.apiUrl;
}

function getHeaders(): HeadersInit {
  const config = getConfig();
  const headers: HeadersInit = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

async function fetchJiraStatus(): Promise<JiraTrackerStatus> {
  const url = `${getBaseUrl()}/api/trackers/jira/status`;
  const res = await fetch(url, { headers: getHeaders() });

  if (res.status === 503) {
    return {
      provider: "jira",
      connected: false,
      cloudId: null,
      siteUrl: null,
      tokenExpiresAt: null,
      scope: null,
      hasManageWebhookScope: false,
      webhookTokenConfigured: false,
      webhookUrl: "",
      webhookIds: [],
      notConfigured: true,
    };
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch Jira status: ${res.status}`);
  }

  return (await res.json()) as JiraTrackerStatus;
}

export function useJiraTrackerStatus() {
  return useQuery({
    queryKey: ["jira", "tracker", "status"],
    queryFn: fetchJiraStatus,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Absolute authorize URL — callers set `window.location.href = buildJiraAuthorizeUrl()`. */
export function buildJiraAuthorizeUrl(): string {
  return `${getBaseUrl()}/api/trackers/jira/authorize`;
}
