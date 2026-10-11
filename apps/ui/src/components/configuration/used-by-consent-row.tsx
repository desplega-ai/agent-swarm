import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSetUsedByConsent } from "@/api/hooks/use-org-profile";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isTruthyConfigValue } from "@/hooks/use-swarm-config";

/**
 * Settings → Branding: the revocable "used by" consent. It goes through
 * `POST /api/used-by`, which tells the telemetry proxy; a person at Desplega
 * approves each logo by hand before anything public shows it.
 */
export function UsedByConsentRow() {
  const { data: configs } = useConfigs({ scope: "global" });
  const setConsent = useSetUsedByConsent();
  const value = (key: string) => configs?.find((entry) => entry.key === key)?.value.trim() || "";
  const granted = isTruthyConfigValue(value("SWARM_USED_BY_CONSENT"));
  const ready = Boolean(value("SWARM_ORG_NAME") && value("SWARM_ORG_WEBSITE"));

  function toggle(next: boolean) {
    setConsent.mutate(next, {
      onSuccess: () =>
        toast.success(
          next
            ? "Thanks. We'll review your logo before it appears on agent-swarm.dev."
            : "Removed. Your logo will come off agent-swarm.dev.",
        ),
      onError: (error) => toast.error(error.message),
    });
  }

  return (
    <div
      id="setting-SWARM_USED_BY_CONSENT"
      className="flex scroll-mt-6 flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
    >
      <div className="min-w-0 space-y-1 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="config-SWARM_USED_BY_CONSENT" className="text-sm font-medium">
            Show our logo on agent-swarm.dev
          </Label>
          <code className="font-mono text-[10px] text-muted-foreground select-text">
            SWARM_USED_BY_CONSENT
          </code>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          List your organization as a company that uses Agent Swarm. Sends your organization name
          and website to Desplega when you change it, even with telemetry off, because you asked for
          it. Turn it off at any time to remove the logo.
          {ready ? null : " Set the organization name and company website first."}
        </p>
      </div>
      <Switch
        id="config-SWARM_USED_BY_CONSENT"
        checked={granted}
        disabled={setConsent.isPending || (!ready && !granted)}
        onCheckedChange={toggle}
        aria-label="Show our logo on agent-swarm.dev"
      />
    </div>
  );
}
