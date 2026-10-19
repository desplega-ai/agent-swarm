import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useEnvPresence } from "@/api/hooks/use-integrations-meta";
import { useOnboardingOwnsFirstRun } from "@/api/hooks/use-onboarding";
import { useSetUsedByConsent } from "@/api/hooks/use-org-profile";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { useStatusContext } from "@/app/status-context";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { ImagePreview } from "@/components/shared/image-preview";
import { StatusIcon } from "@/components/shared/status-icon";
import { Badge } from "@/components/ui/badge";
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
import { useSlackConnectPerk } from "@/hooks/use-slack-connect-invite";
import {
  companyDomain,
  isValidEmail,
  orgNameFromDomain,
  storedOrgName,
} from "@/lib/company-profile";
import { isAdminLike } from "@/lib/user-role";
import { cn } from "@/lib/utils";
import {
  isFilledOrgLogoUrl,
  normalizeOrgWebsite,
  orgLogoUrl,
} from "../../../../../src/utils/org-website";

const ORG_NAME_KEY = "SWARM_ORG_NAME";

type Perk = "used_by" | "slack_connect";

/** An unchecked-by-default opt-in. */
function PerkCheck({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2 text-sm leading-relaxed",
        disabled && "text-muted-foreground",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * The org name is required: while `SWARM_ORG_NAME` is unset, admins get this
 * popup on every dashboard route and cannot dismiss it (no Later, X, Esc or
 * outside click). Members never see it. The name and website are pre-filled
 * from a company domain (the website, else the admin's work email domain)
 * for the admin to confirm. Two opt-in perks (a featured logo, a Slack
 * Connect channel) share one contact email, sent to Desplega only with a box
 * ticked. A user who already asked for the Slack channel (the bell, Branding)
 * is told so instead of being asked again.
 */
export function OrganizationNameDialog() {
  const { config, pendingConnection } = useConfig();
  const { state: identityState, user } = useCurrentUser();
  const presence = useEnvPresence([ORG_NAME_KEY]);
  // Open onboarding owns naming (step 2). A minimized setup does not: the
  // dashboard behind it needs a name too.
  const onboardingOwnsName = useOnboardingOwnsFirstRun({ whileMinimized: false });
  const profile = useCompanyProfile();
  const setUsedBy = useSetUsedByConsent();
  const slackPerk = useSlackConnectPerk();
  // `null` = untouched: follow the guess until the admin edits.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [websiteDraft, setWebsiteDraft] = useState<string | null>(null);
  const [contactDraft, setContactDraft] = useState<string | null>(null);
  const [usedBy, setUsedByChecked] = useState(false);
  const [slackConnect, setSlackConnect] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountedAt] = useState(Date.now);
  const sendEvent = useUiTelemetry();
  const shownReported = useRef(false);

  const status = useStatusContext().data;
  // Only an explicit false establishes that the server has no name. Older
  // servers can fail this optional query or omit the key; neither blocks the UI.
  // Persisted query hydration can count as "fetched after mount" without a
  // request. Its original timestamp must not open a stale onboarding prompt.
  // A stored old default ("Your Swarm") counts as no name.
  const missing =
    presence.dataUpdatedAt >= mountedAt &&
    !presence.isError &&
    (presence.data?.[ORG_NAME_KEY] === false ||
      (status ? storedOrgName(status.identity.name) === null : false));
  // Wait for a profile read from this load. Before it, the guess from the
  // admin's email (or a persisted snapshot without the website) would pre-fill
  // the website and overwrite a stored one on save.
  const profileFresh = profile.loaded && profile.updatedAt >= mountedAt;
  const open =
    !saved &&
    isAdminLike(user) &&
    !pendingConnection &&
    !onboardingOwnsName &&
    identityState !== "needs-pick" &&
    ((missing && profileFresh) || saving || error !== null);

  useLayoutEffect(() => {
    if (open) markPromptShownThisLoad(config.apiUrl);
  }, [open, config.apiUrl]);

  // Wait for /status: sendEvent drops events until it knows whether telemetry is on.
  const statusLoaded = status !== undefined;
  useEffect(() => {
    if (!open || !statusLoaded || shownReported.current) return;
    shownReported.current = true;
    sendEvent({
      event: "popup.shown",
      properties: { popup: "org_name", trigger: "missing_org_name" },
    });
  }, [open, statusLoaded, sendEvent]);

  const suggestedWebsite = profile.suggestedWebsite ?? companyDomain(user?.email ?? "");
  const websiteInput = websiteDraft ?? profile.website ?? suggestedWebsite ?? "";
  const host = normalizeOrgWebsite(websiteInput);
  const websiteError =
    websiteInput.trim() && !host ? "Enter a public website, such as example.com." : null;
  // An untouched name follows the website (acme.com becomes Acme).
  const nameDomain = host ?? suggestedWebsite;
  const name = nameDraft ?? (nameDomain ? orgNameFromDomain(nameDomain) : "");
  const nameSuggested = nameDraft === null && nameDomain !== null;
  const contact = (contactDraft ?? user?.email ?? "").trim();
  const contactOk = isValidEmail(contact);
  const canFeature = Boolean(name.trim() && host);
  const perks: Perk[] = [
    ...(usedBy && canFeature ? (["used_by"] as const) : []),
    ...(slackConnect && !slackPerk.done ? (["slack_connect"] as const) : []),
  ];
  const blocker = !name.trim()
    ? "Enter an organization name."
    : websiteError
      ? "Fix the website or clear it."
      : perks.length > 0 && !contactOk
        ? "Add a contact email for the perks you ticked."
        : null;
  // The logo the shell will show after save: a logo a person set stays; otherwise
  // the server fills it from the website.
  const currentLogo = status?.identity.logo_url ?? "";
  const previewLogo =
    currentLogo && !isFilledOrgLogoUrl(currentLogo) ? currentLogo : host ? orgLogoUrl(host) : "";

  async function handleSave() {
    if (blocker || saving || !profileFresh) return;
    setSaving(true);
    setError(null);
    try {
      await profile.save({ name: name.trim(), website: host ?? "" }, "org_name_popup");
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Could not apply your organization name. Please try again.",
      );
      setSaving(false);
      return;
    }
    sendEvent({
      event: "popup.submitted",
      properties: { popup: "org_name", has_message: false, has_contact: perks.length > 0, perks },
    });
    // The name is in, so the gate closes now. The opt-ins run after it, each
    // with its own toast: a failure there must not hold or lose the saved name.
    setSaved(true);
    setSaving(false);
    if (perks.includes("used_by")) {
      void setUsedBy.mutateAsync({ granted: true, contactEmail: contact }).then(
        () => toast.success("Thanks. We'll review your logo before it appears on agent-swarm.dev."),
        () => toast.error("Saved. The logo request did not go through. Try again in Settings."),
      );
    }
    if (perks.includes("slack_connect")) {
      void slackPerk.request(contact, { org_name: name.trim() }).then(
        () => toast.success("Thanks. We'll reach out to set up the Slack Connect channel."),
        () => toast.error("Saved. The Slack Connect request did not go through."),
      );
    }
  }

  return (
    <Dialog
      open={open}
      // Not dismissible: it closes once the name is saved.
      onOpenChange={() => {}}
    >
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>Name your organization</DialogTitle>
            <DialogDescription>
              It appears across your dashboard and messages, and it turns on the perks below.
            </DialogDescription>
          </DialogHeader>
          <SettingsRow
            label="Organization name"
            htmlFor="organization-name"
            required
            helper={
              nameSuggested && name
                ? `Suggested from ${nameDomain}. Change it if your team uses another name.`
                : undefined
            }
          >
            <Input
              id="organization-name"
              placeholder="Your organization"
              autoComplete="organization"
              autoFocus
              value={name}
              onChange={(event) => setNameDraft(event.target.value)}
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
                placeholder="example.com"
                autoComplete="url"
                inputMode="url"
                value={websiteInput}
                onChange={(event) => setWebsiteDraft(event.target.value)}
                aria-invalid={websiteError !== null}
                disabled={saving}
              />
            </div>
          </SettingsRow>
          <div className="flex flex-col gap-3 rounded-xl border bg-surface p-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">For named organizations</span>
              <Badge variant="outline" size="tag">
                Optional
              </Badge>
            </div>
            <p className="flex items-start gap-2 text-sm">
              <StatusIcon
                tone={name.trim() ? "success" : "dirty"}
                label={name.trim() ? "On with a name" : "Needs a name"}
                className="mt-0.5"
              />
              <span>
                Home shows how your swarm compares with similar swarms. Needs anonymous telemetry
                on.
              </span>
            </p>
            {/* Unchecked while there is nothing to feature, still checked while saving. */}
            <PerkCheck
              checked={usedBy && canFeature}
              onChange={setUsedByChecked}
              disabled={!canFeature || saving}
            >
              Feature our logo on agent-swarm.dev as a company that uses Agent Swarm
            </PerkCheck>
            {slackPerk.done ? (
              <p className="flex items-start gap-2 text-sm">
                <StatusIcon tone="success" label="Requested" className="mt-0.5" />
                <span>
                  You already asked for a Slack Connect channel with the team that builds Agent
                  Swarm. We reply by email.
                </span>
              </p>
            ) : (
              <PerkCheck checked={slackConnect} onChange={setSlackConnect} disabled={saving}>
                Open a Slack Connect channel with the team that builds Agent Swarm. We reply within
                a business day.
              </PerkCheck>
            )}
            <AnimatedReveal open={perks.length > 0}>
              <SettingsRow
                label="Contact email"
                htmlFor="organization-contact"
                required
                helper="Sent to Desplega only for the boxes you ticked."
                className="pt-2"
              >
                <Input
                  id="organization-contact"
                  type="email"
                  autoComplete="email"
                  placeholder="ada@acme.com"
                  value={contactDraft ?? user?.email ?? ""}
                  onChange={(event) => setContactDraft(event.target.value)}
                  aria-invalid={!contactOk || undefined}
                  disabled={saving}
                />
              </SettingsRow>
            </AnimatedReveal>
          </div>
          {error && (
            <p role="alert" className="text-sm text-status-error-strong">
              {error}
            </p>
          )}
          <DialogFooter className="items-center">
            {blocker ? (
              <span className="text-xs text-muted-foreground sm:mr-auto">{blocker}</span>
            ) : null}
            <Button
              type="submit"
              aria-disabled={blocker !== null || undefined}
              className="aria-disabled:opacity-50"
              status={saving ? "loading" : "idle"}
            >
              Save organization name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
