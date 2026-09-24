import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { GITHUB_APP_FIELDS, GITHUB_FIELDS, GITLAB_FIELDS } from "./catalog";
import { ConnectedGate, SaveRow } from "./pane-parts";
import { FieldGrid } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

const COMMIT_HINT = "The email and name sign every commit the agents push.";

export function GitHubPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm([...GITHUB_FIELDS, ...GITHUB_APP_FIELDS], configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      title="GitHub is connected."
      detail="Agents can clone, push, and open pull requests."
    >
      <FieldGrid specs={GITHUB_FIELDS} form={form} />
      <p className="text-xs text-muted-foreground">{COMMIT_HINT}</p>
      <CollapsibleSection title="GitHub App (optional)">
        <div className="space-y-2 pt-2">
          <FieldGrid specs={GITHUB_APP_FIELDS} form={form} />
          <p className="text-xs text-muted-foreground">
            Use an App instead of a token when you need per-repo installs and higher rate limits.
          </p>
        </div>
      </CollapsibleSection>
      <SaveRow form={form} label="Save GitHub" missingHint="Add a token first." />
    </ConnectedGate>
  );
}

export function GitLabPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(GITLAB_FIELDS, configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      title="GitLab is connected."
      detail="Agents can clone, push, and open merge requests."
    >
      <FieldGrid specs={GITLAB_FIELDS} form={form} />
      <p className="text-xs text-muted-foreground">{COMMIT_HINT}</p>
      <SaveRow form={form} label="Save GitLab" missingHint="Add a token first." />
    </ConnectedGate>
  );
}
