import { AlertCircle, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  useDisconnectMcpOAuth,
  useMcpOAuthMetadata,
  useMcpOAuthStatus,
  useRefreshMcpOAuth,
  useRegisterMcpOAuthManualClient,
  useStartMcpOAuthConnect,
} from "@/api/hooks";
import type { McpOAuthStatus, McpServer } from "@/api/types";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/utils";

function AuthMethodBadge({ method }: { method: McpServer["authMethod"] }) {
  const colors: Record<string, string> = {
    static: "border-zinc-500/30 text-zinc-400",
    oauth: "border-purple-500/30 text-purple-400",
    auto: "border-sky-500/30 text-sky-400",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[method] || ""}`}>
      {method}
    </Badge>
  );
}

function OAuthStatusBadge({ status }: { status: McpOAuthStatus }) {
  const colors: Record<McpOAuthStatus, string> = {
    connected: "border-emerald-500/30 text-emerald-400",
    expired: "border-amber-500/30 text-amber-400",
    revoked: "border-zinc-500/30 text-zinc-400",
    error: "border-red-500/30 text-red-400",
  };
  return (
    <Badge variant="outline" size="tag" className={`${colors[status] || ""}`}>
      {status}
    </Badge>
  );
}

interface ManualClientDialogProps {
  mcpServerId: string;
}

function ManualClientDialog({ mcpServerId }: ManualClientDialogProps) {
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [issuer, setIssuer] = useState("");
  const [scopes, setScopes] = useState("");
  const register = useRegisterMcpOAuthManualClient();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId) {
      toast.error("Client ID is required");
      return;
    }
    register.mutate(
      {
        mcpServerId,
        data: {
          clientId,
          clientSecret: clientSecret || undefined,
          authorizeUrl: authorizeUrl || undefined,
          tokenUrl: tokenUrl || undefined,
          authorizationServerIssuer: issuer || undefined,
          scopes: scopes
            ? scopes
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
        },
      },
      {
        onSuccess: () => {
          toast.success("Manual OAuth client registered");
          setOpen(false);
        },
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Register manual client
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Register OAuth client manually</DialogTitle>
            <DialogDescription>
              Use this if the provider does not support Dynamic Client Registration (DCR). You must
              register your redirect URI with the provider as shown in the authorize URL the swarm
              opens.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1">
              <Label htmlFor="oauth-client-id">Client ID *</Label>
              <Input
                id="oauth-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oauth-client-secret">Client secret</Label>
              <Input
                id="oauth-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="(optional for public clients)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oauth-issuer">Authorization server issuer</Label>
              <Input
                id="oauth-issuer"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                placeholder="https://auth.example.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oauth-authorize-url">Authorize URL</Label>
              <Input
                id="oauth-authorize-url"
                value={authorizeUrl}
                onChange={(e) => setAuthorizeUrl(e.target.value)}
                placeholder="https://auth.example.com/oauth/authorize"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oauth-token-url">Token URL</Label>
              <Input
                id="oauth-token-url"
                value={tokenUrl}
                onChange={(e) => setTokenUrl(e.target.value)}
                placeholder="https://auth.example.com/oauth/token"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="oauth-scopes">Scopes</Label>
              <Input
                id="oauth-scopes"
                value={scopes}
                onChange={(e) => setScopes(e.target.value)}
                placeholder="read write (space- or comma-separated)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={register.isPending}>
              {register.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function McpOAuthPanel({ server }: { server: McpServer }) {
  const supportsOAuth = server.transport === "http" || server.transport === "sse";
  const enabled = supportsOAuth;
  const {
    data: statusData,
    isLoading: statusLoading,
    error: statusError,
  } = useMcpOAuthStatus(server.id, enabled);
  const { data: metadata, error: metadataError } = useMcpOAuthMetadata(server.id, enabled);
  const refresh = useRefreshMcpOAuth();
  const disconnect = useDisconnectMcpOAuth();
  const startConnect = useStartMcpOAuthConnect();

  if (!supportsOAuth) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Authentication
            <AuthMethodBadge method={server.authMethod} />
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          OAuth 2.0 is only available for <code className="font-mono">http</code> and{" "}
          <code className="font-mono">sse</code> transports. This server uses{" "}
          <code className="font-mono">{server.transport}</code>, so credentials should be supplied
          via env/header config keys.
        </CardContent>
      </Card>
    );
  }

  const handleConnect = () => {
    const redirect = `${window.location.origin}${window.location.pathname}`;
    startConnect.mutate(
      { mcpServerId: server.id, options: { redirect } },
      {
        onSuccess: ({ providerUrl }) => {
          window.location.href = providerUrl;
        },
        onError: (err: Error) => toast.error(err.message),
      },
    );
  };

  const handleRefresh = () => {
    refresh.mutate(server.id, {
      onSuccess: () => toast.success("Token refreshed"),
      onError: (err: Error) => toast.error(err.message),
    });
  };

  const handleDisconnect = () => {
    disconnect.mutate(server.id, {
      onSuccess: () => toast.success("OAuth disconnected"),
      onError: (err: Error) => toast.error(err.message),
    });
  };

  const token = statusData?.token ?? null;
  const connected = statusData?.connected ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          Authentication
          <AuthMethodBadge method={server.authMethod} />
          {token && <OAuthStatusBadge status={token.status} />}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {statusLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : statusError ? (
          <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{(statusError as Error).message}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className="text-muted-foreground">Status</span>
              <p className="flex items-center gap-2 mt-0.5">
                {connected ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                    Connected
                  </>
                ) : token ? (
                  <>
                    <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
                    {token.status}
                  </>
                ) : (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    Not connected
                  </>
                )}
              </p>
            </div>
            {token?.expiresAt && (
              <div>
                <span className="text-muted-foreground">Expires</span>
                <p>{formatRelativeTime(token.expiresAt)}</p>
              </div>
            )}
            {token?.scope && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Scopes</span>
                <p className="font-mono text-xs break-all">{token.scope}</p>
              </div>
            )}
            {token?.authorizationServerIssuer && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Issuer</span>
                <p className="font-mono text-xs break-all">{token.authorizationServerIssuer}</p>
              </div>
            )}
            {token?.resourceUrl && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Resource</span>
                <p className="font-mono text-xs break-all">{token.resourceUrl}</p>
              </div>
            )}
            {token?.clientSource && (
              <div>
                <span className="text-muted-foreground">Client source</span>
                <p className="capitalize">{token.clientSource}</p>
              </div>
            )}
            {token?.lastRefreshedAt && (
              <div>
                <span className="text-muted-foreground">Last refreshed</span>
                <p>{formatRelativeTime(token.lastRefreshedAt)}</p>
              </div>
            )}
          </div>
        )}

        {token?.lastErrorMessage && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-amber-300">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Last error</p>
              <p className="text-xs mt-0.5">{token.lastErrorMessage}</p>
            </div>
          </div>
        )}

        {metadataError && !token && (
          <p className="text-xs text-muted-foreground">
            Discovery metadata unavailable: {(metadataError as Error).message}. You can still
            register a manual client below.
          </p>
        )}

        {metadata?.requiresOAuth === false && (
          <p className="text-xs text-muted-foreground">
            This server's Protected Resource Metadata indicates OAuth is not required.
          </p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={refresh.isPending || disconnect.isPending || startConnect.isPending}
          >
            {startConnect.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : connected ? (
              "Reconnect"
            ) : (
              "Connect"
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={!token?.hasRefreshToken || refresh.isPending}
          >
            {refresh.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
            )}
            Refresh now
          </Button>
          {token && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive-outline" disabled={disconnect.isPending}>
                  Revoke
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revoke OAuth connection?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the stored access and refresh tokens. The server will be unable to
                    call this MCP until a new connection is established.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDisconnect}>Revoke</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <ManualClientDialog mcpServerId={server.id} />
        </div>
      </CardContent>
    </Card>
  );
}
