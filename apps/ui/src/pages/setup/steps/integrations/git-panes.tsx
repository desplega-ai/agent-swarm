import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { BITBUCKET_FIELDS, GITHUB_APP_FIELDS, GITHUB_FIELDS, GITLAB_FIELDS } from "./catalog";
import { ConnectedGate, ExternalTextLink, StepLine } from "./pane-parts";
import { FieldGrid } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

export function GitHubPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      summary="Connected. Agents can clone, push, and open pull requests."
    >
      <StepLine n={1}>
        Create a token at{" "}
        <ExternalTextLink href="https://github.com/settings/tokens">
          github.com/settings/tokens
        </ExternalTextLink>{" "}
        with the <Scope>repo</Scope> and <Scope>workflow</Scope> scopes.
      </StepLine>
      <div className="space-y-3">
        <StepLine n={2}>Paste the token. The other fields are optional.</StepLine>
        <FieldGrid specs={GITHUB_FIELDS} form={form} />
      </div>
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
      <StepLine n={1}>
        Create a token at{" "}
        <ExternalTextLink href="https://gitlab.com/-/user_settings/personal_access_tokens">
          gitlab.com
        </ExternalTextLink>{" "}
        (or your own host) with the <Scope>api</Scope> and <Scope>write_repository</Scope> scopes.
      </StepLine>
      <div className="space-y-3">
        <StepLine n={2}>Paste the token. The other fields are optional.</StepLine>
        <FieldGrid specs={GITLAB_FIELDS} form={form} />
      </div>
    </ConnectedGate>
  );
}

export function BitbucketPane({ configs, presence, connected }: PaneProps) {
  const form = useConfigForm(configs, presence);
  return (
    <ConnectedGate
      connected={connected}
      summary="Connected. Agents can clone, push, and open pull requests."
    >
      <StepLine n={1}>
        Create an{" "}
        <ExternalTextLink href="https://id.atlassian.com/manage-profile/security/api-tokens">
          Atlassian API token
        </ExternalTextLink>{" "}
        for the bot account, or a workspace access token.
      </StepLine>
      <div className="space-y-3">
        <StepLine n={2}>
          Paste the token and a webhook secret. Put the same secret on the Bitbucket webhook.
        </StepLine>
        <FieldGrid specs={BITBUCKET_FIELDS} form={form} />
      </div>
    </ConnectedGate>
  );
}

/** A token scope name, in mono like the docs. */
function Scope({ children }: { children: string }) {
  return <code className="font-mono text-xs">{children}</code>;
}
