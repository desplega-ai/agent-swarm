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
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelativeTime } from "@/lib/utils";
import { McpOAuthPanel } from "./mcp-oauth-panel";

function TransportBadge({ transport }: { transport: string }) {
  const colors: Record<string, string> = {
    stdio: "border-blue-500/30 text-blue-400",
    http: "border-purple-500/30 text-purple-400",
    sse: "border-cyan-500/30 text-cyan-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors[transport] || ""}`}
    >
      {transport}
    </Badge>
  );
}

function ScopeBadge({ scope }: { scope: string }) {
  const colors: Record<string, string> = {
    global: "border-emerald-500/30 text-emerald-400",
    swarm: "border-amber-500/30 text-amber-400",
    agent: "border-zinc-500/30 text-zinc-400",
  };
  return (
    <Badge
      variant="outline"
      className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${colors[scope] || ""}`}
    >
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

      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">{server.name}</h1>
          <TransportBadge transport={server.transport} />
          <ScopeBadge scope={server.scope} />
          {server.authMethod === "oauth" && (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase border-purple-500/30 text-purple-400"
            >
              OAuth
            </Badge>
          )}
          <Badge
            variant="outline"
            className={`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase ${
              server.isEnabled
                ? "border-emerald-500/30 text-emerald-400"
                : "border-red-500/30 text-red-400"
            }`}
          >
            {server.isEnabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleToggleEnabled}>
            {server.isEnabled ? "Disable" : "Enable"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              >
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
        </div>
      </div>

      {server.description && (
        <p className="text-sm text-muted-foreground shrink-0">{server.description}</p>
      )}

      <Tabs value={tab} onValueChange={setTab} className="flex flex-col flex-1 min-h-0">
        <TabsList className="shrink-0">
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="auth">Authentication</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="mt-4 overflow-y-auto space-y-4">
          {/* Transport Configuration */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Transport Configuration</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Transport</span>
                <p className="uppercase">{server.transport}</p>
              </div>
              {server.transport === "stdio" && (
                <>
                  <div>
                    <span className="text-muted-foreground">Command</span>
                    <p className="font-mono text-xs">{server.command || "(not set)"}</p>
                  </div>
                  {server.args && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Arguments</span>
                      <p className="font-mono text-xs">{server.args}</p>
                    </div>
                  )}
                </>
              )}
              {(server.transport === "http" || server.transport === "sse") && (
                <>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">URL</span>
                    <p className="font-mono text-xs break-all">{server.url || "(not set)"}</p>
                  </div>
                  {server.headers && (
                    <div className="col-span-2">
                      <span className="text-muted-foreground">Headers</span>
                      <pre className="font-mono text-xs bg-muted p-2 rounded mt-1 whitespace-pre-wrap">
                        {server.headers}
                      </pre>
                    </div>
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
                  <div>
                    <span className="text-muted-foreground">Environment Config Keys</span>
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
                  </div>
                )}
                {headerKeys.length > 0 && (
                  <div>
                    <span className="text-muted-foreground">Header Config Keys</span>
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
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="auth" className="mt-4 overflow-y-auto space-y-4">
          <McpOAuthPanel server={server} />
        </TabsContent>

        <TabsContent value="metadata" className="mt-4 overflow-y-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">ID</span>
                <p className="font-mono text-xs">{server.id}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Version</span>
                <p>{server.version}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Scope</span>
                <p className="capitalize">{server.scope}</p>
              </div>
              {server.ownerAgentId && (
                <div>
                  <span className="text-muted-foreground">Owner Agent</span>
                  <p className="font-mono text-xs">{server.ownerAgentId}</p>
                </div>
              )}
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatRelativeTime(server.createdAt)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Updated</span>
                <p>{formatRelativeTime(server.lastUpdatedAt)}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
