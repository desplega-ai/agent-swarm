import { ExternalLink } from "lucide-react";
import type { ClaudeProviderMeta, DevinProviderMeta, ProviderName } from "@/api/types";
import { MiddleTruncation } from "@/components/ui/middle-truncation";

interface SessionIdProps {
  sessionId: string;
  provider?: ProviderName;
  providerMeta?: DevinProviderMeta | ClaudeProviderMeta | Record<string, never>;
}

export function SessionId({ sessionId, provider, providerMeta }: SessionIdProps) {
  if (provider === "devin" && providerMeta && "sessionUrl" in providerMeta) {
    return (
      <a
        href={providerMeta.sessionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline font-mono text-xs inline-flex items-center gap-1"
      >
        {sessionId.slice(0, 6)}...
        <ExternalLink className="h-3 w-3" />
      </a>
    );
  }

  return <MiddleTruncation className="text-xs font-mono">{sessionId}</MiddleTruncation>;
}
