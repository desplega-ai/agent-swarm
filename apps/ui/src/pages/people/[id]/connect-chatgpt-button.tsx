import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useMcpUserConfig } from "@/api/hooks/use-integrations-meta";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import { fetchDiscovery } from "@/pages/connect/connect-api";
import { DEFAULT_CONNECTOR_CONNECT_URL } from "@/pages/connect/connect-flow";

export const CONNECT_CHATGPT_HINT =
  "A new tab opens on agent-swarm.dev. Sign in there and confirm. The link expires in 10 minutes.";

function isHttps(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * One-click link to the agent-swarm.dev ChatGPT connector. It opens the same
 * `/connect` route the connector uses, with this person and connection
 * preselected and `return_to` set to the swarm's CONNECTOR_CONNECT_URL. That
 * tab mints the single-use code, so no token passes through the URL or the
 * clipboard.
 */
export function ConnectChatGptButton({ user }: { user: User }) {
  const { activeConnection } = useConfig();
  const mcpConfig = useMcpUserConfig();
  const discovery = useQuery({
    queryKey: ["connect-discovery", activeConnection?.apiUrl],
    queryFn: () => (activeConnection ? fetchDiscovery(activeConnection) : null),
    enabled: !!activeConnection,
    retry: false,
    staleTime: 60_000,
  });
  const apiOrigin = mcpConfig.data?.mcpBaseUrl;
  const httpsReady = isHttps(apiOrigin);

  function connect() {
    const params = new URLSearchParams({
      return_to: discovery.data?.connectUrl ?? DEFAULT_CONNECTOR_CONNECT_URL,
      client: "chatgpt",
      user: user.id,
    });
    if (activeConnection) params.set("connection", activeConnection.id);
    window.open(`/connect?${params.toString()}`, "_blank", "noopener");
  }

  const button = (
    <Button
      size="sm"
      variant="outline"
      onClick={connect}
      disabled={!httpsReady || discovery.isLoading}
    >
      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
      Connect to ChatGPT
    </Button>
  );

  if (httpsReady || mcpConfig.isLoading) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events, so the span carries the tooltip. */}
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        The ChatGPT connector needs an HTTPS API origin. Set PUBLIC_MCP_BASE_URL to an https:// URL
        {apiOrigin ? ` (now ${apiOrigin})` : ""}.
      </TooltipContent>
    </Tooltip>
  );
}
