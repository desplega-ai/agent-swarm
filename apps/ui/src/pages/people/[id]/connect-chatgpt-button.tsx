import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { useMcpUserConfig } from "@/api/hooks/use-integrations-meta";
import { useCreateConnectorCode } from "@/api/hooks/use-users";
import type { User } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
 * One-click link to the agent-swarm.dev ChatGPT connector. The server returns
 * a 10-minute single-use code; the connector trades it for a token, so no
 * token passes through the URL or the clipboard.
 */
export function ConnectChatGptButton({ user }: { user: User }) {
  const createCode = useCreateConnectorCode();
  const mcpConfig = useMcpUserConfig();
  const apiOrigin = mcpConfig.data?.mcpBaseUrl;
  const httpsReady = isHttps(apiOrigin);

  async function connect() {
    // Open the tab inside the click handler so popup blockers allow it, then
    // point it at the connect URL once the code exists.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const { connectUrl } = await createCode.mutateAsync({ id: user.id });
      if (tab && !tab.closed) {
        tab.location.href = connectUrl;
      } else {
        window.open(connectUrl, "_blank", "noopener");
      }
    } catch (err) {
      tab?.close();
      toast.error(err instanceof Error ? err.message : "Failed to create connect link");
    }
  }

  const button = (
    <Button
      size="sm"
      variant="outline"
      onClick={connect}
      disabled={!httpsReady || createCode.isPending}
    >
      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
      {createCode.isPending ? "Opening..." : "Connect to ChatGPT"}
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
