import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { GITHUB_APP_FIELDS, GITHUB_FIELDS, GITLAB_FIELDS } from "./catalog";
import { ConnectedGate } from "./pane-parts";
import { FieldGrid } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

export function GitHubPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      summary="Connected. Agents can clone, push, and open pull requests."
    >
      <FieldGrid specs={GITHUB_FIELDS} form={form} />
      <CollapsibleSection title="GitHub App (optional)">
        <div className="pt-2">
          <FieldGrid specs={GITHUB_APP_FIELDS} form={form} />
        </div>
      </CollapsibleSection>
    </ConnectedGate>
  );
}

export function GitLabPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      summary="Connected. Agents can clone, push, and open merge requests."
    >
      <FieldGrid specs={GITLAB_FIELDS} form={form} />
    </ConnectedGate>
  );
}
