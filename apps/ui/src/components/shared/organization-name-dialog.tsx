import { useState } from "react";
import { useUpsertConfig } from "@/api/hooks/use-config-api";
import { useEnvPresence, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { useOnboardingOwnsFirstRun } from "@/api/hooks/use-onboarding";
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

const ORG_NAME_KEY = "SWARM_ORG_NAME";

export function OrganizationNameDialog() {
  const { pendingConnection } = useConfig();
  const { state: identityState } = useCurrentUser();
  const presence = useEnvPresence([ORG_NAME_KEY]);
  // Open onboarding owns naming (step 2). Stay closed until its query settles.
  const onboardingOwnsName = useOnboardingOwnsFirstRun();
  const upsert = useUpsertConfig();
  const reload = useReloadConfig();
  const [name, setName] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mountedAt] = useState(Date.now);

  // Only an explicit false establishes that the server has no name. Older
  // servers can fail this optional query or omit the key; neither blocks the UI.
  // Persisted query hydration can count as "fetched after mount" without a
  // request. Its original timestamp must not open a stale onboarding prompt.
  const missing =
    presence.dataUpdatedAt >= mountedAt &&
    presence.data?.[ORG_NAME_KEY] === false &&
    !presence.isError;
  const open =
    !dismissed &&
    !pendingConnection &&
    !onboardingOwnsName &&
    identityState !== "needs-pick" &&
    (missing || saving || error !== null);

  async function handleSave() {
    const value = name.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await upsert.mutateAsync({ scope: "global", key: ORG_NAME_KEY, value, isSecret: false });
      // Older APIs do not auto-reload global writes. Apply the persisted name
      // to the running server so status and telemetry see it immediately.
      await reload.mutateAsync();
      setDismissed(true);
    } catch {
      setError("Could not apply your organization name. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && setDismissed(true)}>
      <DialogContent>
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
          {error && (
            <p role="alert" className="text-sm text-status-error-strong">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDismissed(true)}>
              Later
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? "Saving..." : "Save organization name"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
