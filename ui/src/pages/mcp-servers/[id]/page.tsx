import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";

import { useDeleteMcpServer, useMcpServer, useUpdateMcpServer } from "@/api/hooks";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DetailPageBody,
  DetailPageRail,
  QuickStat,
  QuickStats,
  Relationship,
  Relationships,
} from "@/components/ui/detail-page-layout";
import { InfoRow } from "@/components/ui/info-row";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime } from "@/lib/utils";
import { McpOAuthPanel } from "./mcp-oauth-panel";

/**
 * See `mcp-servers/page.tsx` for token-mapping rationale (transport/scope
 * have no semantic status meaning — mapped by closest hue).
 */
function TransportBadge({ transport }: { transport: string }) {
  const colors: Record<string, string> = {
    stdio: "border-action-default/30 text-action-default",
    http: "border-action-delegate-to-agent/30 text-action-delegate-to-agent",
    sse: "border-action-script/30 text-action-script",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[transport] || ""}`}>
      {transport}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-status-success/30 text-status-success",
    swarm: "border-status-active/30 text-status-active",
    agent: "border-status-neutral/30 text-status-neutral",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[scope] || ""}`}>
      {scope}
    </Badge>
  );
}

export default function McpServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: server, isLoading } = useMcpServer(id!);
  const updateServer = useUpdateMcpServer();
  const deleteServer = useDeleteMcpServer();
  const oauthParam = searchParams.get("oauth");
  const [tab, setTab] = useState<string>(oauthParam ? "auth" : "config");

  useEffect(() => {
    if (!oauthParam) return;
    if (oauthParam === "success") {
      toast.success("OAuth connection established");
    } else if (oauthParam === "error") {
      const msg =
        searchParams.get("error_description") ||
        searchParams.get("error") ||
        "OAuth authorization failed";
      toast.error(msg);
    }
    const next = new URLSearchParams(searchParams);
    next.delete("oauth");
    next.delete("error");
    next.delete("error_description");
    setSearchParams(next, { replace: true });
  }, [oauthParam, searchParams, setSearchParams]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!server) {
    return <p className="text-muted-foreground">MCP server not found.</p>;
  }

  const handleToggleEnabled = () => {
    updateServer.mutate({ id: server.id, data: { isEnabled: !server.isEnabled } });
  };

  const handleDelete = () => {
    deleteServer.mutate(server.id, { onSuccess: () => navigate("/mcp-servers") });
  };

  const envKeys = server.envConfigKeys ? server.envConfigKeys.split(",").map((k) => k.trim()) : [];
  const headerKeys = server.headerConfigKeys
    ? server.headerConfigKeys.split(",").map((k) => k.trim())
    : [];

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden gap-3">
      <button
        type="button"
        onClick={() => navigate("/mcp-servers")}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground w-fit"
      >
        <ArrowLeft className="h-4 w-4" /> Back to MCP Servers
      </button>

      <PageHeader
        className="shrink-0"
        title={
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{server.name}</h1>
            <TransportBadge transport={server.transport} />
            <ScopeBadge scope={server.scope} />
            {server.authMethod === "oauth" && (
              <Badge
                variant="outline"
                size="tag"
                className="border-action-delegate-to-agent/30 text-action-delegate-to-agent"
              >
                OAuth
              </Badge>
            )}
            <Badge
              variant="outline"
              size="tag"
              className={`${
                server.isEnabled
                  ? "border-status-success/30 text-status-success"
                  : "border-status-error/30 text-status-error"
              }`}
            >
              {server.isEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
        }
        action={
          <>
            <Button variant="outline" size="sm" onClick={handleToggleEnabled}>
              {server.isEnabled ? "Disable" : "Enable"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive-outline" size="sm">
                  <Trash2 className="h-4 w-4 mr-1" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete MCP server "{server.name}"?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete this MCP server and uninstall it from all agents.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        }
      />

      {server.description && (
        <p className="text-sm text-muted-foreground shrink-0">{server.description}</p>
      )}

      <DetailPageBody
        className="flex-1 min-h-0"
        main={
          <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
            <TabsList className="shrink-0">
              <TabsTrigger value="config">Configuration</TabsTrigger>
              <TabsTrigger value="auth">Authentication</TabsTrigger>
            </TabsList>

            <TabsContent value="config" className="mt-4 overflow-y-auto space-y-4">
              {/* Transport Configuration */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Transport Configuration</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4 text-sm">
                  <InfoRow label="Transport">
                    <p className="uppercase">{server.transport}</p>
                  </InfoRow>
                  {server.transport === "stdio" && (
                    <>
                      <InfoRow label="Command">
                        <p className="font-mono text-xs">{server.command || "(not set)"}</p>
                      </InfoRow>
                      {server.args && (
                        <InfoRow label="Arguments" className="col-span-2">
                          <p className="font-mono text-xs">{server.args}</p>
                        </InfoRow>
                      )}
                    </>
                  )}
                  {(server.transport === "http" || server.transport === "sse") && (
                    <>
                      <InfoRow label="URL" className="col-span-2">
                        <p className="font-mono text-xs break-all">{server.url || "(not set)"}</p>
                      </InfoRow>
                      {server.headers && (
                        <InfoRow label="Headers" className="col-span-2">
                          <pre className="font-mono text-xs bg-muted p-2 rounded mt-1 whitespace-pre-wrap">
                            {server.headers}
                          </pre>
                        </InfoRow>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              {/* Secret References */}
              {(envKeys.length > 0 || headerKeys.length > 0) && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Secret References</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4 text-sm">
                    {envKeys.length > 0 && (
                      <InfoRow label="Environment Config Keys">
                        <div className="flex flex-wrap gap-1 mt-1">
                          {envKeys.map((key) => (
                            <Badge
                              key={key}
                              variant="outline"
                              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center font-mono"
                            >
                              {key}
                            </Badge>
                          ))}
                        </div>
                      </InfoRow>
                    )}
                    {headerKeys.length > 0 && (
                      <InfoRow label="Header Config Keys">
                        <div className="flex flex-wrap gap-1 mt-1">
                          {headerKeys.map((key) => (
                            <Badge
                              key={key}
                              variant="outline"
                              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center font-mono"
                            >
                              {key}
                            </Badge>
                          ))}
                        </div>
                      </InfoRow>
                    )}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="auth" className="mt-4 overflow-y-auto space-y-4">
              <McpOAuthPanel server={server} />
            </TabsContent>
          </Tabs>
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat label="ID" value={server.id} mono />
              <QuickStat label="Version" value={server.version} />
              <QuickStat
                label="Transport"
                value={<span className="uppercase">{server.transport}</span>}
              />
              <QuickStat label="Scope" value={<span className="capitalize">{server.scope}</span>} />
              <QuickStat label="Created" value={formatRelativeTime(server.createdAt)} />
              <QuickStat label="Last Updated" value={formatRelativeTime(server.lastUpdatedAt)} />
            </QuickStats>

            {server.ownerAgentId && (
              <Relationships>
                <Relationship label="Owner Agent" to={`/agents/${server.ownerAgentId}`}>
                  <span className="font-mono">{server.ownerAgentId.slice(0, 8)}…</span>
                </Relationship>
              </Relationships>
            )}
          </DetailPageRail>
        }
      />
    </div>
  );
}
