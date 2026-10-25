import { AlertTriangle, Network } from "lucide-react";
import { AlertCallout } from "@/components/ui/alert-callout";
import { connectionName } from "@/lib/config";
import { isSafari, needsLocalNetworkPermission } from "@/lib/local-network";

/**
 * The hosted (https) dashboard and an API on this machine or the local
 * network: Chrome 142+ and Firefox ask the user first, Safari blocks it.
 */
function localNetworkCase(apiUrl: string): "prompt" | "safari" | null {
  if (!needsLocalNetworkPermission(apiUrl, window.location.href)) return null;
  return isSafari(navigator.userAgent) ? "safari" : "prompt";
}

const SAFARI_HELP = (
  <>
    Safari does not let this page reach a local address. Open it in Chrome or Firefox, or install
    with <code className="font-mono">--tunnel</code>.
  </>
);

/** Before a connect: what the browser does with a local API URL. Null for any other URL. */
export function LocalNetworkNotice({ apiUrl }: { apiUrl: string }) {
  const kind = localNetworkCase(apiUrl);
  if (kind === "safari") {
    return (
      <AlertCallout tone="warning" icon={AlertTriangle} title="Safari blocks local addresses">
        {SAFARI_HELP}
      </AlertCallout>
    );
  }
  if (kind === "prompt") {
    return (
      <AlertCallout
        tone="info"
        icon={Network}
        title="Your browser will ask for local network access"
      >
        Choose Allow, so this page can reach your swarm at {connectionName(apiUrl)}.
      </AlertCallout>
    );
  }
  return null;
}

/** After a network error on a local API URL: how to fix it. Null for any other URL. */
export function LocalNetworkHelp({ apiUrl }: { apiUrl: string }) {
  const kind = localNetworkCase(apiUrl);
  if (!kind) return null;
  return (
    <p className="mt-1">
      {kind === "safari"
        ? SAFARI_HELP
        : "If you chose Block when the browser asked for local network access, allow it in the site settings (left of the address bar), then retry."}
    </p>
  );
}
