import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useServices } from "@/api/hooks/use-services";
import { useAgents } from "@/api/hooks/use-agents";
import { formatSmartTime, cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Server, ExternalLink } from "lucide-react";
import type { ServiceStatus } from "@/api/types";

const statusColors: Record<ServiceStatus, string> = {
  healthy: "bg-emerald-500",
  unhealthy: "bg-red-500",
  starting: "bg-yellow-500",
  stopped: "bg-zinc-500",
};

const statusLabels: Record<ServiceStatus, string> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  starting: "Starting",
  stopped: "Stopped",
};

export default function ServicesPage() {
  const { data: services, isLoading } = useServices();
  const { data: agents } = useAgents();

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    agents?.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [agents]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-2xl font-bold">Services</h1>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="font-display text-2xl font-bold">Services</h1>

      {services && services.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {services.map((svc) => (
            <Card key={svc.id} className="hover:border-amber-500/30 transition-colors">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        statusColors[svc.status] ?? "bg-zinc-500",
                        svc.status === "starting" && "animate-pulse",
                      )}
                    />
                    <span className="font-semibold">{svc.name}</span>
                  </div>
                  <Badge variant="outline" className="text-[10px]">
                    {statusLabels[svc.status] ?? svc.status}
                  </Badge>
                </div>

                {svc.description && (
                  <p className="text-sm text-muted-foreground">{svc.description}</p>
                )}

                <div className="space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground/60">Agent:</span>
                    <Link
                      to={`/agents/${svc.agentId}`}
                      className="text-amber-400 hover:underline"
                    >
                      {agentMap.get(svc.agentId) ?? svc.agentId.slice(0, 8) + "..."}
                    </Link>
                  </div>

                  <div>
                    <span className="text-muted-foreground/60">Port:</span>{" "}
                    <span className="font-mono">{svc.port}</span>
                  </div>

                  {svc.url && (
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground/60">URL:</span>
                      <a
                        href={svc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-amber-400 hover:underline inline-flex items-center gap-0.5"
                      >
                        {svc.url}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  )}

                  <div>
                    <span className="text-muted-foreground/60">Updated:</span>{" "}
                    {formatSmartTime(svc.lastUpdatedAt)}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Server className="h-8 w-8 mb-2" />
          <p className="text-sm">No services registered</p>
        </div>
      )}
    </div>
  );
}
