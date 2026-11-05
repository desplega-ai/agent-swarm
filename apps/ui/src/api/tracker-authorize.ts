import { getConfig } from "@/lib/config";

export type TrackerProvider = "linear" | "jira";

function getBaseUrl(): string {
  const config = getConfig();
  // Match ApiClient behaviour: in DEV with default apiUrl, let Vite proxy relative paths.
  if (import.meta.env.DEV && config.apiUrl === "http://localhost:3013") {
    return "";
  }
  return config.apiUrl.replace(/\/+$/, "");
}

/**
 * Ask the API for the tracker's OAuth consent URL. Starting the flow needs the
 * bearer (it binds the swarm-wide default authorization), and a plain browser
 * navigation can't send one, so the dashboard fetches the URL with
 * `format=json` and navigates to the provider itself.
 *
 * `finalRedirect` is where the API sends the browser after the callback.
 */
export async function fetchTrackerAuthorizeUrl(
  provider: TrackerProvider,
  finalRedirect?: string,
): Promise<string> {
  const params = new URLSearchParams({ format: "json" });
  if (finalRedirect) params.set("redirect", finalRedirect);
  const config = getConfig();
  const res = await fetch(`${getBaseUrl()}/api/trackers/${provider}/authorize?${params}`, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Failed to start OAuth (${res.status})`);
  }
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  return authorizeUrl;
}

/**
 * Open the consent screen in a new tab. The tab is opened synchronously inside
 * the click gesture (popup blockers drop a window opened after an await), then
 * pointed at the consent URL once it arrives.
 */
export async function openTrackerAuthorizeInNewTab(provider: TrackerProvider): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const url = await fetchTrackerAuthorizeUrl(provider);
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  } catch (err) {
    tab?.close();
    throw err;
  }
}
