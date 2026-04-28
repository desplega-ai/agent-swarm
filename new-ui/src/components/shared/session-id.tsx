import { ExternalLink } from "lucide-react";
import type { DevinProviderMeta, ProviderName } from "@/api/types";

interface SessionIdProps {
  sessionId: string;
  provider?: ProviderName;
  providerMeta?: DevinProviderMeta | Record<string, never>;
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

  return (
    <span className="text-xs font-mono truncate" title={sessionId}>
      {sessionId.slice(0, 6)}...
    </span>
  );
}
