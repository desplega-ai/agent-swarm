import type { OnboardingIntegrationMethod, OnboardingSignals } from "@/api/types";
import { INTEGRATIONS } from "@/lib/integrations-catalog";

/**
 * The five integrations step 5 offers, plus the field specs each pane edits.
 * Labels, placeholders, and secret flags come from the Settings catalog
 * (`lib/integrations-catalog.ts`). Hints are written here, because the catalog
 * help text is longer than this step needs.
 */

export type SetupIntegrationId = keyof OnboardingSignals["integrations"];

export interface SetupFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  secret: boolean;
  multiline?: boolean;
  required?: boolean;
  hint?: string;
  /** Pre-filled when the key has no stored row. Not saved while unchanged. */
  defaultValue?: string;
}

export interface SetupIntegration {
  id: SetupIntegrationId;
  name: string;
  purpose: string;
  logo: string;
  docsUrl: string;
  method: OnboardingIntegrationMethod;
  /** Keys whose presence means "saved but not connected yet" (the SAVED chip). */
  chipKeys: string[];
}

function docsUrl(id: SetupIntegrationId): string {
  return (
    INTEGRATIONS.find((def) => def.id === id)?.docsUrl ??
    `https://docs.agent-swarm.dev/docs/integrations/${id}`
  );
}

export const SETUP_INTEGRATIONS: SetupIntegration[] = [
  {
    id: "slack",
    name: "Slack",
    purpose: "Run the swarm from a channel. Tasks, replies, and approvals.",
    logo: "/integration-logos/slack.svg",
    docsUrl: docsUrl("slack"),
    method: "slack",
    chipKeys: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
  },
  {
    id: "github",
    name: "GitHub",
    purpose: "Issues, pull requests, and reviews.",
    logo: "/integration-logos/github.svg",
    docsUrl: docsUrl("github"),
    method: "github",
    chipKeys: ["GITHUB_TOKEN", "GITHUB_APP_ID"],
  },
  {
    id: "gitlab",
    name: "GitLab",
    purpose: "Issues and merge requests.",
    logo: "/integration-logos/gitlab.svg",
    docsUrl: docsUrl("gitlab"),
    method: "gitlab",
    chipKeys: ["GITLAB_TOKEN"],
  },
  {
    id: "linear",
    name: "Linear",
    purpose: "Issues and status sync over OAuth.",
    logo: "/integration-logos/linear.svg",
    docsUrl: docsUrl("linear"),
    method: "linear_oauth",
    chipKeys: ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"],
  },
  {
    id: "jira",
    name: "Jira",
    purpose: "Issues and status sync over OAuth.",
    logo: "/integration-logos/jira.svg",
    docsUrl: docsUrl("jira"),
    method: "jira_oauth",
    chipKeys: ["JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"],
  },
];

export function findSetupIntegration(id: string | null): SetupIntegration | undefined {
  return SETUP_INTEGRATIONS.find((item) => item.id === id);
}

/** Build a spec from the catalog entry, with local overrides. */
function spec(
  integrationId: SetupIntegrationId,
  key: string,
  overrides: Partial<SetupFieldSpec> = {},
): SetupFieldSpec {
  const field = INTEGRATIONS.find((def) => def.id === integrationId)?.fields.find(
    (f) => f.key === key,
  );
  const secret = field?.isSecret === true;
  return {
    key,
    label: field?.label ?? key,
    placeholder: field?.placeholder ?? (secret ? "••••" : undefined),
    secret,
    multiline: field?.type === "textarea",
    ...overrides,
  };
}

export const SLACK_MODE_FIELD: SetupFieldSpec = spec("slack", "SLACK_MODE", {
  defaultValue: "socket",
});

export const SLACK_TOKEN_FIELDS: SetupFieldSpec[] = [
  spec("slack", "SLACK_BOT_TOKEN", { required: true }),
  spec("slack", "SLACK_APP_TOKEN", { label: "App-level token", hint: "Socket mode only." }),
];

export const SLACK_SIGNING_FIELDS: SetupFieldSpec[] = [
  spec("slack", "SLACK_SIGNING_SECRET", {
    hint: "Verifies request signatures when Slack posts events over HTTP.",
  }),
];

export const GITHUB_FIELDS: SetupFieldSpec[] = [
  spec("github", "GITHUB_TOKEN", { required: true }),
  spec("github", "GITHUB_WEBHOOK_SECRET"),
  spec("github", "GITHUB_EMAIL"),
  spec("github", "GITHUB_NAME"),
];

export const GITHUB_APP_FIELDS: SetupFieldSpec[] = [
  spec("github", "GITHUB_APP_ID"),
  spec("github", "GITHUB_APP_PRIVATE_KEY"),
];

export const GITLAB_FIELDS: SetupFieldSpec[] = [
  spec("gitlab", "GITLAB_TOKEN", { required: true }),
  spec("gitlab", "GITLAB_WEBHOOK_SECRET"),
  spec("gitlab", "GITLAB_EMAIL"),
  spec("gitlab", "GITLAB_NAME"),
  spec("gitlab", "GITLAB_URL", {
    defaultValue: "https://gitlab.com",
    hint: "Point this at your own host for self-managed GitLab.",
  }),
];

export const LINEAR_FIELDS: SetupFieldSpec[] = [
  spec("linear", "LINEAR_CLIENT_ID", { required: true }),
  spec("linear", "LINEAR_CLIENT_SECRET", { required: true }),
  spec("linear", "LINEAR_SIGNING_SECRET", { hint: "Verifies Linear webhook payloads." }),
];

export const JIRA_FIELDS: SetupFieldSpec[] = [
  spec("jira", "JIRA_CLIENT_ID", { required: true }),
  spec("jira", "JIRA_CLIENT_SECRET", { required: true }),
  spec("jira", "JIRA_WEBHOOK_TOKEN", { hint: "Shared token on the Jira webhook URL." }),
];

/** Every key the step reads presence for, in one `env-presence` query. */
export const ALL_SETUP_KEYS: string[] = [
  SLACK_MODE_FIELD,
  ...SLACK_TOKEN_FIELDS,
  ...SLACK_SIGNING_FIELDS,
  ...GITHUB_FIELDS,
  ...GITHUB_APP_FIELDS,
  ...GITLAB_FIELDS,
  ...LINEAR_FIELDS,
  ...JIRA_FIELDS,
].map((f) => f.key);

/** First connected integration, in the order the API uses to infer the method. */
export function connectedMethod(
  integrations: OnboardingSignals["integrations"],
): OnboardingIntegrationMethod | null {
  return SETUP_INTEGRATIONS.find((item) => integrations[item.id])?.method ?? null;
}
