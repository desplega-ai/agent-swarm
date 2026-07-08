import { ArrowLeft, ExternalLink, Pencil, Trash2, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useDeleteOAuthApp,
  useDisconnectOAuthApp,
  useOAuthApps,
  useOAuthAuthorizeUrl,
} from "@/api/hooks/use-script-connections";
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
} from "@/components/ui/detail-page-layout";
import { PageHeader } from "@/components/ui/page-header";
import { formatSmartTime } from "@/lib/utils";
import { CopyIconButton } from "@/pages/connections/components/copy-icon-button";
import { InlineError, OAuthAppDialog, TokenStatusBadge } from "@/pages/connections/page";

function CopyableValue({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="break-all">{value}</span>
      <CopyIconButton value={value} label={label} />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 text-sm md:grid-cols-[160px_1fr]">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">{value}</div>
    </div>
  );
}

export default function OAuthAppDetailPage() {
  const { provider } = useParams();
  const decodedProvider = provider ? decodeURIComponent(provider) : "";
  const navigate = useNavigate();
  const { data: apps = [], isLoading, error } = useOAuthApps();
  const authorize = useOAuthAuthorizeUrl();
  const deleteApp = useDeleteOAuthApp();
  const disconnect = useDisconnectOAuthApp();
  const [editOpen, setEditOpen] = useState(false);
  const app = apps.find((candidate) => candidate.provider === decodedProvider);
  const hasToken = app ? app.tokenStatus !== "missing" : false;

  async function openAuthorize() {
    if (!app) return;
    const result = await authorize.mutateAsync(app.provider);
    window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
  }

  async function confirmDelete() {
    if (!app) return;
    await deleteApp.mutateAsync(app.provider);
    toast.success("OAuth app deleted");
    navigate("/connections");
  }

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading OAuth app...</div>;
  }
  if (error || !app) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Button asChild variant="outline" size="sm" className="w-fit">
          <Link to="/connections">
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <InlineError error={error ?? "OAuth app not found"} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-hidden">
      <PageHeader
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="icon-sm" aria-label="Back to connections">
              <Link to="/connections">
                <ArrowLeft className="size-4" />
              </Link>
            </Button>
            <span className="truncate text-xl font-semibold">{app.provider}</span>
          </span>
        }
        description={`OAuth app for ${app.clientId}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={openAuthorize}
              disabled={authorize.isPending}
            >
              <ExternalLink className="size-4" />
              {hasToken ? "Re-authorize" : "Authorize"}
            </Button>
            {hasToken ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" disabled={disconnect.isPending}>
                    <Unplug className="size-4" />
                    Disconnect
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect {app.provider}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Deletes the stored access and refresh tokens (with a best-effort revocation at
                      the provider). The app configuration stays — you can authorize again at any
                      time. Bindings using this provider will stop resolving until then.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={async () => {
                        const result = await disconnect.mutateAsync(app.provider);
                        toast.success(
                          result.revocationAttempted
                            ? "Disconnected (revocation attempted at provider)"
                            : "Disconnected — stored tokens deleted",
                        );
                      }}
                      disabled={disconnect.isPending}
                    >
                      Disconnect
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" />
              Edit
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive-outline" size="sm">
                  <Trash2 className="size-4" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete OAuth app?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes the app configuration and all stored OAuth tokens for{" "}
                    {app.provider}.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={confirmDelete}
                    disabled={deleteApp.isPending}
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />

      <DetailPageBody
        className="lg:flex-1 lg:min-h-0"
        main={
          <div className="space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">OAuth App</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <InfoRow
                  label="Client ID"
                  value={<CopyableValue value={app.clientId} label="Copy client ID" />}
                />
                <InfoRow
                  label="Authorize URL"
                  value={<CopyableValue value={app.authorizeUrl} label="Copy authorize URL" />}
                />
                <InfoRow
                  label="Token URL"
                  value={<CopyableValue value={app.tokenUrl} label="Copy token URL" />}
                />
                <InfoRow
                  label="Redirect URI"
                  value={<CopyableValue value={app.redirectUri} label="Copy redirect URI" />}
                />
                <InfoRow
                  label="Scopes"
                  value={
                    app.scopes.length ? (
                      <div className="flex flex-wrap gap-1">
                        {app.scopes.map((scope) => (
                          <Badge key={scope} variant="outline" size="tag">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )
                  }
                />
                <InfoRow label="Token auth" value={app.tokenAuthStyle} />
                <InfoRow label="Body format" value={app.tokenBodyFormat} />
                <InfoRow
                  label="Extra params"
                  value={
                    app.extraParams && Object.keys(app.extraParams).length ? (
                      <pre className="overflow-auto rounded-md bg-muted/40 p-2 text-xs">
                        {JSON.stringify(app.extraParams, null, 2)}
                      </pre>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )
                  }
                />
              </CardContent>
            </Card>
          </div>
        }
        rail={
          <DetailPageRail>
            <QuickStats>
              <QuickStat label="Token" value={<TokenStatusBadge status={app.tokenStatus} />} />
              <QuickStat
                label="Expires"
                value={app.expiresAt ? formatSmartTime(app.expiresAt) : "No token"}
              />
              <QuickStat label="Created" value={formatSmartTime(app.createdAt)} />
              <QuickStat label="Updated" value={formatSmartTime(app.updatedAt)} />
            </QuickStats>
          </DetailPageRail>
        }
      />

      <InlineError error={authorize.error ?? deleteApp.error ?? disconnect.error} />
      <OAuthAppDialog open={editOpen} onOpenChange={setEditOpen} app={app} />
    </div>
  );
}
