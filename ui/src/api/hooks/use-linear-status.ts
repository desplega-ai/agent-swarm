import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Linear tracker status hook
//
// Wraps the existing `GET /api/trackers/linear/status` endpoint. Response shape
// (from `src/http/trackers/linear.ts` `handleLinearTracker`):
//
//   {
//     provider: "linear",
//     connected: boolean,
//     tokenExpiry: number | null,   // ms-since-epoch OR unix seconds (see note)
//     scope: string | null,         // space/comma-separated OAuth scope list
//     webhookUrl: string,           // "<MCP_BASE_URL>/api/trackers/linear/webhook"
//   }
//
// NOTE on tokenExpiry: the server passes through `tokens.expiresAt` verbatim,
// which is whatever `src/be/db-queries/oauth.ts` stored at callback time. We
// surface it as a nullable number and let consumers format defensively.
//
// The endpoint returns 503 when `LINEAR_DISABLE` is true or required Linear env
// vars aren't set. We map that to a soft "not configured" result so the UI can
// render the explainer card without throwing.
// ---------------------------------------------------------------------------

export interface LinearTrackerStatus {
  provider: "linear";
  connected: boolean;
  tokenExpiry: number | null;
  scope: string | null;
  webhookUrl: string;
  /** Computed callback URL — paste into Linear app's Callback URLs. */
  redirectUri: string;
  /** True when `GET /status` returned 503 — Linear isn't enabled on the server. */
  notConfigured?: boolean;
}

export interface LinearDisconnectResult {
  disconnected: boolean;
  revoked: boolean;
}

function getBaseUrl(): string {
  const config = getConfig();
  // Match ApiClient behaviour: in DEV with default apiUrl, let Vite proxy relative paths.
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

async function fetchLinearStatus(): Promise<LinearTrackerStatus> {
  const url = `${getBaseUrl()}/api/trackers/linear/status`;
  const res = await fetch(url, { headers: getHeaders() });

  if (res.status === 503) {
    // Linear not enabled server-side — return a soft "not configured" marker
    // instead of throwing so the UI can render a helpful message.
    return {
      provider: "linear",
      connected: false,
      tokenExpiry: null,
      scope: null,
      webhookUrl: "",
      redirectUri: "",
      notConfigured: true,
    };
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch Linear status: ${res.status}`);
  }

  const data = (await res.json()) as LinearTrackerStatus;
  return data;
}

export function useLinearTrackerStatus() {
  return useQuery({
    queryKey: ["linear", "tracker", "status"],
    queryFn: fetchLinearStatus,
    // Connection state changes only via OAuth redirect; avoid aggressive polling.
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

/** Absolute authorize URL — callers open it in a new tab via `window.open`. */
export function buildLinearAuthorizeUrl(): string {
  return `${getBaseUrl()}/api/trackers/linear/authorize`;
}

/**
 * Mutation hook for `DELETE /api/trackers/linear/disconnect`. On success, the
 * status query is invalidated so the card immediately reflects the
 * disconnected state.
 */
export function useDisconnectLinear() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<LinearDisconnectResult> => {
      const res = await fetch(`${getBaseUrl()}/api/trackers/linear/disconnect`, {
        method: "DELETE",
        headers: getHeaders(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Disconnect failed (${res.status}): ${text}`);
      }
      return (await res.json()) as LinearDisconnectResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["linear", "tracker", "status"] });
    },
  });
}
