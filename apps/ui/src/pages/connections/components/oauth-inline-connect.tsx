import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  useOAuthAuthorizeUrl,
  useOAuthPresets,
  useUpsertOAuthApp,
} from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary, OAuthAuthorizationSummary } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NEW_APP = "__new_app__";
const NEW_AUTHORIZATION = "__new_authorization__";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 120_000;
// Grace after the popup closes before we give up — a completing callback may
// auto-close the window a beat before the detection refetch lands.
const POPUP_CLOSE_GRACE_MS = 4000;

// Snapshot of the authorization carrying the pending label at the moment the
// authorize flow starts. Re-authorizing an EXISTING label must not match the
// stale record on the first poll tick — we only treat it as landed once the
// record is new or has observably changed.
type PendingSnapshot = {
  existed: boolean;
  updatedAt: string | null;
  lastRefreshedAt: string | null;
  status: string | null;
};

function authStatusTone(status: string): string {
  if (status === "active") return "border-status-success/30 text-status-success-strong";
  if (status === "refresh-failed" || status === "revoked" || status === "expired") {
    return "border-status-error/30 text-status-error-strong";
  }
  return "border-status-neutral/30 text-status-neutral";
}

/**
 * Inline OAuth connect sub-flow for the Add Connection dialog (step-10).
 *
 * Picks (or creates from a curated preset) an OAuth app, then picks (or runs the
 * authorize popup for) a labeled authorization — resolving to a single
 * `authorizationId` the connection embeds. Replaces the old free-text provider
 * input + new-tab "create an app" link.
 */
export function OAuthInlineConnect({
  oauthApps,
  value,
  onChange,
  suggestedPresetId,
}: {
  oauthApps: OAuthAppSummary[];
  value: string;
  onChange: (authorizationId: string) => void;
  suggestedPresetId?: string;
}) {
  const queryClient = useQueryClient();
  const { data: presets = [] } = useOAuthPresets();
  const upsertApp = useUpsertOAuthApp();
  const buildAuthorizeUrl = useOAuthAuthorizeUrl();

  // The app that owns the currently-selected authorization (edit prefill).
  const owningAppId = useMemo(
    () => oauthApps.find((app) => app.authorizations?.some((z) => z.id === value))?.id ?? "",
    [oauthApps, value],
  );
  const [appId, setAppId] = useState<string>(owningAppId);
  const [presetId, setPresetId] = useState(suggestedPresetId ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authLabel, setAuthLabel] = useState("default");
  const [authorizeMode, setAuthorizeMode] = useState(false);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  // Set when the popup was blocked (window.open returned null / immediately
  // closed): the user completes via a normal target=_blank link instead.
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const snapshotRef = useRef<PendingSnapshot | null>(null);
  const closedAtRef = useRef<number | null>(null);

  // Keep the app selection in sync when an edit prefill resolves late.
  useEffect(() => {
    if (owningAppId && !appId) setAppId(owningAppId);
  }, [owningAppId, appId]);

  const selectedApp = oauthApps.find((app) => app.id === appId);
  const authorizations = selectedApp?.authorizations ?? [];
  // A newly-created app has no authorizations yet — default straight into the
  // authorize flow so the single-flow dialog never dead-ends.
  const authValue = value && authorizations.some((z) => z.id === value) ? value : "";

  // Stable across renders (only state setters + refs) so the poll effect can
  // depend on it without resetting its timer every render.
  const stopPending = useCallback(() => {
    setPendingLabel(null);
    setFallbackUrl(null);
    snapshotRef.current = null;
    closedAtRef.current = null;
  }, []);

  // Detection: whenever the (refetched) authorizations show the pending label as
  // NEW or observably changed since the flow started, auto-select it. Kept
  // separate from the poll timer so the timer isn't reset on every refetch.
  useEffect(() => {
    if (!pendingLabel) return;
    const match = authorizations.find((z) => z.label === pendingLabel);
    if (!match) return;
    const snap = snapshotRef.current;
    const landed =
      !snap?.existed ||
      match.updatedAt !== snap.updatedAt ||
      (match.lastRefreshedAt ?? null) !== snap.lastRefreshedAt ||
      (match.status === "active" && snap.status !== "active");
    if (!landed) return;
    onChange(match.id);
    setAuthorizeMode(false);
    popupRef.current?.close();
    popupRef.current = null;
    stopPending();
    toast.success(`Authorization "${pendingLabel}" connected`);
  }, [pendingLabel, authorizations, onChange, stopPending]);

  // Polling: refetch the app list while an authorization is pending. Give up on
  // the overall timeout, or shortly after the user closes the popup. Depends
  // only on pendingLabel so the timer survives the refetches it triggers.
  useEffect(() => {
    if (!pendingLabel) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const popup = popupRef.current;
      if (popup?.closed) {
        if (closedAtRef.current === null) closedAtRef.current = Date.now();
        if (Date.now() - closedAtRef.current > POPUP_CLOSE_GRACE_MS) {
          clearInterval(timer);
          popupRef.current = null;
          stopPending();
          toast("Authorization window closed before it completed.");
          return;
        }
      }
      if (Date.now() - started > POLL_TIMEOUT_MS) {
        clearInterval(timer);
        stopPending();
        toast.error("Authorization did not complete. Try again.");
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["oauth-apps"] });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [pendingLabel, queryClient, stopPending]);

  async function createApp() {
    if (!presetId || !clientId.trim()) return;
    try {
      const result = (await upsertApp.mutateAsync({
        presetId,
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      })) as { oauthApp?: OAuthAppSummary };
      const created = result.oauthApp;
      if (created?.id) {
        setAppId(created.id);
        setClientSecret("");
        setAuthorizeMode(true);
        toast.success(`OAuth app ${created.provider} created`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create OAuth app");
    }
  }

  function snapshotFor(label: string): PendingSnapshot {
    const existing = authorizations.find((z) => z.label === label);
    return existing
      ? {
          existed: true,
          updatedAt: existing.updatedAt,
          lastRefreshedAt: existing.lastRefreshedAt ?? null,
          status: existing.status,
        }
      : { existed: false, updatedAt: null, lastRefreshedAt: null, status: null };
  }

  async function startAuthorize() {
    if (!appId) return;
    const label = authLabel.trim() || "default";
    // Snapshot BEFORE launching so re-authorizing an existing label only counts
    // once the record changes (finding: stale-label instant match).
    snapshotRef.current = snapshotFor(label);
    closedAtRef.current = null;
    setFallbackUrl(null);
    // Open the popup synchronously inside the click gesture so popup blockers
    // don't kill a window opened after the await. Navigate it once we have the
    // URL; fall back to an inline link if the browser blocked it.
    const popup = window.open("about:blank", "oauth-authorize", "width=640,height=760");
    try {
      const { authorizeUrl } = await buildAuthorizeUrl.mutateAsync({ appId, label });
      if (popup && !popup.closed) {
        popup.location.href = authorizeUrl;
        popupRef.current = popup;
        setPendingLabel(label);
      } else {
        popup?.close();
        popupRef.current = null;
        setFallbackUrl(authorizeUrl);
        setPendingLabel(label);
      }
    } catch (error) {
      popup?.close();
      popupRef.current = null;
      snapshotRef.current = null;
      toast.error(error instanceof Error ? error.message : "Failed to start authorization");
    }
  }

  const redirectUriHint = selectedApp?.redirectUri ?? oauthApps[0]?.redirectUri;

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="space-y-2">
        <Label className="text-xs">OAuth App</Label>
        <Select
          value={appId || NEW_APP}
          onValueChange={(next) => {
            if (next === NEW_APP) {
              setAppId("");
              setAuthorizeMode(false);
            } else {
              setAppId(next);
              setAuthorizeMode(false);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select or create an OAuth app" />
          </SelectTrigger>
          <SelectContent>
            {oauthApps.map((app) => (
              <SelectItem key={app.id} value={app.id}>
                {app.provider}
              </SelectItem>
            ))}
            <SelectItem value={NEW_APP}>+ New from preset</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!appId ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">Preset</Label>
            <Select value={presetId} onValueChange={setPresetId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a provider preset" />
              </SelectTrigger>
              <SelectContent>
                {presets.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    {preset.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {redirectUriHint ? (
            <p className="text-xs text-muted-foreground">
              Register this redirect URI in the provider console:{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">{redirectUriHint}</code>
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="text-xs">Client ID</Label>
              <Input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="Client ID from the provider"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Client Secret</Label>
              <Input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Stored write-only"
                autoComplete="new-password"
              />
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!presetId || !clientId.trim() || upsertApp.isPending}
            onClick={() => void createApp()}
          >
            {upsertApp.isPending ? "Creating..." : "Create app"}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label className="text-xs">Authorization</Label>
            <Select
              value={authValue || (authorizeMode ? NEW_AUTHORIZATION : "")}
              onValueChange={(next) => {
                if (next === NEW_AUTHORIZATION) {
                  setAuthorizeMode(true);
                } else {
                  setAuthorizeMode(false);
                  onChange(next);
                }
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select or authorize an account" />
              </SelectTrigger>
              <SelectContent>
                {authorizations.map((authorization: OAuthAuthorizationSummary) => (
                  <SelectItem key={authorization.id} value={authorization.id}>
                    {authorization.label}
                    {authorization.accountEmail ? ` — ${authorization.accountEmail}` : ""}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_AUTHORIZATION}>+ Authorize new account</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {authValue ? (
            <div className="flex items-center gap-2">
              {authorizations
                .filter((z) => z.id === authValue)
                .map((z) => (
                  <Badge
                    key={z.id}
                    variant="outline"
                    size="tag"
                    className={authStatusTone(z.status)}
                  >
                    {z.status}
                  </Badge>
                ))}
            </div>
          ) : null}

          {authorizeMode && !authValue ? (
            <div className="space-y-2 rounded-md border p-3">
              <Label className="text-xs">Authorization label</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={authLabel}
                  onChange={(event) => setAuthLabel(event.target.value)}
                  placeholder="default"
                  className="h-8 w-48"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={buildAuthorizeUrl.isPending || Boolean(pendingLabel)}
                  onClick={() => void startAuthorize()}
                >
                  {pendingLabel ? "Waiting for authorization..." : "Authorize"}
                </Button>
                {pendingLabel ? (
                  <Button type="button" size="sm" variant="ghost" onClick={stopPending}>
                    Cancel
                  </Button>
                ) : null}
              </div>
              {fallbackUrl ? (
                <p className="text-xs text-status-warning-strong">
                  Popup blocked.{" "}
                  <a
                    href={fallbackUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-2"
                  >
                    Open the authorization page
                  </a>{" "}
                  in a new tab; this picker updates automatically once you finish.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  A provider window opens; complete sign-in there and this picker updates
                  automatically.
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
