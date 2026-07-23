import { AlertTriangle, ExternalLink, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useDeleteOAuthApp,
  useDeleteOAuthAuthorization,
  useOAuthAppAuthorizations,
  useOAuthApps,
  useOAuthAuthorizeUrl,
  useRefreshOAuthAuthorization,
} from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary } from "@/api/types";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatSmartTime } from "@/lib/utils";
import { BackButton } from "@/pages/connections/components/back-button";
import { CopyIconButton } from "@/pages/connections/components/copy-icon-button";
import {
  InlineError,
  OAuthAppDialog,
  OAuthAuthorizationStatusBadge,
  OAuthSourceBadge,
  toastMutationError,
} from "@/pages/connections/page";

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

/** Prompt for a label, then open the authorization URL for a new account. */
function AuthorizeAccountDialog({
  open,
  onOpenChange,
  onAuthorize,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthorize: (label: string) => Promise<void>;
  pending: boolean;
}) {
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (open) setLabel("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Authorize a new account</DialogTitle>
          <DialogDescription>
            A label distinguishes multiple accounts under this app (e.g. <code>support</code>,{" "}
            <code>sales</code>). The provider consent screen opens in a new tab.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="authorization-label">Label</Label>
          <Input
            id="authorization-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="default"
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !label.trim()}
            onClick={async () => {
              await onAuthorize(label.trim());
              onOpenChange(false);
            }}
          >
            <ExternalLink className="size-4" />
            Authorize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function OAuthAppDetailPage() {
  const { id } = useParams();
  const decoded = id ? decodeURIComponent(id) : "";
  const navigate = useNavigate();
  const { data: apps = [], isLoading, error } = useOAuthApps();
  // Resolve by id first, then fall back to provider so old provider-keyed
  // bookmarks (`/connections/oauth-apps/<provider>`) still land — and get
  // rewritten to the canonical id URL below.
  const app: OAuthAppSummary | undefined =
    apps.find((candidate) => candidate.id === decoded) ??
    apps.find((candidate) => candidate.provider === decoded);
  const { data: authorizations = [] } = useOAuthAppAuthorizations(app?.id);
  const authorize = useOAuthAuthorizeUrl();
  const refresh = useRefreshOAuthAuthorization();
  const revoke = useDeleteOAuthAuthorization();
  const deleteApp = useDeleteOAuthApp();
  const [editOpen, setEditOpen] = useState(false);
  const [authorizeOpen, setAuthorizeOpen] = useState(false);

  useEffect(() => {
    if (app && app.id !== decoded) {
      navigate(`/connections/oauth-apps/${encodeURIComponent(app.id)}`, { replace: true });
    }
  }, [app, decoded, navigate]);

  async function openAuthorize(label: string) {
    if (!app) return;
    try {
      const result = await authorize.mutateAsync({ appId: app.id, label });
      window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
      toast.success(`Opened consent for "${result.label}" in a new tab`);
    } catch (err) {
      toastMutationError(err);
    }
  }

  async function confirmDelete() {
    if (!app) return;
    try {
      await deleteApp.mutateAsync(app.id);
      toast.success("OAuth app deleted");
      navigate("/connections?tab=oauth-apps");
    } catch (err) {
      toastMutationError(err);
    }
  }

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading OAuth app...</div>;
  }
  if (error || !app) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <BackButton fallback="/connections?tab=oauth-apps" />
        <InlineError error={error ?? "OAuth app not found"} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 lg:flex-1 lg:min-h-0 lg:overflow-y-hidden">
      <PageHeader
        title={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <BackButton fallback="/connections?tab=oauth-apps" iconOnly />
            <span className="truncate text-xl font-semibold">{app.provider}</span>
            <OAuthSourceBadge source={app.source} />
          </span>
        }
        description={`OAuth app for ${app.clientId}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setAuthorizeOpen(true)} disabled={authorize.isPending}>
              <Plus className="size-4" />
              Authorize account
            </Button>
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
                    This deletes the app configuration and all {authorizations.length}{" "}
                    authorization(s) for {app.provider}.
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
                <CardTitle className="text-base">Authorizations</CardTitle>
              </CardHeader>
              <CardContent>
                {authorizations.length ? (
                  <div className="divide-y rounded-md border">
                    {authorizations.map((authorization) => (
                      <div
                        key={authorization.id}
                        className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{authorization.label}</span>
                            <OAuthAuthorizationStatusBadge status={authorization.status} />
                            {authorization.status === "refresh-failed" &&
                            authorization.lastErrorMessage ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="size-3.5 shrink-0 text-status-error" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs whitespace-normal">
                                  {authorization.lastErrorMessage}
                                </TooltipContent>
                              </Tooltip>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {authorization.accountEmail ?? "unknown account"}
                            {authorization.expiresAt
                              ? ` · expires ${formatSmartTime(authorization.expiresAt)}`
                              : ""}
                            {authorization.lastRefreshedAt
                              ? ` · refreshed ${formatSmartTime(authorization.lastRefreshedAt)}`
                              : ""}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openAuthorize(authorization.label)}
                            disabled={authorize.isPending}
                          >
                            <ExternalLink className="size-3" />
                            Re-authorize
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={!authorization.hasRefreshToken || refresh.isPending}
                            title={
                              authorization.hasRefreshToken
                                ? "Force-refresh this authorization"
                                : "No refresh token stored"
                            }
                            onClick={async () => {
                              try {
                                const result = await refresh.mutateAsync(authorization.id);
                                toast.success(`Refreshed — status ${result.status}`);
                              } catch (err) {
                                toastMutationError(err);
                              }
                            }}
                          >
                            <RotateCw className="size-3" />
                            Refresh
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Revoke ${authorization.label}`}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Revoke authorization?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Deletes the "{authorization.label}" authorization and attempts a
                                  best-effort revocation at the provider. Bindings pointing at it
                                  will stop resolving.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  variant="destructive"
                                  disabled={revoke.isPending}
                                  onClick={async () => {
                                    try {
                                      const result = await revoke.mutateAsync(authorization.id);
                                      toast.success(
                                        result.revocationAttempted
                                          ? "Revoked (revocation attempted at provider)"
                                          : "Authorization deleted",
                                      );
                                    } catch (err) {
                                      toastMutationError(err);
                                    }
                                  }}
                                >
                                  Revoke
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    No authorizations yet. Use “Authorize account” to connect one.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">OAuth App</CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                <InfoRow label="Source" value={<OAuthSourceBadge source={app.source} />} />
                <InfoRow
                  label="Client ID"
                  value={<CopyableValue value={app.clientId} label="Copy client ID" />}
                />
                <InfoRow
                  label="Redirect URI"
                  value={<CopyableValue value={app.redirectUri} label="Copy redirect URI" />}
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
              <QuickStat label="Source" value={<OAuthSourceBadge source={app.source} />} />
              <QuickStat label="Accounts" value={authorizations.length} />
              <QuickStat label="Created" value={formatSmartTime(app.createdAt)} />
              <QuickStat label="Updated" value={formatSmartTime(app.updatedAt)} />
            </QuickStats>
          </DetailPageRail>
        }
      />

      <AuthorizeAccountDialog
        open={authorizeOpen}
        onOpenChange={setAuthorizeOpen}
        onAuthorize={openAuthorize}
        pending={authorize.isPending}
      />
      <OAuthAppDialog open={editOpen} onOpenChange={setEditOpen} app={app} />
    </div>
  );
}
