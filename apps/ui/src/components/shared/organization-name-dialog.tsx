import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { useConfigs, useUpsertConfig } from "@/api/hooks/use-config-api";
import { useEnvPresence, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { useOnboardingOwnsFirstRun } from "@/api/hooks/use-onboarding";
import { useSetUsedByConsent } from "@/api/hooks/use-org-profile";
import { type PopupDismissMethod, useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { useStatusContext } from "@/app/status-context";
import { ImagePreview } from "@/components/shared/image-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { markPromptShownThisLoad } from "@/hooks/use-other-dialog-open";
import { deferOrgNamePrompt, useOrgNamePromptDeferred } from "@/lib/org-name-prompt";
import { isAdminLike } from "@/lib/user-role";
import { cn } from "@/lib/utils";
import {
  isFilledOrgLogoUrl,
  normalizeOrgWebsite,
  orgLogoUrl,
  websiteSuggestion,
} from "../../../../../src/utils/org-website";

const ORG_NAME_KEY = "SWARM_ORG_NAME";
const ORG_WEBSITE_KEY = "SWARM_ORG_WEBSITE";

export function OrganizationNameDialog() {
  const { config, pendingConnection } = useConfig();
  const { pathname } = useLocation();
  const { state: identityState, user } = useCurrentUser();
  const deferred = useOrgNamePromptDeferred(config.apiUrl);
  const presence = useEnvPresence([ORG_NAME_KEY]);
  // Open onboarding owns naming (step 2). Stay closed until its query settles.
  const onboardingOwnsName = useOnboardingOwnsFirstRun();
  const upsert = useUpsertConfig();
  const reload = useReloadConfig();
  const { data: globalConfigs } = useConfigs({ scope: "global" });
  const setUsedBy = useSetUsedByConsent();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [usedBy, setUsedByChecked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountedAt] = useState(Date.now);
  const sendEvent = useUiTelemetry();
  const shownReported = useRef(false);
  const closeMethod = useRef<PopupDismissMethod>("close");

  // Only an explicit false establishes that the server has no name. Older
  // servers can fail this optional query or omit the key; neither blocks the UI.
  // Persisted query hydration can count as "fetched after mount" without a
  // request. Its original timestamp must not open a stale onboarding prompt.
  const missing =
    presence.dataUpdatedAt >= mountedAt &&
    presence.data?.[ORG_NAME_KEY] === false &&
    !presence.isError;
  const open =
    pathname === "/" &&
    !dismissed &&
    !deferred &&
    isAdminLike(user) &&
    !pendingConnection &&
    !onboardingOwnsName &&
    identityState !== "needs-pick" &&
    (missing || saving || error !== null);

  useLayoutEffect(() => {
    if (open) markPromptShownThisLoad(config.apiUrl);
  }, [open, config.apiUrl]);

  // Wait for /status: sendEvent drops events until it knows whether telemetry is on.
  const status = useStatusContext().data;
  const statusLoaded = status !== undefined;
  useEffect(() => {
    if (!open || !statusLoaded || shownReported.current) return;
    shownReported.current = true;
    sendEvent({
      event: "popup.shown",
      properties: { popup: "org_name", trigger: "missing_org_name" },
    });
  }, [open, statusLoaded, sendEvent]);

  function dismiss(method: PopupDismissMethod) {
    sendEvent({ event: "popup.dismissed", properties: { popup: "org_name", method } });
    // Later hands the ask to the bell item for the rest of this session.
    deferOrgNamePrompt(config.apiUrl);
    setDismissed(true);
  }

  const suggestion = websiteSuggestion(
    globalConfigs?.find((entry) => entry.key === "telemetry_org_domain")?.value,
  );
  const host = normalizeOrgWebsite(website);
  const websiteError =
    website.trim() && !host ? "Enter a public website, such as example.com." : null;
  const canConsent = Boolean(name.trim() && host);
  // The logo the shell will show after save: a logo a person set stays; otherwise
  // the server fills it from the website.
  const currentLogo = status?.identity.logo_url ?? "";
  const previewLogo =
    currentLogo && !isFilledOrgLogoUrl(currentLogo) ? currentLogo : host ? orgLogoUrl(host) : "";

  async function handleSave() {
    const value = name.trim();
    if (!value || saving || websiteError) return;
    setSaving(true);
    setError(null);
    try {
      await upsert.mutateAsync({ scope: "global", key: ORG_NAME_KEY, value, isSecret: false });
      if (host) {
        await upsert.mutateAsync({
          scope: "global",
          key: ORG_WEBSITE_KEY,
          value: host,
          isSecret: false,
        });
      }
      // Older APIs do not auto-reload global writes. Apply the persisted name
      // to the running server so status and telemetry see it immediately.
      await reload.mutateAsync();
      sendEvent({
        event: "popup.submitted",
        properties: { popup: "org_name", has_message: false, has_contact: false },
      });
      sendEvent({
        event: "org.profile_updated",
        properties: { fields: host ? ["name", "website"] : ["name"], surface: "prompt" },
      });
      if (usedBy && canConsent) {
        // An explicit opt-in: a failure here must not lose the saved name.
        await setUsedBy.mutateAsync(true).catch(() => {
          toast.error("Saved. The logo consent did not go through; try again in Settings.");
        });
      }
      setDismissed(true);
    } catch {
      setError("Could not apply your organization name. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        dismiss(closeMethod.current);
        closeMethod.current = "close";
      }}
    >
      <DialogContent
        onEscapeKeyDown={() => {
          closeMethod.current = "escape";
        }}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>Name your organization</DialogTitle>
            <DialogDescription>
              Give your swarm an organization name. It will appear across your dashboard and
              messages.
            </DialogDescription>
          </DialogHeader>
          <SettingsRow label="Organization name" htmlFor="organization-name">
            <Input
              id="organization-name"
              placeholder="Your organization"
              autoComplete="organization"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={saving}
            />
          </SettingsRow>
          <SettingsRow
            label="Company website (optional)"
            htmlFor="organization-website"
            helper={
              websiteError ? (
                <span className="text-status-error-strong">{websiteError}</span>
              ) : undefined
            }
          >
            <div className="flex items-center gap-2">
              <ImagePreview src={previewLogo} label="Company logo" />
              <Input
                id="organization-website"
                placeholder={suggestion ?? "example.com"}
                autoComplete="url"
                inputMode="url"
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
                aria-invalid={websiteError !== null}
                disabled={saving}
              />
            </div>
          </SettingsRow>
          <label
            className={cn(
              "flex items-start gap-2 text-sm leading-relaxed",
              !canConsent && "text-muted-foreground",
            )}
          >
            <input
              type="checkbox"
              checked={usedBy && canConsent}
              disabled={!canConsent || saving}
              onChange={(event) => setUsedByChecked(event.target.checked)}
              className="mt-0.5 size-4 rounded border-input accent-primary"
            />
            <span>Show our logo on agent-swarm.dev as a company that uses Agent Swarm</span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-status-error-strong">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => dismiss("later")}>
              Later
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || websiteError !== null}>
              {saving ? "Saving..." : "Save organization name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
