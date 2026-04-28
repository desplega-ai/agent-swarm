import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  /** Computed callback URL — paste into Atlassian app's Authorization callback. */
  redirectUri: string;
  webhookIds: JiraWebhookEntry[];
  manualWebhookInstructions?: string;
  /** True when GET /status returned 503 — Jira isn't enabled on the server. */
  notConfigured?: boolean;
}

export interface JiraDisconnectResult {
  disconnected: boolean;
  webhooksDeleted: number;
  webhooksTotal: number;
  webhookFailures: Array<{ id: number; error: string }>;
  revokeNote: string;
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
      redirectUri: "",
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

/** Absolute authorize URL — callers open it in a new tab via `window.open`. */
export function buildJiraAuthorizeUrl(): string {
  return `${getBaseUrl()}/api/trackers/jira/authorize`;
}

/**
 * Mutation hook for `DELETE /api/trackers/jira/disconnect`. On success, the
 * status query is invalidated so the card immediately reflects the
 * disconnected state.
 */
export function useDisconnectJira() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<JiraDisconnectResult> => {
      const res = await fetch(`${getBaseUrl()}/api/trackers/jira/disconnect`, {
        method: "DELETE",
        headers: getHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Disconnect failed (${res.status}): ${text}`);
      }
      return (await res.json()) as JiraDisconnectResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["jira", "tracker", "status"] });
    },
  });
}
