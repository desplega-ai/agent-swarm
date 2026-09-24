import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { api } from "@/api/client";
import { useStatus } from "@/api/hooks/use-status";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/ui/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { swarmDisplayName } from "../../components/swarm-name";
import { SLACK_MODE_FIELD, SLACK_SIGNING_FIELDS, SLACK_TOKEN_FIELDS } from "./catalog";
import { ConnectedGate, ExternalTextLink, SaveRow } from "./pane-parts";
import { FieldGrid, fieldLabel } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

const SLACK_FIELDS = [SLACK_MODE_FIELD, ...SLACK_TOKEN_FIELDS, ...SLACK_SIGNING_FIELDS];

export function SlackPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(SLACK_FIELDS, configs, presence);
  const mode = form.value("SLACK_MODE") === "http" ? "http" : "socket";

  return (
    <ConnectedGate
      connected={connected}
      title="Slack is connected."
      detail="Mention the bot in any channel it joins to send a task."
    >
      <SlackManifest />
      <SettingsRow
        label={fieldLabel(SLACK_MODE_FIELD)}
        helper="Socket mode needs no public URL. HTTP needs one and signs every request."
      >
        <Tabs value={mode} onValueChange={(v) => form.setValue("SLACK_MODE", v)}>
          <TabsList>
            <TabsTrigger value="socket">Socket mode</TabsTrigger>
            <TabsTrigger value="http">HTTP</TabsTrigger>
          </TabsList>
        </Tabs>
      </SettingsRow>
      <FieldGrid specs={SLACK_TOKEN_FIELDS} form={form} />
      {/* Keyed on the mode so switching to HTTP opens the section. */}
      <CollapsibleSection key={mode} title="HTTP mode only" defaultOpen={mode === "http"}>
        <div className="pt-2">
          <FieldGrid specs={SLACK_SIGNING_FIELDS} form={form} />
        </div>
      </CollapsibleSection>
      <SaveRow form={form} label="Save Slack" missingHint="Add the bot token first." />
    </ConnectedGate>
  );
}

/** App manifest pre-filled with the swarm name. Hidden when the API has no manifest route. */
function SlackManifest() {
  const statusQ = useStatus();
  // Unset `SWARM_ORG_NAME` reads as "Swarm" on /status. Use the step 2 default instead.
  const name = swarmDisplayName(statusQ.data?.identity?.name);
  const manifestQ = useQuery({
    queryKey: ["slack-manifest", name],
    queryFn: () => api.fetchSlackManifest(name),
    enabled: !statusQ.isPending,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
  });
  const { copied, copy } = useCopyToClipboard();
  const manifest = manifestQ.data ? JSON.stringify(manifestQ.data, null, 2) : null;
  const loading = statusQ.isPending || manifestQ.isPending;

  const link = (
    <ExternalTextLink href="https://api.slack.com/apps?new_app=1">
      api.slack.com/apps
    </ExternalTextLink>
  );

  if (!manifest && !loading) {
    return <p className="text-xs text-muted-foreground">Create the app at {link}.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          App manifest
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!manifest}
          onClick={() => manifest && void copy(manifest)}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy manifest"}
        </Button>
      </div>
      {manifest ? (
        <pre className="max-h-56 overflow-auto rounded-md border border-border-subtle bg-surface p-3 font-mono text-xs leading-relaxed">
          {manifest}
        </pre>
      ) : (
        <Skeleton className="h-40 w-full" />
      )}
      <p className="text-xs text-muted-foreground">
        Create the app at {link} and pick "From a manifest", then paste this in.
      </p>
    </div>
  );
}
