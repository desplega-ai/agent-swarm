import { AlertCircle, Trophy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { useCompanyProfile } from "@/api/hooks/use-company-profile";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useEnableTelemetry, useRanking, useRankingOptIn } from "@/api/hooks/use-org-profile";
import { AlertCallout } from "@/components/ui/alert-callout";
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
import { Label } from "@/components/ui/label";
import { useIsAdmin } from "@/lib/use-can";
import { orgIdentityStatus } from "../../../../../src/utils/org-identity";

/**
 * Home: "Add me to ranking" for admins (the gate of Settings → Configuration,
 * where the full Get ranked form lives). Hidden once the install is ranked,
 * and on an API with no `/api/ranking`. The dialog asks only the organization
 * name and website, stores them, turns telemetry on if it is off, and opts in
 * with the stored category (engineering for a first listing).
 */
export function AddToRankingButton() {
  // The ranking routes answer 403 to a non-admin: never ask.
  return useIsAdmin() ? <AdminAddToRanking /> : null;
}

function AdminAddToRanking() {
  const { data: configs } = useConfigs({ scope: "global" });
  const stored = (key: string) => configs?.find((entry) => entry.key === key)?.value.trim() ?? "";
  // The key the Settings row uses, so a profile save there refreshes this too.
  const { data: state } = useRanking(`${stored("SWARM_ORG_NAME")}|${stored("SWARM_ORG_WEBSITE")}`);
  const profile = useCompanyProfile();
  const [open, setOpen] = useState(false);

  if (!state || state.enabled || !profile.loaded) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Trophy />
        Add me to ranking
      </Button>
      {open ? (
        <AddToRankingDialog
          onClose={() => setOpen(false)}
          telemetryOn={state.telemetryOn}
          listing={state.listing}
          save={profile.save}
          // The resolved identity (a stored row or the env), else the admin's work domain.
          initialName={
            (state.missing.includes("SWARM_ORG_NAME") ? null : state.name) ??
            profile.suggestedName ??
            ""
          }
          initialWebsite={state.domain ?? profile.suggestedWebsite ?? ""}
        />
      ) : null}
    </>
  );
}

function AddToRankingDialog({
  onClose,
  save,
  telemetryOn,
  listing,
  initialName,
  initialWebsite,
}: {
  onClose: () => void;
  save: ReturnType<typeof useCompanyProfile>["save"];
  telemetryOn: boolean;
  listing: { category: string; subcategory: string | null; description: string | null } | null;
  initialName: string;
  initialWebsite: string;
}) {
  const enableTelemetry = useEnableTelemetry();
  const optIn = useRankingOptIn();
  const [name, setName] = useState(initialName);
  const [website, setWebsite] = useState(initialWebsite);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const identity = orgIdentityStatus({ SWARM_ORG_NAME: name, SWARM_ORG_WEBSITE: website });
    if (identity.missing.length > 0) {
      setError(
        identity.missing.includes("SWARM_ORG_NAME")
          ? "Enter your organization name."
          : "Enter a public website, such as example.com.",
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // The ranking's own fields live in Settings, so the profile write reports that surface.
      await save({ name, website }, "settings");
      if (!telemetryOn) await enableTelemetry.mutateAsync("banner");
      await optIn.mutateAsync({
        category: listing?.category ?? "engineering",
        subcategory: listing?.subcategory ?? null,
        description: listing?.description ?? null,
      });
      toast.success("You're in. You show on agent-swarm.dev/ranking at the next hourly refresh.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join the ranking.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add me to ranking</DialogTitle>
          <DialogDescription>
            Rank this swarm by tokens used on agent-swarm.dev/ranking. Your token totals become
            public{telemetryOn ? "" : ", and telemetry turns on to count them"}.
          </DialogDescription>
        </DialogHeader>
        <form id="add-to-ranking-form" className="space-y-3 py-1" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="ranking-org-name">Organization name</Label>
            <Input
              id="ranking-org-name"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme"
              autoComplete="organization"
              required
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ranking-org-website">Website</Label>
            <Input
              id="ranking-org-website"
              value={website}
              disabled={busy}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="acme.com"
              autoComplete="url"
              required
            />
          </div>
          {error ? (
            <AlertCallout tone="error" icon={AlertCircle}>
              {error}
            </AlertCallout>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-to-ranking-form" status={busy ? "loading" : "idle"}>
            <Trophy />
            Add me to ranking
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
